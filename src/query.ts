// biome-ignore-all assist/source/organizeImports: ANT-ONLY 的 import 标记顺序不能被自动整理
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { FallbackTriggeredError } from './services/api/withRetry.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from './services/compact/autoCompact.js'
import { buildPostCompactMessages } from './services/compact/compact.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
  : null
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { ImageSizeError } from './utils/imageValidation.js'
import { ImageResizeError } from './utils/imageResizer.js'
import { findToolByName, type ToolUseContext } from './Tool.js'
import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from './types/message.js'
import { logError } from './utils/log.js'
import {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isPromptTooLongMessage,
} from './services/api/errors.js'
import { logAntError, logForDebugging } from './utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
  createMicrocompactBoundaryMessage,
  stripSignatureBlocks,
} from './utils/messages.js'
import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
import { prependUserContext, appendSystemContext } from './utils/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from './utils/attachments.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('./services/skillSearch/prefetch.js') as typeof import('./services/skillSearch/prefetch.js'))
  : null
const jobClassifier = feature('TEMPLATES')
  ? (require('./jobs/classifier.js') as typeof import('./jobs/classifier.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  remove as removeFromQueue,
  getCommandsByMaxPriority,
  isSlashCommand,
} from './utils/messageQueueManager.js'
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import {
  getRuntimeMainLoopModel,
  renderModelName,
} from './utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from './utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from './utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/growthbook.js'
import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from './utils/hooks.js'
import type { QuerySource } from './constants/querySource.js'
import { createDumpPromptsFetch } from './services/api/dumpPrompts.js'
import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
import { queryCheckpoint } from './utils/queryProfiler.js'
import { runTools } from './services/tools/toolOrchestration.js'
import { applyToolResultBudget } from './utils/toolResultStorage.js'
import { recordContentReplacement } from './utils/sessionStorage.js'
import { handleStopHooks } from './query/stopHooks.js'
import { buildQueryConfig } from './query/config.js'
import { productionDeps, type QueryDeps } from './query/deps.js'
import type { Terminal, Continue } from './query/transitions.js'
import { feature } from 'bun:bundle'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
} from './bootstrap/state.js'
import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
import { count } from './utils/array.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const taskSummaryModule = feature('BG_SESSIONS')
  ? (require('./utils/taskSummary.js') as typeof import('./utils/taskSummary.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * `query.ts` 是 Claude Code 单轮执行的核心状态机。
 *
 * 它串起了以下关键步骤：
 * - 消息预处理与上下文拼装；
 * - 模型调用与流式响应消费；
 * - 工具执行与 tool_result 回填；
 * - compact / reactive compact / context collapse 等恢复路径；
 * - stop hook、token budget、max_output_tokens 恢复等继续/终止判断。
 *
 * 如果把整个系统看成：
 * - `main.tsx` 负责启动；
 * - `QueryEngine.ts` 负责会话；
 * - `services/api/*` 负责模型通信；
 * - `services/tools/*` 负责执行工具；
 *
 * 那么 `query.ts` 负责把这些环节真正串成一条可持续推进的代理主循环。
 */

/**
 * 为已经发出的 tool_use 补齐错误型 tool_result。
 *
 * 作用：
 * - 当中途异常/中断发生时，尽量保持消息轨迹闭合；
 * - 避免出现 assistant 发出 tool_use 后，对应 tool_result 永远缺失的坏历史。
 */
function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // 先找出这条 assistant 消息中声明的全部 `tool_use` block。
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    // 再为每个 `tool_use` 生成一条错误型 `tool_result`，把消息闭环补完整。
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
  }
}

/**
 * 关于 thinking block 的三条铁律。
 *
 * 这些规则看起来很烦，但它们直接决定了：
 * - thinking / redacted_thinking 是否能被 API 接受；
 * - 带有 thinking 的消息在多轮 assistant 轨迹里能否继续复用；
 * - 为什么某些看似无害的消息改写，最终会触发极难排查的协议错误。
 *
 * 规则如下：
 * 1. 只要消息里含有 `thinking` 或 `redacted_thinking` block，这轮 query 的 `max_thinking_length` 必须大于 0；
 * 2. `thinking` block 不能成为一个 block 序列里的最后一个元素；
 * 3. 在 assistant 轨迹持续期间，thinking block 必须被完整保留。
 *    所谓 assistant 轨迹，最少是一轮 assistant 输出；
 *    如果这轮 assistant 还发出了 `tool_use`，那么对应的 `tool_result` 以及后续 assistant 消息也都属于同一条轨迹。
 *
 * 一旦破坏这些规则，最常见的后果就是：你会得到一整天的调试痛苦。
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * 判断这是不是一个 `max_output_tokens` 错误消息。
 *
 * 如果是，那么在流式阶段不能立刻把它暴露给 SDK 调用方，
 * 而应该先“扣住”，等恢复循环判断清楚：
 * - 这一轮是否还能继续恢复；
 * - 还是已经必须终止。
 *
 * 原因是：很多 SDK 消费端（例如 `cowork`、`desktop` 这类客户端）一旦看到 `error` 字段，
 * 就会直接结束会话；如果这里过早抛出中间错误，恢复循环虽然还在后台继续跑，
 * 但外层已经没有人继续监听结果了。
 *
 * 这个逻辑与 `reactiveCompact.isWithheldPromptTooLong` 的思路一致。
 */
