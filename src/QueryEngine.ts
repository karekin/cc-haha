import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import last from 'lodash-es/last.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/bootstrap/state.js'
import type {
  PermissionMode,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKStatus,
  SDKUserMessageReplay,
} from 'src/entrypoints/agentSdkTypes.js'
import { accumulateUsage, updateUsage } from 'src/services/api/claude.js'
import type { NonNullableUsage } from 'src/services/api/logging.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import stripAnsi from 'strip-ansi'
import type { Command } from './commands.js'
import { getSlashCommandToolSkills } from './commands.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from './constants/xml.js'
import {
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
} from './cost-tracker.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'
import { query } from './query.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import type { AppState } from './state/AppState.js'
import { type Tools, type ToolUseContext, toolMatchesName } from './Tool.js'
import type { AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Message } from './types/message.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { createAbortController } from './utils/abortController.js'
import type { AttributionState } from './utils/commitAttribution.js'
import { getGlobalConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { getFastModeState } from './utils/fastMode.js'
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from './utils/fileHistory.js'
import {
  cloneFileStateCache,
  type FileStateCache,
} from './utils/fileStateCache.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { getInMemoryErrors } from './utils/log.js'
import { countToolCalls, SYNTHETIC_MESSAGES } from './utils/messages.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './utils/model/model.js'
import { loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import {
  type ProcessUserInputContext,
  processUserInput,
} from './utils/processUserInput/processUserInput.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { setCwd } from './utils/Shell.js'
import {
  flushSessionStorage,
  recordTranscript,
} from './utils/sessionStorage.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { resolveThemeSetting } from './utils/systemTheme.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utils/thinking.js'

// 懒加载：MessageSelector.tsx 会拉入 React/Ink，仅在 query 期做消息筛选时才需要。
/* eslint-disable @typescript-eslint/no-require-imports */
const messageSelector =
  (): typeof import('src/components/MessageSelector.js') =>
    require('src/components/MessageSelector.js')

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import {
  buildSystemInitMessage,
  sdkCompatToolName,
} from './utils/messages/systemInit.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from './utils/permissions/filesystem.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from './utils/queryHelpers.js'

// 编译期死代码消除：仅在 coordinator 模式启用时才引入对应模块。
/* eslint-disable @typescript-eslint/no-require-imports */
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
/* eslint-enable @typescript-eslint/no-require-imports */

// 编译期死代码消除：仅在启用 snip compaction 时才引入对应模块。
/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const snipProjection = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipProjection.js') as typeof import('./services/compact/snipProjection.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * `QueryEngine.ts` 负责“会话级别”的查询生命周期管理。
 *
 * 它与 `query.ts` 的分工关系可以这样理解：
 * - `query.ts`：单轮 Agent Loop，关注这一轮怎么跑完；
 * - `QueryEngine.ts`：整段会话容器，关注跨轮次状态怎么延续。
 *
 * 因此，这里持有和维护的往往是“跨轮次保留”的东西，例如：
 * - `mutableMessages`（当前会话的消息历史）
 * - `readFileState`（已读文件状态缓存）
 * - `totalUsage`（累计 usage）
 * - `permissionDenials`（权限拒绝记录）
 * - `abortController`（本会话的中断控制器）
 */

export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  /** 处理 MCP 工具抛出 -32042 时触发的 URL 型 elicitation 请求。 */
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean
  setSDKStatus?: (status: SDKStatus) => void
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
  /**
   * Snip 边界回放处理器。
   *
   * 它会拿到每条 yield 出去的 system message 以及当前的 mutableMessages，
   * 并判断这条消息是否是 snip 边界：
   * - 如果不是，返回 undefined；
   * - 如果是，则返回一次“回放后的 snip 结果”。
   *
   * 之所以通过注入方式传进来，是为了把 HISTORY_SNIP 相关的 feature-gated 字符串
   * 留在受保护模块内部，避免 QueryEngine 本身携带这些构建期开关敏感内容。
   *
   * 这个能力主要服务于 SDK/headless 场景：REPL 需要保留完整历史用于滚动查看，
   * 而 QueryEngine 在长时间无 UI 会话中更关注控制内存占用。
   */
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}

/**
 * QueryEngine 负责一整段会话的 query 生命周期与会话状态。
 *
 * 它把原本分散在 ask() 周围的核心逻辑提炼成一个独立类，
 * 这样既可以服务 headless / SDK 路径，未来也可以复用于 REPL。
 *
 * 使用方式上可以理解为：
 * - 一个 QueryEngine 对应一段 conversation；
 * - 每次 `submitMessage()` 代表在同一段会话里推进新的一轮；
 * - messages、文件缓存、usage 等状态都会在轮次之间持续保留。
 */
export class QueryEngine {
  /**
   * 这组字段分两类：
   * - `config`：整个会话的静态配置；
   * - 其余字段：随着每轮 `submitMessage()` 推进而更新的会话级动态状态。
   */
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private hasHandledOrphanedPermission = false
  private readFileState: FileStateCache
  // 按“单轮 turn”维度记录技能发现状态（会影响 `tengu_skill_tool_invocation` 里的 `was_discovered` 字段）。
  // 它必须跨过 `submitMessage()` 内部两次 `processUserInputContext` 重建，
  // 但又需要在每轮开始时清空，避免在长时间 SDK 会话中无限增长。
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }

  /**
   * 提交一条新的用户消息，推进当前会话的一轮交互。
   *
   * 它做的事情可以概括为：
   * 1. 从 QueryEngineConfig 中取出本轮需要的上下文；
   * 2. 把 `prompt` 经由 `processUserInput()` 管线转成内部消息；
   * 3. 调用底层 `query()` 执行单轮 Agent Loop；
   * 4. 把内部消息流转换成 `SDKMessage`；
   * 5. 在结束后更新会话级状态（messages、usage、readFileState 等）。
   */
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const {
      cwd,
      commands,
      tools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      orphanedPermission,
    } = this.config

    this.discoveredSkillNames.clear()
    setCwd(cwd)
    const persistSession = !isSessionPersistenceDisabled()
    const startTime = Date.now()

    /**
     * 用包装后的 `canUseTool` 收集权限拒绝事件。
     *
     * 这里的重点不是改变权限决策，而是把“这轮里有哪些工具调用被拒绝了”
     * 聚合到 QueryEngine 的会话级状态中，方便 SDK/上层在 query 结束后统一读取。
     */
    // Wrap canUseTool to track permission denials
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // 记录拒绝事件，供 SDK 侧统一汇报。
      if (result.behavior !== 'allow') {
        this.permissionDenials.push({
          tool_name: sdkCompatToolName(tool.name),
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    const initialAppState = getAppState()
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault() !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' }

    headlessProfilerCheckpoint('before_getSystemPrompt')
    // 先收窄一次类型，方便后续条件分支里 TypeScript 正确跟踪 customPrompt 的类型。
    const customPrompt =
      typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined
    const {
      defaultSystemPrompt,
      userContext: baseUserContext,
      systemContext,
    } = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt: customPrompt,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(
        mcpClients,
        isScratchpadEnabled() ? getScratchpadDir() : undefined,
      ),
    }

    // 如果 SDK 调用方提供了自定义 system prompt，且显式设置了
    // CLAUDE_COWORK_MEMORY_PATH_OVERRIDE，则额外注入 memory mechanics prompt。
    // 这表示调用方已经接好了 memory 目录，并希望 Claude 知道：
    // - 应该调用哪些 Write/Edit 工具；
    // - MEMORY.md 的命名与位置；
    // - memory 的加载与写回语义。
    // 调用方仍然可以通过 appendSystemPrompt 继续叠加自己的策略说明。
    const memoryMechanicsPrompt =
      customPrompt !== undefined && hasAutoMemPathOverride()
        ? await loadMemoryPrompt()
        : null

    const systemPrompt = asSystemPrompt([
      ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])

    /**
     * 如果本轮声明了结构化输出 schema，并且工具池中存在 `synthetic output tool`，
     * 就在这里提前注册结构化输出约束。
     *
     * 这是“模型层 schema 约束”和“客户端侧处理策略”之间的桥梁。
     */
    // 注册结构化输出约束钩子。
    const hasStructuredOutputTool = tools.some(t =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    /**
     * 为 `processUserInput()` 构造输入处理上下文。
     *
     * 这一步会把外部传入的 `prompt` 进一步转成内部消息流前的“标准环境”，
     * 用于统一处理：
     * - `slash command`
     * - 附件 / memory 注入
     * - 工具、命令、theme、MCP 客户端等运行期能力
     * - `mutable message store` 的更新方式
     */
    let processUserInputContext: ProcessUserInputContext = {
      messages: this.mutableMessages,
      // 某些 slash command（例如 /force-snip）会直接改写消息数组，
      // 因此这里提供 `setMessages(fn)` 作为回写入口。
      // 在交互模式里它通常写回 AppState；而在 print/SDK 模式里，这里直接写回 mutableMessages，
      // 以保证后续 query loop 看到的是更新后的消息。
      // 下面第二次重建 processUserInputContext 后，这个能力会退化成 no-op，
      // 因为后续流程不再需要继续从 slash command 改写消息。
      setMessages: fn => {
        this.mutableMessages = fn(this.mutableMessages)
      },
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false, // we use stdout, so don't want to clobber it
        tools,
        verbose,
        mainLoopModel: initialMainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        theme: resolveThemeSetting(getGlobalConfig().theme),
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: (
        updater: (prev: FileHistoryState) => FileHistoryState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.fileHistory)
          if (updated === prev.fileHistory) return prev
          return { ...prev, fileHistory: updated }
        })
      },
      updateAttributionState: (
        updater: (prev: AttributionState) => AttributionState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.attribution)
          if (updated === prev.attribution) return prev
          return { ...prev, attribution: updated }
        })
      },
      setSDKStatus,
    }

    /**
     * 先处理 orphaned permission。
     *
     * 这属于会话层的“遗留状态恢复”：
     * - 某些权限请求可能来自上一轮/上一会话残留；
     * - QueryEngine 只在整个生命周期里处理一次，避免重复注入恢复消息。
     */
    // Handle orphaned permission (only once per engine lifetime)
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      this.hasHandledOrphanedPermission = true
      for await (const message of handleOrphanedPermission(
        orphanedPermission,
        tools,
        this.mutableMessages,
        processUserInputContext,
      )) {
        yield message
      }
    }

    /**
     * 正式进入 `processUserInput()` 管线。
     *
     * 这是“用户原始输入 -> 系统内部消息”的统一入口，
     * 会在这里处理 slash command、附件、memory 注入、allowedTools 变化等副作用。
     */
    const {
      messages: messagesFromUserInput,
      shouldQuery,
      allowedTools,
      model: modelFromUserInput,
      resultText,
    } = await processUserInput({
      input: prompt,
      mode: 'prompt',
      setToolJSX: () => {},
      context: {
        ...processUserInputContext,
        messages: this.mutableMessages,
      },
      messages: this.mutableMessages,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
      querySource: 'sdk',
    })

    // 把用户输入及其派生出来的新消息（附件、memory 注入等）压入会话消息历史。
    this.mutableMessages.push(...messagesFromUserInput)

    // 根据 `slash command` 的处理结果刷新当前轮要使用的 `messages` 视图。
    const messages = [...this.mutableMessages]

    // 在真正进入 `query loop` 之前，先把用户消息落到 `transcript`。
    // 原因是：下面的 for-await 只有在 query 已经产出 assistant/user/compact_boundary 时
    // 才会继续 recordTranscript；如果进程在 API 响应前就被杀掉（例如 cowork 场景里用户刚发完就点 Stop），
    // transcript 里就可能只剩下一些队列操作记录，导致 `--resume` 找不到可恢复会话。
    // 因此这里先写一次，确保“至少从用户消息被接受的那一刻起”就具备恢复能力。
    //
    // 对 bare / SIMPLE 模式则采用 fire-and-forget：脚本化调用通常不会在中途 kill 后再 resume，
    // 而同步等待落盘会显著增加关键路径耗时。
    if (persistSession && messagesFromUserInput.length > 0) {
      const transcriptPromise = recordTranscript(messages)
      if (isBareMode()) {
        void transcriptPromise
      } else {
        await transcriptPromise
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }
    }

    // 筛选出那些在 `transcript` 落盘后需要向 SDK 侧确认回放的消息。
    const replayableMessages = messagesFromUserInput.filter(
      msg =>
        (msg.type === 'user' &&
          !msg.isMeta && // 跳过纯系统合成提示消息
          !msg.toolUseResult && // 跳过 tool_result（它们会在 query 流里单独确认）
          messageSelector().selectableUserMessagesFilter(msg)) || // 跳过并非用户亲自输入的消息（如任务通知等）
        (msg.type === 'system' && msg.subtype === 'compact_boundary'), // compact 边界消息总是需要确认
    )
    const messagesToAck = replayUserMessages ? replayableMessages : []

    // 根据用户输入处理结果，按需更新 `ToolPermissionContext`（例如 `allowedTools` 变化）。
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: allowedTools,
        },
      },
    }))

    const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

    // 在 `prompt` 处理完成后重建一份 `context`，以接住 `slash command` 带来的消息/模型变更。
    processUserInputContext = {
      messages,
      setMessages: () => {},
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false,
        tools,
        verbose,
        mainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        theme: resolveThemeSetting(getGlobalConfig().theme),
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: processUserInputContext.updateFileHistoryState,
      updateAttributionState: processUserInputContext.updateAttributionState,
      setSDKStatus,
    }

    headlessProfilerCheckpoint('before_skills_plugins')
    // 这里只读取本地缓存，不为了插件刷新去阻塞网络。
    // 对 `headless / SDK / CCR` 场景来说，首轮启动更重要的是快速进入可用状态；
    // 若调用方确实需要最新插件内容，可以后续显式走 `/reload-plugins`。
    const [skills, { enabled: enabledPlugins }] = await Promise.all([
      getSlashCommandToolSkills(getCwd()),
      loadAllPluginsCacheOnly(),
    ])
    headlessProfilerCheckpoint('after_skills_plugins')

    yield buildSystemInitMessage({
      tools,
      mcpClients,
      model: mainLoopModel,
      permissionMode: initialAppState.toolPermissionContext
        .mode as PermissionMode, // TODO: avoid the cast
      commands,
      agents,
      skills,
      plugins: enabledPlugins,
      fastMode: initialAppState.fastMode,
    })

    // 记录 system init message 被真正 yield 出去的时刻，用于 headless 延迟追踪。
    headlessProfilerCheckpoint('system_message_yielded')

    if (!shouldQuery) {
      // 如果本轮在 processUserInput 阶段就已经被本地 slash command 处理完，
      // 这里直接把本地命令结果返回给 SDK。
      // 之所以使用 messagesFromUserInput 而不是 replayableMessages，
      // 是因为后者会把 local-command-stdout 这类标签过滤掉。
      for (const msg of messagesFromUserInput) {
        if (
          msg.type === 'user' &&
          typeof msg.message.content === 'string' &&
          (msg.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.message.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
            msg.isCompactSummary)
        ) {
          yield {
            type: 'user',
            message: {
              ...msg.message,
              content: stripAnsi(msg.message.content),
            },
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
            isReplay: !msg.isCompactSummary,
            isSynthetic: msg.isMeta || msg.isVisibleInTranscriptOnly,
          } as SDKUserMessageReplay
        }

        // 本地命令输出在这里被伪装成 assistant 消息，
        // 这样 RC/mobile/session-ingress 侧可以按 assistant 文本样式渲染，
        // 而不是把它错误地当成用户气泡。
        if (
          msg.type === 'system' &&
          msg.subtype === 'local_command' &&
          typeof msg.content === 'string' &&
          (msg.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          yield localCommandOutputToSDKAssistantMessage(msg.content, msg.uuid)
        }

        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          yield {
            type: 'system',
            subtype: 'compact_boundary' as const,
            session_id: getSessionId(),
            uuid: msg.uuid,
            compact_metadata: toSDKCompactMetadata(msg.compactMetadata),
          } as SDKCompactBoundaryMessage
        }
      }

      if (persistSession) {
        await recordTranscript(messages)
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }

      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        num_turns: messages.length - 1,
        result: resultText ?? '',
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
      }
      return
    }

    if (fileHistoryEnabled() && persistSession) {
      messagesFromUserInput
        .filter(messageSelector().selectableUserMessagesFilter)
        .forEach(message => {
          void fileHistoryMakeSnapshot(
            (updater: (prev: FileHistoryState) => FileHistoryState) => {
              setAppState(prev => ({
                ...prev,
                fileHistory: updater(prev.fileHistory),
              }))
            },
            message.uuid,
          )
        })
    }

    // 记录当前 assistant message 的 usage；每次 message_start 都重新清零。
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    let turnCount = 1
    let hasAcknowledgedInitialMessages = false
    // 记录 StructuredOutput 工具返回的结构化输出结果。
    let structuredOutputFromTool: unknown
    // 记录本轮 assistant 最后的 stop_reason。
    let lastStopReason: string | null = null
    // 用“引用水位线”来限定 error_during_execution 时应收集哪些错误。
    // 如果只按数组长度索引，内存日志环形缓冲在 shift() 后会导致索引漂移；
    // 用对象引用做水位线，即使缓冲区滚动，也能较稳地定位“本轮之前的最后一条错误”。
    const errorLogWatermark = getInMemoryErrors().at(-1)
    // 记录本轮 query 开始前的 structured output 调用次数，用于后面做增量重试限制。
    const initialStructuredOutputCalls = jsonSchema
      ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
      : 0

    for await (const message of query({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext: processUserInputContext,
      fallbackModel,
      querySource: 'sdk',
      maxTurns,
      taskBudget,
    })) {
      // `assistant / user / compact_boundary` 这三类消息都会并入正式消息历史。
      if (
        message.type === 'assistant' ||
        message.type === 'user' ||
        (message.type === 'system' && message.subtype === 'compact_boundary')
      ) {
        // 在写 compact boundary 之前，先把内存里尚未落盘、且位于 preservedSegment 尾部之前的消息刷到 transcript。
        // 否则一旦 SDK 子进程在两轮之间重启，tailUuid 可能指向一条从未写入磁盘的消息，
        // 导致 preserved segment 的重链失败，最终 resume 时会把压缩前的大段历史全量读回来。
        if (
          persistSession &&
          message.type === 'system' &&
          message.subtype === 'compact_boundary'
        ) {
          const tailUuid = message.compactMetadata?.preservedSegment?.tailUuid
          if (tailUuid) {
            const tailIdx = this.mutableMessages.findLastIndex(
              m => m.uuid === tailUuid,
            )
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
            }
          }
        }
        messages.push(message)
        if (persistSession) {
          // assistant 消息采用 fire-and-forget 落盘。
          // 因为 claude.ts 会先按 content block 逐条产出 assistant 消息，随后再通过 message_delta
          // 回写 usage/stop_reason；如果这里同步 await，就会阻塞 ask() 继续消费流，
          // 反而让 message_delta 迟迟进不来。
          // 写队列本身是有序的，因此这里异步落盘仍然是安全的。
          if (message.type === 'assistant') {
            void recordTranscript(messages)
          } else {
            await recordTranscript(messages)
          }
        }

        // 在首次 transcript 记录完成之后，再向 SDK 确认这些初始用户消息已被接收。
        if (!hasAcknowledgedInitialMessages && messagesToAck.length > 0) {
          hasAcknowledgedInitialMessages = true
          for (const msgToAck of messagesToAck) {
            if (msgToAck.type === 'user') {
              yield {
                type: 'user',
                message: msgToAck.message,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: msgToAck.uuid,
                timestamp: msgToAck.timestamp,
                isReplay: true,
              } as SDKUserMessageReplay
            }
          }
        }
      }

      if (message.type === 'user') {
        turnCount++
      }

      switch (message.type) {
        case 'tombstone':
          // Tombstone 只是删除/撤销控制信号，不作为常规消息对外透传。
          break
        case 'assistant':
          // 如果 assistant 消息自身已经带了 stop_reason（常见于 synthetic message），就在这里先记下来。
          // 对流式正常响应来说，真正 stop_reason 通常要等后续 message_delta 才会补齐。
          if (message.message.stop_reason != null) {
            lastStopReason = message.message.stop_reason
          }
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
        case 'progress':
          this.mutableMessages.push(message)
          // `progress` 也要内联记录到 `transcript`。
          // 否则下一次 ask() 做去重时，会把 progress 和后续 tool_result 的父子边界认错，
          // 最终让消息链在 resume 时断裂。
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }
          yield* normalizeMessage(message)
          break
        case 'user':
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
        case 'stream_event':
          if (message.event.type === 'message_start') {
            // 新的一条 message 开始时，重置当前 message 的 usage 累计。
            currentMessageUsage = EMPTY_USAGE
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              message.event.message.usage,
            )
          }
          if (message.event.type === 'message_delta') {
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              message.event.usage,
            )
            // 从 message_delta 里补抓真正的 stop_reason。
            // assistant 消息在 content_block_stop 时通常还拿不到最终 stop_reason，
            // 如果不在这里更新，最后结果里的 stop_reason 就会一直是 null。
            if (message.event.delta.stop_reason != null) {
              lastStopReason = message.event.delta.stop_reason
            }
          }
          if (message.event.type === 'message_stop') {
            // 当前 message 结束时，把本条 usage 累加到整个会话总 usage。
            this.totalUsage = accumulateUsage(
              this.totalUsage,
              currentMessageUsage,
            )
          }

          if (includePartialMessages) {
            yield {
              type: 'stream_event' as const,
              event: message.event,
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: randomUUID(),
            }
          }

          break
        case 'attachment':
          this.mutableMessages.push(message)
          // `attachment` 同样内联记录，原因与 `progress` 相同：保证后续去重与 `resume` 链路稳定。
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }

          // 如果 attachment 表示 StructuredOutput 结果，则把结构化输出单独取出来。
          if (message.attachment.type === 'structured_output') {
            structuredOutputFromTool = message.attachment.data
          }
          // 处理 query.ts 抛出的 max turns reached 信号。
          else if (message.attachment.type === 'max_turns_reached') {
            if (persistSession) {
              if (
                isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
                isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
              ) {
                await flushSessionStorage()
              }
            }
            yield {
              type: 'result',
              subtype: 'error_max_turns',
              duration_ms: Date.now() - startTime,
              duration_api_ms: getTotalAPIDuration(),
              is_error: true,
              num_turns: message.attachment.turnCount,
              stop_reason: lastStopReason,
              session_id: getSessionId(),
              total_cost_usd: getTotalCost(),
              usage: this.totalUsage,
              modelUsage: getModelUsage(),
              permission_denials: this.permissionDenials,
              fast_mode_state: getFastModeState(
                mainLoopModel,
                initialAppState.fastMode,
              ),
              uuid: randomUUID(),
              errors: [
                `Reached maximum number of turns (${message.attachment.maxTurns})`,
              ],
            }
            return
          }
          // 把 queued_command 附件重新包装成 SDK 侧的 user replay 消息。
          else if (
            replayUserMessages &&
            message.attachment.type === 'queued_command'
          ) {
            yield {
              type: 'user',
              message: {
                role: 'user' as const,
                content: message.attachment.prompt,
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: message.attachment.source_uuid || message.uuid,
              timestamp: message.timestamp,
              isReplay: true,
            } as SDKUserMessageReplay
          }
          break
        case 'stream_request_start':
          // stream_request_start 仅用于内部控制，不向 SDK 对外透传。
          break
        case 'system': {
          // 遇到 snip boundary 时，不是直接把它当普通消息压进去，
          // 而是要在当前 store 上回放一次 snip，清掉僵尸消息与过期标记。
          // 否则这些标记会在后续轮次重复触发，mutableMessages 也永远不会收缩。
          const snipResult = this.config.snipReplay?.(
            message,
            this.mutableMessages,
          )
          if (snipResult !== undefined) {
            if (snipResult.executed) {
              this.mutableMessages.length = 0
              this.mutableMessages.push(...snipResult.messages)
            }
            break
          }
          this.mutableMessages.push(message)
          // compact boundary 需要作为显式系统消息抛给 SDK。
          if (
            message.subtype === 'compact_boundary' &&
            message.compactMetadata
          ) {
            // compact boundary 一旦写入，就可以把 boundary 之前的消息从本地 store 中释放掉，
            // 因为 query.ts 之后也只会继续基于边界之后的消息推进。
            const mutableBoundaryIdx = this.mutableMessages.length - 1
            if (mutableBoundaryIdx > 0) {
              this.mutableMessages.splice(0, mutableBoundaryIdx)
            }
            const localBoundaryIdx = messages.length - 1
            if (localBoundaryIdx > 0) {
              messages.splice(0, localBoundaryIdx)
            }

            yield {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: message.uuid,
              compact_metadata: toSDKCompactMetadata(message.compactMetadata),
            }
          }
          if (message.subtype === 'api_error') {
            yield {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt: message.retryAttempt,
              max_retries: message.maxRetries,
              retry_delay_ms: message.retryInMs,
              error_status: message.error.status ?? null,
              error: categorizeRetryableAPIError(message.error),
              session_id: getSessionId(),
              uuid: message.uuid,
            }
          }
          // 其他 system 消息在 headless 模式下不对外透传。
          break
        }
        case 'tool_use_summary':
          // 工具使用摘要消息需要单独对 SDK 暴露。
          yield {
            type: 'tool_use_summary' as const,
            summary: message.summary,
            preceding_tool_use_ids: message.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: message.uuid,
          }
          break
      }

      // 检查是否超出了美元预算上限。
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        if (persistSession) {
          if (
            isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
            isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          is_error: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          fast_mode_state: getFastModeState(
            mainLoopModel,
            initialAppState.fastMode,
          ),
          uuid: randomUUID(),
          errors: [`Reached maximum budget ($${maxBudgetUsd})`],
        }
        return
      }

      // 检查结构化输出重试次数是否已经超限（只在 `user` 消息路径上判定）。
      if (message.type === 'user' && jsonSchema) {
        const currentCalls = countToolCalls(
          this.mutableMessages,
          SYNTHETIC_OUTPUT_TOOL_NAME,
        )
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        const maxRetries = parseInt(
          process.env.MAX_STRUCTURED_OUTPUT_RETRIES || '5',
          10,
        )
        if (callsThisQuery >= maxRetries) {
          if (persistSession) {
            if (
              isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
              isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }
          yield {
            type: 'result',
            subtype: 'error_max_structured_output_retries',
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            is_error: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            fast_mode_state: getFastModeState(
              mainLoopModel,
              initialAppState.fastMode,
            ),
            uuid: randomUUID(),
            errors: [
              `Failed to provide valid structured output after ${maxRetries} attempts`,
            ],
          }
          return
        }
      }
    }

    // `stop hooks` 可能会在 `assistant` 响应之后继续产出 `progress/attachment`。
    // 因此这里不能简单取 `last(messages)` 并假设它一定是 `assistant`，
    // 否则后面提取 `textResult` 时很容易拿到空字符串。
    // 这里显式只在 `assistant/user` 范围内找最终结果消息。
    const result = messages.findLast(
      m => m.type === 'assistant' || m.type === 'user',
    )
    // 先把 result 的关键信息缓存出来，供 error_during_execution 诊断使用。
    // 因为 `isResultSuccessful` 是类型谓词，一旦进入 false 分支，TypeScript 会把 result 收窄到更苛刻的类型。
    const edeResultType = result?.type ?? 'undefined'
    const edeLastContentType =
      result?.type === 'assistant'
        ? (last(result.message.content)?.type ?? 'none')
        : 'n/a'

    // 在最终 result 发给 SDK 之前，先把 transcript 缓冲刷盘。
    // 某些宿主（例如桌面端）拿到 result 后会立刻杀掉 CLI 进程，
    // 如果这时还没 flush，就会丢失最后一批 transcript 写入。
    if (persistSession) {
      if (
        isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
        isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
      ) {
        await flushSessionStorage()
      }
    }

    if (!isResultSuccessful(result, lastStopReason)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        is_error: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
        // 先放一条诊断前缀，说明这次为什么被判定为 error_during_execution。
        // errors[] 也会通过前面的 watermark 控制在“当前 turn”范围内，
        // 避免把整个进程历史错误全部倒出来污染诊断。
        errors: (() => {
          const all = getInMemoryErrors()
          const start = errorLogWatermark
            ? all.lastIndexOf(errorLogWatermark) + 1
            : 0
          return [
            `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
            ...all.slice(start).map(_ => _.error),
          ]
        })(),
      }
      return
    }

    // 根据最终消息类型提取可返回的文本结果。
    let textResult = ''
    let isApiError = false

    if (result.type === 'assistant') {
      const lastContent = last(result.message.content)
      if (
        lastContent?.type === 'text' &&
        !SYNTHETIC_MESSAGES.has(lastContent.text)
      ) {
        textResult = lastContent.text
      }
      isApiError = Boolean(result.isApiErrorMessage)
    }

    yield {
      type: 'result',
      subtype: 'success',
      is_error: isApiError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalAPIDuration(),
      num_turns: turnCount,
      result: textResult,
      stop_reason: lastStopReason,
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),
      usage: this.totalUsage,
      modelUsage: getModelUsage(),
      permission_denials: this.permissionDenials,
      structured_output: structuredOutputFromTool,
      fast_mode_state: getFastModeState(
        mainLoopModel,
        initialAppState.fastMode,
      ),
      uuid: randomUUID(),
    }
  }

  interrupt(): void {
    this.abortController.abort()
  }

  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  getSessionId(): string {
    return getSessionId()
  }

  setModel(model: string): void {
    this.config.userSpecifiedModel = model
  }
}

/**
 * `ask()` 是 QueryEngine 的“一次性包装入口”。
 *
 * 适用场景：
 * - 调用方不想自己维护 `QueryEngine` 实例；
 * - 只想临时传一组参数，跑一次 `submitMessage()`；
 * - 但仍希望复用 QueryEngine 的会话级能力（消息映射、usage 累积、cache 管理等）。
 *
 * 本质上它做三件事：
 * 1. 临时构造 `QueryEngineConfig`；
 * 2. 创建一个 `QueryEngine` 实例；
 * 3. 调用一次 `submitMessage()`，最后把 `readFileCache` 回写给调用方。
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  commands: Command[]
  prompt: string | Array<ContentBlockParam>
  promptUuid?: string
  isMeta?: boolean
  cwd: string
  tools: Tools
  verbose?: boolean
  mcpClients: MCPServerConnection[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  canUseTool: CanUseToolFn
  mutableMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  jsonSchema?: Record<string, unknown>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
  abortController?: AbortController
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  agents?: AgentDefinition[]
  setSDKStatus?: (status: SDKStatus) => void
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<SDKMessage, void, unknown> {
  const engine = new QueryEngine({
    cwd,
    tools,
    commands,
    mcpClients,
    agents,
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
    ...(feature('HISTORY_SNIP')
      ? {
          snipReplay: (yielded: Message, store: Message[]) => {
            if (!snipProjection!.isSnipBoundaryMessage(yielded))
              return undefined
            return snipModule!.snipCompactIfNeeded(store, { force: true })
          },
        }
      : {}),
  })

  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    setReadFileCache(engine.getReadFileState())
  }
}