function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  // API 侧 `task_budget`（对应 `output_config.task_budget`，beta: task-budgets-2026-03-13）。
  // 它和本地的 tokenBudget +500k 自动续跑机制不是一回事。
  // 这里的 `total` 表示整个代理轮次的总预算；
  // `remaining` 则是在每轮迭代中，基于累计 API usage 动态算出来的剩余额度。
  // 具体参数组装逻辑见 claude.ts 里的 `configureTaskBudgetParams`。
  taskBudget?: { total: number }
  deps?: QueryDeps
}

// ===== query loop 状态定义 =====

/**
 * `queryLoop()` 在多次迭代之间传递的可变状态。
 *
 * 这里没有显式 `enum State` 风格的有限状态机，
 * 而是用一个结构体把“当前继续下一轮所需的所有上下文”统一封装起来。
 *
 * 好处：
 * - continue 分支必须显式构造下一份状态，避免漏改变量；
 * - 更方便测试和观察“本轮为什么继续下一轮”；
 * - 所有恢复路径（compact / token budget / stop hook / recovery）都能统一落在同一模型上。
 */
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  // 记录上一轮为何会继续推进到下一轮；首轮时为 `undefined`。
  // 这样测试里可以直接断言“触发了哪条恢复路径”，而不必去解析消息内容。
  transition: Continue | undefined
}

/**
 * 对外暴露的 query 入口。
 *
 * 它本身比较薄，职责主要是：
 * - 调用内部真正的 `queryLoop()`；
 * - 在正常返回时，把本轮消费过的 slash command UUID 标记为 completed；
 * - 保证 queryLoop 的返回语义对外是稳定的。
 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 只有当 queryLoop 正常返回时才会走到这里。
  // 如果 queryLoop 是通过 throw 退出，错误会沿着 `yield*` 直接向外传播；
  // 如果是 `.return()`，则两个 generator 会一起关闭。
  // 这种设计让这里保留了和 print.ts 里 drainCommandQueue 相同的语义：
  // 某些失败路径会出现“started 已经发出，但 completed 没来得及发送”的不对称信号。
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}

/**
 * 单轮代理主循环的真正实现。
 *
 * 一个 `while (true)` 代表一次又一次：
 * - 准备请求
 * - 调模型
 * - 跑工具
 * - 判断是否继续
 *
 * 每次要继续时，都会显式构造一个新的 `State` 再 `continue`；
 * 每次要终止时，都会返回一个带 `reason` 的 Terminal 结果。
 */
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // 这些是本轮 query 的只读入参，整个循环过程中不会被重新赋值。
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  // 跨迭代可变状态。每轮循环开头都会从这里解构出当前值，
  // 这样读取时仍然可以直接用局部变量（如 `messages`、`toolUseContext`），
  // 而所有状态切换则统一集中在 `state = { ... }` 这类显式赋值点。
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  // 用于跨 compact 边界跟踪 `task_budget.remaining`。
  // 在第一次 compact 触发前，它保持 undefined：因为此时服务端仍能看到完整上下文，
  // 可以自己从 `{total}` 倒计时。
  // 一旦 compact 发生，服务端看到的只剩摘要，如果不显式补 `remaining`，
  // 它就会低估已经消耗的额度。
  // 这里的 remaining 表示：那些在 compact 前已经真正消耗掉、但被摘要折叠掉的上下文窗口。
  // 它是循环局部变量，而不是 State 字段，这样可以避免修改所有 continue 分支。
  let taskBudgetRemaining: number | undefined = undefined

  // 在进入 query 时，把当前环境 / Statsig / session 相关只读状态做一次快照。
  // 具体要收集哪些内容由 `QueryConfig` 定义，
  // 同时它也解释了为什么某些 feature gate 不适合放进这份快照。
  const config = buildQueryConfig()

  // 这类 memory prefetch 每个用户 turn 只触发一次。
  // 因为 prompt 在同一轮循环里是稳定的，如果每次迭代都触发，就会把同一个 sideQuery 问题重复问 N 次。
  // 消费点只看 `settledAt`，不会阻塞；`using` 则保证无论 generator 以何种方式退出，都能正确清理。
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  /**
   * 主循环开始。
   *
   * 每次循环都可以理解为“尝试完成当前这一轮用户意图”的一次推进。
   * 本轮内部可能发生：
   * - 正常模型响应并结束；
   * - 模型要求调用工具；
   * - 触发 compact / recovery；
   * - 被 stop hook / token budget / max turns 截断；
   * - 被中断或异常终止。
   */
  // eslint-disable-next-line no-constant-condition
  while (true) {
    /**
     * 每一轮循环开头，都先从 `state` 中解构出当前的工作状态。
     *
     * 这样本轮逻辑读起来仍然像“普通局部变量”，
     * 但真正的状态转移仍集中在构造下一份 `State` 的地方。
     */
    // 每次迭代一开始，都先从 `state` 中拆出当前工作集。
    // 其中只有 `toolUseContext` 会在本轮内部被重新赋值（例如更新 `queryTracking`、同步消息）；
    // 其余字段在下一次 `continue` 之前都视为只读。
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state

    // 每轮都尝试做一次 skill discovery 预取，但内部会由 `findWritePivot`
    // 判断当前上下文是否值得提前返回。
    // 这项发现工作会和模型流式输出、工具执行并行发生，
    // 等到工具阶段之后再与 memory prefetch 一起统一消费。
    // 它取代了过去在 `getAttachmentMessages` 里那条阻塞式 assistant_turn 路径，
    // 因为线上 97% 的那类调用其实什么也没找到。
    // 唯一仍然必须阻塞的是第 0 轮的 user-input discovery，因为那时还没有其他工作可以拿来并行掩盖等待时间。
    const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )

    yield { type: 'stream_request_start' }

    queryCheckpoint('query_fn_entry')

    // 记录 query 真正开始执行的时间点，用于无头（headless）场景下的延迟统计；
    // 子 agent 不单独记这一项，避免把父子链路拆散。
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // 初始化或递增 query chain 跟踪信息。
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const queryChainIdForAnalytics =
      queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    let tracking = autoCompactTracking

    // 对聚合后的 tool result 总大小执行“按消息预算”裁剪。
    // 这一步必须发生在 microcompact 之前：缓存型 microcompact 只按 `tool_use_id` 运作，
    // 根本不看内容，因此内容替换不会干扰它，二者可以安全叠加。
    // 当 `contentReplacementState` 为 `undefined`（功能关闭）时，这一步会自然退化为空操作。
    // 只有后续还会从 transcript / resume 中回读这些替换记录的 `querySource`，
    // 才值得把替换记录持久化下来。
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? records =>
            void recordContentReplacement(
              records,
              toolUseContext.agentId,
            ).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
    )

    // 先做 snip，再做 microcompact；两者可以叠加，并不是二选一。
    // `snipTokensFreed` 会继续传给 autocompact，让后者在判断阈值时知道 snip 已经释放了多少 token。
    // 仅靠 `tokenCountWithEstimation()` 看不到这部分变化，因为它读取的是受保护尾部 assistant 消息记录的 usage，
    // 而那部分消息在 snip 后仍可能保持不变。
    let snipTokensFreed = 0
    if (feature('HISTORY_SNIP')) {
      queryCheckpoint('query_snip_start')
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
      snipTokensFreed = snipResult.tokensFreed
      if (snipResult.boundaryMessage) {
        yield snipResult.boundaryMessage
      }
      queryCheckpoint('query_snip_end')
    }

    /**
     * 压缩策略优先级：
     * 1. 先 snip（更轻量的局部裁剪）；
     * 2. 再 microcompact（更轻量的消息级压缩）；
     * 3. 然后 context collapse；
     * 4. 最后才是 autocompact（最重，可能生成正式摘要消息）。
     *
     * 这个顺序反映的是 Claude Code 的核心设计哲学：
     * **优先用代价更小、保留细节更多的压缩手段；只有必要时才触发真正重型摘要。**
     */
    // 先执行 microcompact，再决定是否需要更重的 autocompact。
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    // 对缓存型 microcompact（主要是缓存编辑类压缩）来说，边界消息要延迟到 API 响应之后再发，
    // 这样才能使用服务端实际返回的 `cache_deleted_input_tokens`，而不是客户端估算值。
    // 这里继续受 feature() gate 保护，避免相关字符串泄露到外部构建。
    const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
      ? microcompactResult.compactionInfo?.pendingCacheEdits
      : undefined
    queryCheckpoint('query_microcompact_end')

    // 投影 collapsed context 视图，并在需要时提交更多 collapse。
    // 这一步放在 autocompact 之前，是为了尽可能让更轻量的 collapse 先发挥作用：
    // 如果 collapse 已经把上下文压到 autocompact 阈值以下，后者就可以直接空转返回，
    // 从而保留更细粒度的原始上下文，而不是生成一整条摘要。
    //
    // 这里不会 yield 新消息，因为 collapsed view 本质上是对 REPL 全历史的“读时投影”；
    // 摘要消息真正存放在 collapse store 中，而不直接写入 REPL 消息数组。
    // 这也是 collapse 能跨轮次持续生效的原因。
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = collapseResult.messages
    }

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
      snipTokensFreed,
    )
    queryCheckpoint('query_autocompact_end')

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      logEvent('tengu_auto_compact_succeeded', {
        originalMessageCount: messages.length,
        compactedMessageCount:
          compactionResult.summaryMessages.length +
          compactionResult.attachments.length +
          compactionResult.hookResults.length,
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionInputTokens: compactionUsage?.input_tokens,
        compactionOutputTokens: compactionUsage?.output_tokens,
        compactionCacheReadTokens:
          compactionUsage?.cache_read_input_tokens ?? 0,
        compactionCacheCreationTokens:
          compactionUsage?.cache_creation_input_tokens ?? 0,
        compactionTotalTokens: compactionUsage
          ? compactionUsage.input_tokens +
            (compactionUsage.cache_creation_input_tokens ?? 0) +
            (compactionUsage.cache_read_input_tokens ?? 0) +
            compactionUsage.output_tokens
          : 0,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // 对 task_budget 来说，需要在 `messagesForQuery` 被 postCompactMessages 覆盖前，
      // 先抓住 compact 前那一刻真正的最终上下文窗口。
      // 这里依赖 `iterations[-1]` 代表服务端 tool loops 之后的权威最终窗口。
      if (params.taskBudget) {
        const preCompactContext =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // 每次 compact 成功后，都要重置 turnCounter/turnId，
      // 让它们反映“最近一次 compact”而不是历史上某次更早的 compact。
      // 之前那次 compact 的相关信息已经在 autoCompact 侧先行记录，因此这里重置不会丢历史。
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      for (const message of postCompactMessages) {
        yield message
      }

      // 用 compact 后的新消息继续当前 query。
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // 如果 autocompact 失败，就把失败次数向后传递，
      // 供下一轮的熔断逻辑判断是否该停止重试。
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    // 后续可清理：理论上不必在 setup 阶段就提前写入 `toolUseContext.messages`，因为这里会统一覆盖。
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // 参考：https://docs.claude.com/en/docs/build-with-claude/tool-use
    // 注意：`stop_reason === 'tool_use'` 并不可靠，不能完全依赖。
    // 当前实现是在流式过程中只要看到 `tool_use block` 就认定这轮需要继续；
    // 如果整个流结束后都没看到 tool_use，那么通常说明这轮已经可以结束（除非后面 stop hook 要求重试）。
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    const useStreamingToolExecution = config.gates.streamingToolExecution
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })

    queryCheckpoint('query_setup_end')

    // 每个 query 会话只创建一次 fetch 包装器，避免闭包长期持有历史请求体。
    // `createDumpPromptsFetch()` 每调一次都会捕获当时的请求体；
    // 如果每轮都新建，长会话里会累计保留大量旧请求，带来明显内存压力。
    // 这里复用单个包装器，可以把残留在内存里的请求体控制在“最新的一份”。
    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    /**
     * 真正调用模型前的“阻断阈值”检查。
     *
     * 当上下文已经明显超限，而且当前又没有可用的自动恢复路径时，
     * 直接在本地中断会比把一个注定失败的请求发给模型 API 更合理。
     */
    // 如果已经撞到硬性阻断阈值，就在本地直接拦下（仅在 auto-compact 关闭时适用）。
    // 这样可以为用户手动执行 `/compact` 预留空间。
    //
    // 但以下情况要跳过这次预拦截：
    // - 刚刚已经 compact 过：否则 `tokenCountWithEstimation()` 读到的还是压缩前 usage，会误判；
    // - snip 刚刚释放了 token：否则也可能因为旧 usage 误判；
    // - 当前是 `compact/session_memory` query：这些就是为了解决超长上下文而生，不能把它们自己挡死；
    // - reactive compact 已开启且允许自动压缩：否则会在 API 调用前就提前返回，反而让 reactive compact 没机会处理真正的 413；
    // - context collapse 的 recoverFromOverflow 也依赖真实 API 413 才能工作，同样不能被提前短路。
    //
    // 总之，这里的本地预拦截只在“没有更合适自动恢复路径”时才启用。
    let collapseOwnsIt = false
    if (feature('CONTEXT_COLLAPSE')) {
      collapseOwnsIt =
        (contextCollapse?.isContextCollapseEnabled() ?? false) &&
        isAutoCompactEnabled()
    }
    // 把媒体恢复开关固定在“每轮 turn”级别。
    // 原因是：流内的 withheld 判定和流后的 recovery 判定必须使用同一份结论；
    // 如果在 5~30 秒流式过程中 gate 发生翻转，就可能出现“前面扣住了错误，后面却不再恢复”的丢消息问题。
    // 至于 PTL，没有采用这种 hoist，
    // 是因为它本来就不走这一套 gate 控制路径。
    const mediaRecoveryEnabled =
      reactiveCompact?.isReactiveCompactEnabled() ?? false
    if (
      !compactionResult &&
      querySource !== 'compact' &&
      querySource !== 'session_memory' &&
      !(
        reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()
      ) &&
      !collapseOwnsIt
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    /**
     * 模型 API 调用内部允许发生一次或多次 fallback / recovery 尝试，
     * 因此外层这里还包了一层“小循环”专门处理同轮内的重试。
     */
    let attemptWithFallback = true

    // ===== 阶段一：调用模型，并消费这一轮的流式输出 =====
    queryCheckpoint('query_api_loop_start')
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              ...(config.gates.fastModeEnabled && {
                fastMode: appState.fastMode,
              }),
              toolChoice: undefined,
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes:
                toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt:
                !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride,
              fetchOverride: dumpPromptsFetch,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some(
                c => c.type === 'pending',
              ),
              queryTracking,
              effortValue: appState.effortValue,
              advisorModel: appState.advisorModel,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
            },
          })) {
            // 第一轮失败尝试里收到的 tool_calls 不再复用。
            // 理论上可以尝试复用，但那意味着必须把不同 assistant message id 的结果强行合并，
            // 并处理 tool_result 重复回填的问题，复杂度和风险都太高。
            if (streamingFallbackOccured) {
              // 为失败尝试里遗留下来的半成品消息发出 tombstone，
              // 这样 UI 和 transcript 都能把它们移除。
              // 特别是 thinking block 这类半消息，如果继续留着，后面很容易触发
              // “thinking blocks cannot be modified” 之类的 API 错误。
              for (const msg of assistantMessages) {
                yield { type: 'tombstone' as const, message: msg }
              }
              logEvent('tengu_orphaned_messages_tombstoned', {
                orphanedMessageCount: assistantMessages.length,
                queryChainId: queryChainIdForAnalytics,
                queryDepth: queryTracking.depth,
              })

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              // 丢弃这次失败流式尝试中尚未产出的结果，并创建一个全新的执行器。
              // 这样可以避免 fallback 响应回来之后，旧 `tool_use_id` 对应的孤儿 `tool_result` 混进新结果里。
              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }
            // 在 `yield` 之前，先对 clone 出来的 message 回填 `tool_use` 输入，
            // 让 SDK 流输出和 transcript 序列化都能看到 legacy / derived 字段。
            // 原始 `message` 本身不能改，因为它后面还要回流给 API；
            // 一旦字节级内容变化，就会破坏 prompt cache。
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              let clonedContent: typeof message.message.content | undefined
              for (let i = 0; i < message.message.content.length; i++) {
                const block = message.message.content[i]!
                if (
                  block.type === 'tool_use' &&
                  typeof block.input === 'object' &&
                  block.input !== null
                ) {
                  const tool = findToolByName(
                    toolUseContext.options.tools,
                    block.name,
                  )
                  if (tool?.backfillObservableInput) {
                    const originalInput = block.input as Record<string, unknown>
                    const inputCopy = { ...originalInput }
                    tool.backfillObservableInput(inputCopy)
                    // 只有当 backfill 是“新增字段”时，才把 clone 消息真正 `yield` 出去。
                    // 如果只是覆盖已有字段（例如 file tool 展开 `file_path`），就跳过。
                    // 因为覆盖会改变 transcript 的序列化结果，进而破坏 resume 时 VCR fixture 的哈希；
                    // 而 SDK 流本身并不需要这类仅覆盖型变化。
                    const addedFields = Object.keys(inputCopy).some(
                      k => !(k in originalInput),
                    )
                    if (addedFields) {
                      clonedContent ??= [...message.message.content]
                      clonedContent[i] = { ...block, input: inputCopy }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: { ...message.message, content: clonedContent },
                }
              }
            }
            // 对“理论上可恢复”的错误（如 `prompt-too-long`、`max-output-tokens`），
            // 先暂时扣住，不立刻往外抛。
            // 这样下面的恢复路径（collapse drain / reactive compact / truncation retry）
            // 还有机会把这一轮救回来。
            // 这些消息仍然会进 assistantMessages，方便后续恢复判定读取到它们。
            // `collapse` 和 `reactive compact` 的 withholding 是彼此独立的；
            // 只要任意一边启用，就足以把错误先扣住。
            // 另外，因为 `feature()` 受 bun:bundle 的 tree-shaking 约束，只能写在 if/ternary 结构里，
            // 所以这里的判断写成嵌套，而不是更漂亮的组合表达式。
            let withheld = false
            if (feature('CONTEXT_COLLAPSE')) {
              if (
                contextCollapse?.isWithheldPromptTooLong(
                  message,
                  isPromptTooLongMessage,
                  querySource,
                )
              ) {
                withheld = true
              }
            }
            if (reactiveCompact?.isWithheldPromptTooLong(message)) {
              withheld = true
            }
            if (
              mediaRecoveryEnabled &&
              reactiveCompact?.isWithheldMediaSizeError(message)
            ) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }
            if (!withheld) {
              yield yieldMessage
            }
            if (message.type === 'assistant') {
              assistantMessages.push(message)

              const msgToolUseBlocks = message.message.content.filter(
                content => content.type === 'tool_use',
              ) as ToolUseBlock[]
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }

              if (
                streamingToolExecutor &&
                !toolUseContext.abortController.signal.aborted
              ) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, message)
                }
              }
            }

            if (
              streamingToolExecutor &&
              !toolUseContext.abortController.signal.aborted
            ) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter(_ => _.type === 'user'),
                  )
                }
              }
            }
          }
          queryCheckpoint('query_api_streaming_end')

          // 在这里补发延迟发送的 microcompact boundary message，
          // 并优先使用 API 真实返回的 token 删除量，而不是客户端侧估算值。
          // 整段逻辑仍然受 feature() gate 保护，保证相关字符串不会进入外部构建。
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            // 这个 API 字段是跨请求累积的，因此这里要减去本次请求前记录的基线值，
            // 才能得到当前这次请求真正新增的增量。
            const usage = lastAssistant?.message.usage
            const cumulativeDeleted = usage
              ? ((usage as unknown as Record<string, number>)
                  .cache_deleted_input_tokens ?? 0)
              : 0
            const deletedTokens = Math.max(
              0,
              cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
            )
            if (deletedTokens > 0) {
              yield createMicrocompactBoundaryMessage(
                pendingCacheEdits.trigger,
                0,
                deletedTokens,
                pendingCacheEdits.deletedToolIds,
                [],
              )
            }
          }
        } catch (innerError) {
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            // 触发了 fallback：切换模型后重试这一轮。
            currentModel = fallbackModel
            attemptWithFallback = true

            // 因为整轮请求要重来，先清空本轮暂存的 `assistantMessages`。
            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            // 丢弃失败尝试里还没来得及消费的结果，并创建全新的执行器，
            // 避免旧 tool_use_id 对应的孤儿 tool_result 混入新的重试结果。
            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // 用新的 fallback 模型更新 toolUseContext。
            toolUseContext.options.mainLoopModel = fallbackModel

            // 由于 thinking 签名与模型强绑定：受保护的 thinking block 如果直接重放给不兼容的 fallback 模型，
            // 很容易触发 400。这里先剥掉 thinking 相关块，再让 fallback 模型拿到一份干净历史重试。
            if (process.env.USER_TYPE === 'ant') {
              messagesForQuery = stripSignatureBlocks(messagesForQuery)
            }

            // 记录这次 fallback 事件。
            logEvent('tengu_model_fallback_triggered', {
              original_model:
                innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              entrypoint:
                'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            // 向用户补发一条 fallback 系统消息，并用 warning 级别保证即使不开 verbose 也能看见。
            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )

            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logEvent('tengu_query_error', {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap(_ =>
          _.message.content.filter(content => content.type === 'tool_use'),
        ).length,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // 对图片尺寸/缩放错误返回更友好的用户可读提示。
      if (
        error instanceof ImageSizeError ||
        error instanceof ImageResizeError
      ) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // 正常情况下，`queryModelWithStreaming` 不应直接 `throw`，
      // 而应该把错误包装成“合成的 assistant message”再向外 `yield`。
      // 如果这里真的 throw 了，通常意味着内部 bug，且可能已经发出过 tool_use，
      // 但还没来得及发回对应 tool_result。
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      // 这里要向外暴露“真实错误”，而不是误导性的“用户中断”。
      // 因为这条路径本质上是模型/runtime 故障，不是用户操作；
      // 过去 SDK 侧会把这类问题错误显示成 interrupt，反而掩盖了真正原因。
      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      // 为了便于追踪这类 bug，在 ant 环境下额外高亮记录。
      logAntError('Query error', error)
      return { reason: 'model_error', error }
    }

    // 在模型响应完整结束后，再执行 post-sampling hooks。
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // 流式中断必须优先处理。
    // 如果当前使用的是 `streamingToolExecutor`，还必须先消费它的剩余结果，
    // 让它有机会为那些排队中或执行中的工具补出合成的 `tool_result`。
    // 否则就会留下没有匹配 tool_result 的 tool_use。
    if (toolUseContext.abortController.signal.aborted) {
      if (streamingToolExecutor) {
        // 先消费剩余结果；executor 会基于 abort signal
        // 为中途中断的工具自动生成合成的 `tool_result`。
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          'Interrupted by user',
        )
      }
      // 对 Chicago MCP 来说，中断时还需要补做 auto-unhide 与锁释放。
      // 这里沿用 stopHooks.ts 里自然结束时的清理逻辑，并且只在主线程执行。
      if (!toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 清理失败时静默忽略；这属于内部体验级兜底，不是关键执行路径。
        }
      }

      // 如果是 submit-interrupt，就跳过额外 interruption message，
      // 因为后面紧跟的 queued user message 已经足以说明上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      return { reason: 'aborted_streaming' }
    }

    // 补发上一轮的 `tool use summary`。通常这类摘要会在模型流式执行期间异步生成完成。
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    /**
     * 如果模型这一轮没有发出 tool_use，说明已经来到了“判断是否结束”的分支。
     *
     * 这里会继续判断：
     * - withheld 的错误是否还能恢复；
     * - stop hooks 是否要求补充一轮；
     * - token budget 是否要求继续推进；
     * - 如果都不需要，则本轮自然完成。
     */
    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // 关于 `prompt-too-long` 的恢复顺序：
      // 1. 先尝试 collapse drain（更便宜，也能保留更多细粒度上下文）；
      // 2. 再尝试 reactive compact（更重，会生成正式摘要）。
      // 每种恢复路径都只做一次；如果重试后仍然 413，就交给下一层逻辑处理，或者最终把错误抛出。
      const isWithheld413 =
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage &&
        isPromptTooLongMessage(lastMessage)
      // 图片/PDF/多图等媒体尺寸错误，主要依赖 reactive compact 的 strip-retry 来恢复。
      // 与 PTL 不同，媒体错误不会先走 collapse drain，因为 collapse 根本不会剥图片。
      // 这里使用的是前面提前 hoist 出来的 mediaRecoveryEnabled，
      // 必须和流内的 withheld 判定保持一致，否则会出现“前面扣住了，后面却不恢复”的丢消息问题。
      // 如果超大媒体还落在 preserved tail 里，compact 后下一轮依然可能继续 media-error；
      // `hasAttemptedReactiveCompact` 就是为了防止这种死循环。
      const isWithheldMedia =
        mediaRecoveryEnabled &&
        reactiveCompact?.isWithheldMediaSizeError(lastMessage)
      if (isWithheld413) {
        // 第一步先把已 staged 的 context collapse 全部 drain 掉。
        // 但只有在上一轮 transition 不是 `collapse_drain_retry` 时才这样做；
        // 如果已经 drain 过一次且重试后仍然 413，就直接落到 reactive compact。
        if (
          feature('CONTEXT_COLLAPSE') &&
          contextCollapse &&
          state.transition?.reason !== 'collapse_drain_retry'
        ) {
          const drained = contextCollapse.recoverFromOverflow(
            messagesForQuery,
            querySource,
          )
          if (drained.committed > 0) {
            const next: State = {
              messages: drained.messages,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              transition: {
                reason: 'collapse_drain_retry',
                committed: drained.committed,
              },
            }
            state = next
            continue
          }
        }
      }
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        const compacted = await reactiveCompact.tryReactiveCompact({
          hasAttempted: hasAttemptedReactiveCompact,
          querySource,
          aborted: toolUseContext.abortController.signal.aborted,
          messages: messagesForQuery,
          cacheSafeParams: {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
        })

        if (compacted) {
          // 关于 `task_budget` 的延续逻辑，这里与上面的 proactive compact 保持一致。
          // 此时 `messagesForQuery` 仍然是 compact 前、也就是 413 失败那次请求的原始输入。
          if (params.taskBudget) {
            const preCompactContext =
              finalContextTokensFromLastResponse(messagesForQuery)
            taskBudgetRemaining = Math.max(
              0,
              (taskBudgetRemaining ?? params.taskBudget.total) -
                preCompactContext,
            )
          }

          const postCompactMessages = buildPostCompactMessages(compacted)
          for (const msg of postCompactMessages) {
            yield msg
          }
          const next: State = {
            messages: postCompactMessages,
            toolUseContext,
            autoCompactTracking: undefined,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact: true,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'reactive_compact_retry' },
          }
          state = next
          continue
        }

        // 如果恢复失败，就把之前 withheld 的错误真正抛出来并结束。
        // 注意这里不能再继续落到 stop hooks：模型根本没有产生有效响应，
        // 这样一来，stop hooks 也就没有有意义的输入可评估。
        // 如果此时还继续跑 stop hooks，就很容易形成“错误 -> hook 阻断 -> 重试 -> 再错误”的死循环。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
      } else if (feature('CONTEXT_COLLAPSE') && isWithheld413) {
        // 如果 reactiveCompact 在编译期被裁掉，但 contextCollapse 已经把错误扣住却又恢复不了，
        // 那就直接把错误抛出来。理由同上：也不要再继续落到 stop hooks。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'prompt_too_long' }
      }

      // 处理 max_output_tokens 错误，并在需要时注入恢复消息。
      // 这类错误在流式阶段已经先被扣住，只有当恢复路径耗尽时才真正暴露。
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // 升级重试：如果本轮原本使用的是受限的 8k 默认上限并且撞线，
        // 先在同一轮里直接把请求放大到 64k 再试一次，不额外插入元提示消息。
        // 这条路径每轮最多走一次；如果 64k 仍然不够，再退回到多轮恢复逻辑。
        // 对第三方后端默认关闭，因为在 Bedrock / Vertex 上还没有完成同等级别的验证。
        const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_otk_slot_v1',
          false,
        )
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ) {
          logEvent('tengu_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: State = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // 恢复路径已经耗尽，此时真正把先前扣住的错误暴露出来。
        yield lastMessage
      }

      // 如果最后一条消息本身就是 API error（限流、超长、鉴权失败等），则跳过 stop hooks。
      // 因为模型根本没有给出有效响应，这时让 hooks 去评估只会制造“错误 -> hook 阻断 -> 重试 -> 错误”的死循环。
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'completed' }
      }

      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
      )

      if (stopHookResult.preventContinuation) {
        return { reason: 'stop_hook_prevented' }
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: State = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          // 保留 `hasAttemptedReactiveCompact` 这个护栏。
          // 否则如果 compact 已经试过且确认救不回来，再因为 stop hook 阻断而把它重置成 false，
          // 就会反复触发“compact -> 仍然太长 -> 错误 -> stop hook 阻断 -> 再 compact”的无限循环。
          hasAttemptedReactiveCompact,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            logForDebugging(
              `Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
            )
          }
          logEvent('tengu_token_budget_completed', {
            ...decision.completionEvent,
            queryChainId: queryChainIdForAnalytics,
            queryDepth: queryTracking.depth,
          })
        }
      }

      return { reason: 'completed' }
    }

    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    /**
     * 如果模型给了 tool_use，就进入工具执行分支。
     *
     * 这一段会：
     * - 根据配置选择流式执行器或普通执行器；
     * - 持续把 progress / tool_result 回流给上层；
     * - 在工具执行完成后，准备下一轮 assistant 需要看到的 user/tool_result 消息。
     */
    // ===== 阶段二：执行工具，并把结果拼回下一轮上下文 =====
    queryCheckpoint('query_tool_execution_start')


    if (streamingToolExecutor) {
      logEvent('tengu_streaming_tool_execution_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    } else {
      logEvent('tengu_streaming_tool_execution_not_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    queryCheckpoint('query_tool_execution_end')

    // 等这一批工具全部执行完后，再异步生成 `tool use summary`，
    // 并把结果交给下一轮递归调用使用。
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // 子 agent 不会出现在移动端 UI 中，因此这里跳过额外的 Haiku 摘要调用
    ) {
      // 取最后一段 assistant 文本，作为摘要生成的上下文辅助。
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = lastAssistantMessage.message.content.filter(
          block => block.type === 'text',
        )
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // 收集生成摘要所需的工具信息。
      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        // 找到与当前 tool_use 对应的 tool_result。
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      // 异步触发摘要生成，不阻塞下一轮 API 调用。
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    // 如果在工具执行阶段被中断，就走这里的中断收尾逻辑。
    if (toolUseContext.abortController.signal.aborted) {
      // 对 Chicago MCP 来说，若在工具执行中途被中断，还要补做 auto-unhide 与锁释放。
      // 这通常就是 Computer Use 最容易触发 Ctrl+C 的路径（例如慢截图）。
      // 这里只在主线程执行，子 agent 的处理理由见 stopHooks.ts。
      if (!toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 清理失败时静默忽略；这属于内部体验级兜底，不是关键执行路径。
        }
      }
      // 如果是 submit-interrupt，就跳过额外 interruption message，
      // 因为后面紧跟的 queued user message 已经足以说明上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: true,
        })
      }
      // 即便被中断，也要在返回前补查一次 maxTurns。
      const nextTurnCountOnAbort = turnCount + 1
      if (maxTurns && nextTurnCountOnAbort > maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      return { reason: 'aborted_tools' }
    }

    // 如果 hook 明确要求阻止继续推进，则在这里终止。
    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
      logEvent('tengu_post_autocompact_turn', {
        turnId:
          tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        turnCounter: tracking.turnCounter,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // 这里必须放在工具调用结束之后执行，
    // 否则一旦把 tool_result 和普通 user message 交错发送给 API，就会触发协议错误。

    // 埋点：记录挂载附件前的消息数量。
    logEvent('tengu_query_before_attachments', {
      messagesForQueryCount: messagesForQuery.length,
      assistantMessagesCount: assistantMessages.length,
      toolResultsCount: toolResults.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在处理附件前，先抓取当前待消费的 queued commands 快照。
    // 这些命令会被包装成附件，让 Claude 在当前这轮里一起处理。
    //
    // 这里还承担“排空通知队列”的职责：
    // - LocalShellTask 完成事件在 MONITOR_TOOL 打开时通常按 `'next'` 立即排空；
    // - 其他 task 类型仍然可能走 `'later'`，依赖 Sleep flush 覆盖。
    //
    // 斜杠命令（slash command）不会在这里中途排空，
    // 因为它们必须等当前这轮结束后，经 `processSlashCommand` 正式处理，
    // 不能直接作为普通文本发给模型。
    //
    // 另外，队列是进程级单例：主线程与所有 in-process 子 agent 共享它，
    // 但每个循环只消费“发给自己”的那部分。
    // eslint-disable-next-line custom-rules/require-tool-match-name -- `ToolUseBlock.name` 没有别名可供匹配
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = getCommandsByMaxPriority(
      sleepRan ? 'later' : 'next',
    ).filter(cmd => {
      if (isSlashCommand(cmd)) return false
      if (isMainThread) return cmd.agentId === undefined
      // 子 agent 只消费明确发给自己的 task-notification，绝不会消费用户 prompt。
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    })

    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // 消费 memory prefetch：只有当它已经完成，且尚未在更早迭代里消费过时才真正注入。
    // 如果还没完成，就零等待跳过，留给下一次迭代再试；
    // 只要这轮 query 还没结束，它就还有机会被消费。
    // `readFileState` 是跨迭代累积的，因此能够过滤掉模型在更早迭代中已经读/写/改过的 memory，
    // 这比只看当前迭代的 toolUseBlocks 更准确。
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }


    // 注入预取完成的 skill discovery 结果。
    // `hidden_by_main_turn` 表示这次预取是否已经在当前主轮次结束前悄悄完成；
    // 理想情况下，绝大多数预取都会在主 turn 尚未结束前命中。
    if (skillPrefetch && pendingSkillPrefetch) {
      const skillAttachments =
        await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)
      for (const att of skillAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // 这里只移除那些已经真正作为附件被消费掉的命令。
    // `prompt` 和 `task-notification` 这两类命令，
    // 在上面都已经先转换成附件了。
    const consumedCommands = queuedCommandsSnapshot.filter(
      cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    // 埋点：在文件变更附件挂上之后，记录这一轮的文件变更数量。
    const fileChangeAttachmentCount = count(
      toolResults,
      tr =>
        tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )

    logEvent('tengu_query_after_attachments', {
      totalToolResultsCount: toolResults.length,
      fileChangeAttachmentCount,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在轮次之间刷新工具池，让刚刚连上的 MCP server 也能进入下一轮可用工具集合。
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // 每当出现 tool result 且即将递归到下一轮时，turn 计数就要向前推进。
    const nextTurnCount = turnCount + 1

    // 为 `claude ps` 生成周期性 task summary。
    // 它会在中途就触发，这样长时间运行的 agent 也能不断刷新“当前正在做什么”。
    // 这里只对顶层会话开启（!agentId）；子 agent / fork 不生成这类摘要。
    if (feature('BG_SESSIONS')) {
      if (
        !toolUseContext.agentId &&
        taskSummaryModule!.shouldGenerateTaskSummary()
      ) {
        taskSummaryModule!.maybeGenerateTaskSummary({
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...toolResults,
          ],
        })
      }
    }

    // 检查是否已经触达 maxTurns 上限。
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    queryCheckpoint('query_recursive_call')
    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // while (true)
}
