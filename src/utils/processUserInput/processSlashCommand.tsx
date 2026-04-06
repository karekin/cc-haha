import { feature } from 'bun:bundle';
import type { ContentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources';
import { randomUUID } from 'crypto';
import { setPromptId } from 'src/bootstrap/state.js';
import { builtInCommandNames, type Command, type CommandBase, findCommand, getCommand, getCommandName, hasCommand, type PromptCommand } from 'src/commands.js';
import { NO_CONTENT_MESSAGE } from 'src/constants/messages.js';
import type { SetToolJSXFn, ToolUseContext } from 'src/Tool.js';
import type { AssistantMessage, AttachmentMessage, Message, NormalizedUserMessage, ProgressMessage, UserMessage } from 'src/types/message.js';
import { addInvokedSkill, getSessionId } from '../../bootstrap/state.js';
import { COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG } from '../../constants/xml.js';
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED, logEvent } from '../../services/analytics/index.js';
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js';
import { buildPostCompactMessages } from '../../services/compact/compact.js';
import { resetMicrocompactState } from '../../services/compact/microCompact.js';
import type { Progress as AgentProgress } from '../../tools/AgentTool/AgentTool.js';
import { runAgent } from '../../tools/AgentTool/runAgent.js';
import { renderToolUseProgressMessage } from '../../tools/AgentTool/UI.js';
import type { CommandResultDisplay } from '../../types/command.js';
import { createAbortController } from '../abortController.js';
import { getAgentContext } from '../agentContext.js';
import { createAttachmentMessage, getAttachmentMessages } from '../attachments.js';
import { logForDebugging } from '../debug.js';
import { isEnvTruthy } from '../envUtils.js';
import { AbortError, MalformedCommandError } from '../errors.js';
import { getDisplayPath } from '../file.js';
import { extractResultText, prepareForkedCommandContext } from '../forkedAgent.js';
import { getFsImplementation } from '../fsOperations.js';
import { isFullscreenEnvEnabled } from '../fullscreen.js';
import { toArray } from '../generators.js';
import { registerSkillHooks } from '../hooks/registerSkillHooks.js';
import { logError } from '../log.js';
import { enqueuePendingNotification } from '../messageQueueManager.js';
import { createCommandInputMessage, createSyntheticUserCaveatMessage, createSystemMessage, createUserInterruptionMessage, createUserMessage, formatCommandInputTags, isCompactBoundaryMessage, isSystemLocalCommandMessage, normalizeMessages, prepareUserContent } from '../messages.js';
import type { ModelAlias } from '../model/aliases.js';
import { parseToolListFromCLI } from '../permissions/permissionSetup.js';
import { hasPermissionsToUseTool } from '../permissions/permissions.js';
import { isOfficialMarketplaceName, parsePluginIdentifier } from '../plugins/pluginIdentifier.js';
import { isRestrictedToPluginOnly, isSourceAdminTrusted } from '../settings/pluginOnlyPolicy.js';
import { parseSlashCommand } from '../slashCommandParsing.js';
import { sleep } from '../sleep.js';
import { recordSkillUsage } from '../suggestions/skillUsageTracking.js';
import { logOTelEvent, redactIfDisabled } from '../telemetry/events.js';
import { buildPluginCommandTelemetryFields } from '../telemetry/pluginTelemetry.js';
import { getAssistantMessageContentLength } from '../tokens.js';
import { createAgentId } from '../uuid.js';
import { getWorkload } from '../workloadContext.js';
import type { ProcessUserInputBaseResult, ProcessUserInputContext } from './processUserInput.js';

/**
 * `processSlashCommand.tsx` 负责把 `/xxx` 形式的输入解析、分流并执行。
 *
 * 这里覆盖了几类核心场景：
 * - 普通本地 slash command；
 * - 需要 fork 到子 agent 执行的 prompt 命令；
 * - local / local-jsx / prompt 三种命令类型的统一调度；
 * - skill / 插件命令的埋点、权限与元数据拼装；
 * - compact 结果、fullscreen UI、coordinator 模式等特殊分支。
 *
 * 可以把它看成“slash command 专用调度中心”：
 * 用户在输入框里敲下 `/command args` 之后，
 * 这里决定到底是：
 * - 本地立即执行，
 * - 渲染一个临时 UI，
 * - 还是转成一段 prompt/skill 内容继续交给模型。
 */
type SlashCommandResult = ProcessUserInputBaseResult & {
  command: Command;
};

// 在后台拉起 forked 子 agent 之前，用这组参数等待 MCP 先稳定下来。
// 一般来说，MCP 服务会在启动后 1~3 秒内连上；这里额外留出 10 秒余量，
// 用来覆盖较慢的 SSE 握手场景。
const MCP_SETTLE_POLL_MS = 200;
const MCP_SETTLE_TIMEOUT_MS = 10_000;

/**
 * 以“fork 到子 agent”的方式执行 slash command。
 *
 * 这条路径适用于 `context: 'fork'` 的 prompt 命令：
 * 当前主线程不会直接执行技能内容，而是把它交给一个独立子 agent 去跑，
 * 然后再把结果回流到当前会话。
 */
async function executeForkedSlashCommand(command: CommandBase & PromptCommand, args: string, context: ProcessUserInputContext, precedingInputBlocks: ContentBlockParam[], setToolJSX: SetToolJSXFn, canUseTool: CanUseToolFn): Promise<SlashCommandResult> {
  const agentId = createAgentId();
  const pluginMarketplace = command.pluginInfo ? parsePluginIdentifier(command.pluginInfo.repository).marketplace : undefined;
  logEvent('tengu_slash_command_forked', {
    command_name: command.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    invocation_trigger: 'user-slash' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(command.pluginInfo && {
      _PROTO_plugin_name: command.pluginInfo.pluginManifest.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(pluginMarketplace && {
        _PROTO_marketplace_name: pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED
      }),
      ...buildPluginCommandTelemetryFields(command.pluginInfo)
    })
  });
  const {
    skillContent,
    modifiedGetAppState,
    baseAgent,
    promptMessages
  } = await prepareForkedCommandContext(command, args, context);

  // 如果 skill 自己声明了 `effort`，就在这里把它并入 agent 定义，
  // 这样 `runAgent()` 才会真正按该 effort 执行。
  const agentDefinition = command.effort !== undefined ? {
    ...baseAgent,
    effort: command.effort
  } : baseAgent;
  logForDebugging(`Executing forked slash command /${command.name} with agent ${agentDefinition.agentType}`);

  // 在 Assistant 模式下，这里走“即发即忘”的后台执行路径：
  // 后台拉起子 agent 后立即返回，等子 agent 跑完，再把结果重新排队成一条 `isMeta` prompt。
  //
  // 如果不这么做，启动时的 N 个定时任务会变成 N 轮串行流程：
  // 每个任务都要经历“子 agent 执行 + 主 agent 再消费结果”，用户输入会被整段阻塞。
  // 改成后台并发后，N 个子 agent 可以同时运行，结果谁先完成就谁先回流进队列。
  //
  // 这里只在 `kairosEnabled` 下启用（而不是单看 `CLAUDE_CODE_BRIEF`），
  // 因为这条闭环依赖 assistant 模式的一组前提：
  // - `scheduled_tasks.json` 存在；
  // - 主 agent 知道如何通过 `SendUserMessage` 回灌结果；
  // - `isMeta` prompt 对用户隐藏。
  //
  // 离开 assistant 模式后，`context:fork` 命令通常是用户主动触发的技能（如 `/commit`），
  // 这类命令应当同步执行，并配合进度 UI 反馈。
  if (feature('KAIROS') && (await context.getAppState()).kairosEnabled) {
    // 使用独立的 abortController：
    // 后台子 agent 不会因为主线程按下 ESC 就一起被杀掉（与 AgentTool 的异步路径策略一致）。
    // 它们本来就是定时任务驱动的；即便中途被杀，下一个调度周期也会再触发。
    const bgAbortController = createAbortController();
    const commandName = getCommandName(command);

    // 关于 workload：`handlePromptSubmit` 会用 `runWithWorkload`
    // （底层是 AsyncLocalStorage）包住整轮处理。当前这个 `void` 启动时，
    // 这里捕获的 AsyncLocalStorage 上下文，会贯穿其内部所有 await，
    // 并与父流程后续执行保持隔离。
    //
    // 因此，这个分离出去的闭包里调用 `runAgent()` 时，会天然继承 cron workload 标签。
    // 但我们仍要把 workload 值单独抓出来，供下面“重新入队的结果 prompt”使用：
    // 因为那已经是下一轮新的 `handlePromptSubmit -> runWithWorkload` 边界了，
    // 需要通过 `QueuedCommand.workload` 自己保留归因。
    const spawnTimeWorkload = getWorkload();

    // 以隐藏 prompt 的形式重新入队：
    // - `isMeta`：隐藏队列预览、placeholder 和 transcript；
    // - `skipSlashCommands`：避免结果文本恰好以 `/` 开头时再次被当成 slash command 解析。
    //
    // 队列被 drain 时，会触发主 agent 新的一轮 turn：
    // 它读到这条结果后，再决定是否要 `SendUserMessage`。
    // 同时把 workload 一并传过去，保证第二轮也保留正确标签。
    const enqueueResult = (value: string): void => enqueuePendingNotification({
      value,
      mode: 'prompt',
      priority: 'later',
      isMeta: true,
      skipSlashCommands: true,
      workload: spawnTimeWorkload
    });
    void (async () => {
      // 等待 MCP 服务稳定下来。
      // 定时任务会在启动时一起触发；由于这里是立即返回，N 个任务会在 ~1ms 内几乎同时被 drain，
      // 很容易在 MCP 真正连上之前就把 `context.options.tools` 抓走。
      //
      // 旧的同步路径反而“误打误撞”避开了这个问题：
      // 因为任务是串行执行的，等到第 N 个任务开始 drain 时，前一个任务可能已经跑了 30 秒，
      // 这时 MCP 早就连好了。
      //
      // 所以这里改成轮询等待：直到没有 `pending` client，再刷新工具列表。
      const deadline = Date.now() + MCP_SETTLE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const s = context.getAppState();
        if (!s.mcp.clients.some(c => c.type === 'pending')) break;
        await sleep(MCP_SETTLE_POLL_MS);
      }
      const freshTools = context.options.refreshTools?.() ?? context.options.tools;
      const agentMessages: Message[] = [];
      for await (const message of runAgent({
        agentDefinition,
        promptMessages,
        toolUseContext: {
          ...context,
          getAppState: modifiedGetAppState,
          abortController: bgAbortController
        },
        canUseTool,
        isAsync: true,
        querySource: 'agent:custom',
        model: command.model as ModelAlias | undefined,
        availableTools: freshTools,
        override: {
          agentId
        }
      })) {
        agentMessages.push(message);
      }
      const resultText = extractResultText(agentMessages, 'Command completed');
      logForDebugging(`Background forked command /${commandName} completed (agent ${agentId})`);
      enqueueResult(`<scheduled-task-result command="/${commandName}">\n${resultText}\n</scheduled-task-result>`);
    })().catch(err => {
      logError(err);
      enqueueResult(`<scheduled-task-result command="/${commandName}" status="failed">\n${err instanceof Error ? err.message : String(err)}\n</scheduled-task-result>`);
    });

    // 这里不需要渲染任何东西，也不需要继续 query。
    // 后台执行器会在完成后按自己的节奏重新把结果放回队列。
    return {
      messages: [],
      shouldQuery: false,
      command
    };
  }

  // 收集 forked 子 agent 产出的全部消息。
  const agentMessages: Message[] = [];

  // 为 agent 进度 UI 构造进度消息流。
  const progressMessages: ProgressMessage<AgentProgress>[] = [];
  const parentToolUseID = `forked-command-${command.name}`;
  let toolUseCounter = 0;

  // 辅助函数：把 agent 消息包装成一条可渲染的进度消息。
  const createProgressMessage = (message: AssistantMessage | NormalizedUserMessage): ProgressMessage<AgentProgress> => {
    toolUseCounter++;
    return {
      type: 'progress',
      data: {
        message,
        type: 'agent_progress',
        prompt: skillContent,
        agentId
      },
      parentToolUseID,
      toolUseID: `${parentToolUseID}-${toolUseCounter}`,
      timestamp: new Date().toISOString(),
      uuid: randomUUID()
    };
  };

  // 辅助函数：使用 agent progress UI 刷新当前进度展示。
  const updateProgress = (): void => {
    setToolJSX({
      jsx: renderToolUseProgressMessage(progressMessages, {
        tools: context.options.tools,
        verbose: false
      }),
      shouldHidePromptInput: false,
      shouldContinueAnimation: true,
      showSpinner: true
    });
  };

  // 先展示初始的 “Initializing…” 状态。
  updateProgress();

  // 正式运行子 agent。
  try {
    for await (const message of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: {
        ...context,
        getAppState: modifiedGetAppState
      },
      canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      model: command.model as ModelAlias | undefined,
      availableTools: context.options.tools
    })) {
      agentMessages.push(message);
      const normalizedNew = normalizeMessages([message]);

      // `assistant` 消息通常包含 `tool_use`，因此把它同步加入进度流。
      if (message.type === 'assistant') {
        // `assistant` 消息带来的文本长度，会累加到 spinner 的 token 统计里。
        const contentLength = getAssistantMessageContentLength(message);
        if (contentLength > 0) {
          context.setResponseLength(len => len + contentLength);
        }
        const normalizedMsg = normalizedNew[0];
        if (normalizedMsg && normalizedMsg.type === 'assistant') {
          progressMessages.push(createProgressMessage(message));
          updateProgress();
        }
      }

      // `user` 消息通常承载 `tool_result`，同样也要加入进度流。
      if (message.type === 'user') {
        const normalizedMsg = normalizedNew[0];
        if (normalizedMsg && normalizedMsg.type === 'user') {
          progressMessages.push(createProgressMessage(normalizedMsg));
          updateProgress();
        }
      }
    }
  } finally {
    // 收尾时清理进度展示。
    setToolJSX(null);
  }
  let resultText = extractResultText(agentMessages, 'Command completed');
  logForDebugging(`Forked slash command /${command.name} completed with agent ${agentId}`);

  // 对 ant 用户，把调试日志前置到命令输出里，便于直接在结果中查看。
  if ("external" === 'ant') {
    resultText = `[ANT-ONLY] API calls: ${getDisplayPath(getDumpPromptsPath(agentId))}\n${resultText}`;
  }

  // 把结果包装成用户消息返回，模拟“agent 已把结果发回当前会话”。
  const messages: UserMessage[] = [createUserMessage({
    content: prepareUserContent({
      inputString: `/${getCommandName(command)} ${args}`.trim(),
      precedingInputBlocks
    })
  }), createUserMessage({
    content: `<local-command-stdout>\n${resultText}\n</local-command-stdout>`
  })];
  return {
    messages,
    shouldQuery: false,
    command,
    resultText
  };
}

/**
 * 判断一个字符串是否“看起来像合法命令名”。
 *
 * 合法命令名只允许包含：
 * - 字母
 * - 数字
 * - 冒号
 * - 连字符
 * - 下划线
 *
 * @param commandName 待检查的命令名候选值
 * @returns 若像命令名则返回 `true`；如果含有明显不属于命令名的字符，则返回 `false`
 */
export function looksLikeCommand(commandName: string): boolean {
  // 命令名理论上只应包含 `[a-zA-Z0-9:_-]`。
  // 一旦出现其他字符，更可能是文件路径或普通输入，而不是 slash command。
  return !/[^a-zA-Z0-9:\-_]/.test(commandName);
}

/**
 * 处理用户直接输入的 slash command 文本。
 *
 * 这一层负责：
 * - 解析 `/command args` 结构；
 * - 判断它到底是有效命令、非法命令，还是其实更像普通 prompt；
 * - 调用 `getMessagesForSlashCommand()` 取得真正的执行结果；
 * - 统一处理埋点、synthetic caveat、插件元数据与 compact 结果排序。
 */
export async function processSlashCommand(inputString: string, precedingInputBlocks: ContentBlockParam[], imageContentBlocks: ContentBlockParam[], attachmentMessages: AttachmentMessage[], context: ProcessUserInputContext, setToolJSX: SetToolJSXFn, uuid?: string, isAlreadyProcessing?: boolean, canUseTool?: CanUseToolFn): Promise<ProcessUserInputBaseResult> {
  const parsed = parseSlashCommand(inputString);
  if (!parsed) {
    logEvent('tengu_input_slash_missing', {});
    const errorMessage = 'Commands are in the form `/command [args]`';
    return {
      messages: [createSyntheticUserCaveatMessage(), ...attachmentMessages, createUserMessage({
        content: prepareUserContent({
          inputString: errorMessage,
          precedingInputBlocks
        })
      })],
      shouldQuery: false,
      resultText: errorMessage
    };
  }
  const {
    commandName,
    args: parsedArgs,
    isMcp
  } = parsed;
  const sanitizedCommandName = isMcp ? 'mcp' : !builtInCommandNames().has(commandName) ? 'custom' : commandName;

  // 在真正处理前，先确认它是不是一个真实存在的命令。
  if (!hasCommand(commandName, context.options.commands)) {
    // 先判断它更像是命令名，还是文件路径/其他普通输入；
    // 同时也顺手检查对应文件路径是否真实存在。
    let isFilePath = false;
    try {
      await getFsImplementation().stat(`/${commandName}`);
      isFilePath = true;
    } catch {
      // 不是有效文件路径，那就按命令名处理。
    }
    if (looksLikeCommand(commandName) && !isFilePath) {
      logEvent('tengu_input_slash_invalid', {
        input: commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      const unknownMessage = `Unknown skill: ${commandName}`;
      return {
        messages: [createSyntheticUserCaveatMessage(), ...attachmentMessages, createUserMessage({
          content: prepareUserContent({
            inputString: unknownMessage,
            precedingInputBlocks
          })
        }),
        // 兼容 gh-32591：保留原始参数，方便用户直接复制或再次提交，不必手敲。
        // 这条 system warning 只作用于 UI，进入 API 前会被过滤掉。
        ...(parsedArgs ? [createSystemMessage(`Args from unknown skill: ${parsedArgs}`, 'warning')] : [])],
        shouldQuery: false,
        resultText: unknownMessage
      };
    }
    const promptId = randomUUID();
    setPromptId(promptId);
    logEvent('tengu_input_prompt', {});
    // 为 OTLP 记录一次用户 prompt 事件。
    void logOTelEvent('user_prompt', {
      prompt_length: String(inputString.length),
      prompt: redactIfDisabled(inputString),
      'prompt.id': promptId
    });
    return {
      messages: [createUserMessage({
        content: prepareUserContent({
          inputString,
          precedingInputBlocks
        }),
        uuid: uuid
      }), ...attachmentMessages],
      shouldQuery: true
    };
  }

  // 记录 slash command 使用情况，供功能发现与排序参考。

  const {
    messages: newMessages,
    shouldQuery: messageShouldQuery,
    allowedTools,
    model,
    effort,
    command: returnedCommand,
    resultText,
    nextInput,
    submitNextInput
  } = await getMessagesForSlashCommand(commandName, parsedArgs, setToolJSX, context, precedingInputBlocks, imageContentBlocks, isAlreadyProcessing, canUseTool, uuid);

  // 对于那些本地执行且不会产生日志消息的 slash command，走这里的快速返回分支。
  if (newMessages.length === 0) {
    const eventData: Record<string, boolean | number | undefined> = {
      input: sanitizedCommandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    };

    // 如果这是一个插件命令，就把插件相关元数据一并带上。
    if (returnedCommand.type === 'prompt' && returnedCommand.pluginInfo) {
      const {
        pluginManifest,
        repository
      } = returnedCommand.pluginInfo;
      const {
        marketplace
      } = parsePluginIdentifier(repository);
      const isOfficial = isOfficialMarketplaceName(marketplace);
      // `_PROTO_*` 字段会进入带 PII 标签的 plugin_name / marketplace_name BQ 列
      // （不脱敏、全量用户可用）；而 `plugin_name` / `plugin_repository`
      // 则保留在 `additional_metadata` 中，作为面向通用看板的脱敏版本。
      eventData._PROTO_plugin_name = pluginManifest.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED;
      if (marketplace) {
        eventData._PROTO_marketplace_name = marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED;
      }
      eventData.plugin_repository = (isOfficial ? repository : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
      eventData.plugin_name = (isOfficial ? pluginManifest.name : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
      if (isOfficial && pluginManifest.version) {
        eventData.plugin_version = pluginManifest.version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
      }
      Object.assign(eventData, buildPluginCommandTelemetryFields(returnedCommand.pluginInfo));
    }
    logEvent('tengu_input_command', {
      ...eventData,
      invocation_trigger: 'user-slash' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...("external" === 'ant' && {
        skill_name: commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(returnedCommand.type === 'prompt' && {
          skill_source: returnedCommand.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        }),
        ...(returnedCommand.loadedFrom && {
          skill_loaded_from: returnedCommand.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        }),
        ...(returnedCommand.kind && {
          skill_kind: returnedCommand.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        })
      })
    });
    return {
      messages: [],
      shouldQuery: false,
      model,
      nextInput,
      submitNextInput
    };
  }

  // 对于非法命令，同时保留原始用户消息和错误消息。
  if (newMessages.length === 2 && newMessages[1]!.type === 'user' && typeof newMessages[1]!.message.content === 'string' && newMessages[1]!.message.content.startsWith('Unknown command:')) {
    // 如果它看起来像常见文件路径，就不要按“非法命令”打点。
    const looksLikeFilePath = inputString.startsWith('/var') || inputString.startsWith('/tmp') || inputString.startsWith('/private');
    if (!looksLikeFilePath) {
      logEvent('tengu_input_slash_invalid', {
        input: commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
    }
    return {
      messages: [createSyntheticUserCaveatMessage(), ...newMessages],
      shouldQuery: messageShouldQuery,
      allowedTools,
      model
    };
  }

  // 走到这里，说明这是一个有效命令。
  const eventData: Record<string, boolean | number | undefined> = {
    input: sanitizedCommandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  };

  // 如果这是插件命令，就补充插件元数据。
  if (returnedCommand.type === 'prompt' && returnedCommand.pluginInfo) {
    const {
      pluginManifest,
      repository
    } = returnedCommand.pluginInfo;
    const {
      marketplace
    } = parsePluginIdentifier(repository);
    const isOfficial = isOfficialMarketplaceName(marketplace);
    eventData._PROTO_plugin_name = pluginManifest.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED;
    if (marketplace) {
      eventData._PROTO_marketplace_name = marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED;
    }
    eventData.plugin_repository = (isOfficial ? repository : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    eventData.plugin_name = (isOfficial ? pluginManifest.name : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    if (isOfficial && pluginManifest.version) {
      eventData.plugin_version = pluginManifest.version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    }
    Object.assign(eventData, buildPluginCommandTelemetryFields(returnedCommand.pluginInfo));
  }
  logEvent('tengu_input_command', {
    ...eventData,
    invocation_trigger: 'user-slash' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...("external" === 'ant' && {
      skill_name: commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(returnedCommand.type === 'prompt' && {
        skill_source: returnedCommand.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      ...(returnedCommand.loadedFrom && {
        skill_loaded_from: returnedCommand.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      ...(returnedCommand.kind && {
        skill_kind: returnedCommand.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      })
    })
  });

  // 检查这是不是 compact 结果。
  // 这类结果会自行处理 synthetic caveat message 的排序，因此这里不要额外打乱顺序。
  const isCompactResult = newMessages.length > 0 && newMessages[0] && isCompactBoundaryMessage(newMessages[0]);
  return {
    messages: messageShouldQuery || newMessages.every(isSystemLocalCommandMessage) || isCompactResult ? newMessages : [createSyntheticUserCaveatMessage(), ...newMessages],
    shouldQuery: messageShouldQuery,
    allowedTools,
    model,
    effort,
    resultText,
    nextInput,
    submitNextInput
  };
}

/**
 * 根据命令名拿到 slash command 的最终消息结果。
 *
 * 这是 slash command 的“二次分发层”：
 * - 先拿到命令定义；
 * - 再按 `local-jsx` / `local` / `prompt` 三种类型分别处理；
 * - 并统一处理用户是否可调用、异常、中断与返回值包装。
 */
async function getMessagesForSlashCommand(commandName: string, args: string, setToolJSX: SetToolJSXFn, context: ProcessUserInputContext, precedingInputBlocks: ContentBlockParam[], imageContentBlocks: ContentBlockParam[], _isAlreadyProcessing?: boolean, canUseTool?: CanUseToolFn, uuid?: string): Promise<SlashCommandResult> {
  const command = getCommand(commandName, context.options.commands);

  // 记录 skill 使用频率，供排序参考（仅限用户可直接调用的 prompt 命令）。
  if (command.type === 'prompt' && command.userInvocable !== false) {
    recordSkillUsage(commandName);
  }

  // 检查该命令是否允许用户直接调用。
  // `userInvocable === false` 的 skill 只能由模型通过 `SkillTool` 间接触发。
  if (command.userInvocable === false) {
    return {
      messages: [createUserMessage({
        content: prepareUserContent({
          inputString: `/${commandName}`,
          precedingInputBlocks
        })
      }), createUserMessage({
        content: `This skill can only be invoked by Claude, not directly by users. Ask Claude to use the "${commandName}" skill for you.`
      })],
      shouldQuery: false,
      command
    };
  }
  try {
    switch (command.type) {
      case 'local-jsx':
        {
          return new Promise<SlashCommandResult>(resolve => {
            let doneWasCalled = false;
            const onDone = (result?: string, options?: {
              display?: CommandResultDisplay;
              shouldQuery?: boolean;
              metaMessages?: string[];
              nextInput?: string;
              submitNextInput?: boolean;
            }) => {
              doneWasCalled = true;
              // 如果 `display === 'skip'`，就不要把任何消息写进会话。
              if (options?.display === 'skip') {
                void resolve({
                  messages: [],
                  shouldQuery: false,
                  command,
                  nextInput: options?.nextInput,
                  submitNextInput: options?.submitNextInput
                });
                return;
              }

              // `metaMessages` 对模型可见，但对用户隐藏。
              const metaMessages = (options?.metaMessages ?? []).map((content: string) => createUserMessage({
                content,
                isMeta: true
              }));

              // 在 fullscreen 模式下，命令通常已经以居中的 modal 面板展示过了，
              // 因此一条瞬时通知就足够作为反馈。
              //
              // 类似“❯ /config” 与 “⎿ dismissed” 这类 transcript 记录属于
              // `type:system subtype:local_command`：
              // - 对用户可见
              // - 但不会发给模型
              // 所以跳过它们不会影响模型上下文。
              //
              // 离开 fullscreen 后则保留这些记录，方便用户从 scrollback 里回看。
              // 这里仅跳过 “<Name> dismissed” 这种 modal 关闭提示；
              // 那些在显示 modal 前就提前退出的命令（如 `/ultraplan` 用法提示、`/rename`、`/proactive`）
              // 仍会通过 `display:system` 输出真正需要写入 transcript 的内容。
              const skipTranscript = isFullscreenEnvEnabled() && typeof result === 'string' && result.endsWith(' dismissed');
              void resolve({
                messages: options?.display === 'system' ? skipTranscript ? metaMessages : [createCommandInputMessage(formatCommandInput(command, args)), createCommandInputMessage(`<local-command-stdout>${result}</local-command-stdout>`), ...metaMessages] : [createUserMessage({
                  content: prepareUserContent({
                    inputString: formatCommandInput(command, args),
                    precedingInputBlocks
                  })
                }), result ? createUserMessage({
                  content: `<local-command-stdout>${result}</local-command-stdout>`
                }) : createUserMessage({
                  content: `<local-command-stdout>${NO_CONTENT_MESSAGE}</local-command-stdout>`
                }), ...metaMessages],
                shouldQuery: options?.shouldQuery ?? false,
                command,
                nextInput: options?.nextInput,
                submitNextInput: options?.submitNextInput
              });
            };
            void command.load().then(mod => mod.call(onDone, {
              ...context,
              canUseTool
            }, args)).then(jsx => {
              if (jsx == null) return;
              if (context.options.isNonInteractiveSession) {
                void resolve({
                  messages: [],
                  shouldQuery: false,
                  command
                });
                return;
              }
              // 保护逻辑：如果 `mod.call()` 执行过程中已经先触发了 `onDone`
              // （即先完成回调、随后又返回 JSX 的提前退出路径），这里就不要再调用 `setToolJSX`。
              //
              // 原因是这条链路本身是 fire-and-forget：外层 Promise 会在 `onDone` 时直接 resolve，
              // 因此 `executeUserInput` 很可能已经先执行过 `setToolJSX({ clearLocalJSX: true })`。
              // 如果此时又把 `isLocalJSXCommand` 设回去，就会导致它卡在 `true`，
              // 进而阻塞 `useQueueProcessor` 和 `TextInput` 焦点恢复。
              if (doneWasCalled) return;
              setToolJSX({
                jsx,
                shouldHidePromptInput: true,
                showSpinner: false,
                isLocalJSXCommand: true,
                isImmediate: command.immediate === true
              });
            }).catch(e => {
              // 如果 `load()` / `call()` 抛错，且 `onDone` 从未触发，
              // 外层 Promise 就会永久悬挂，导致 `queryGuard` 卡在 `dispatching`，
              // 最终把整个队列处理器一起拖死。
              logError(e);
              if (doneWasCalled) return;
              doneWasCalled = true;
              setToolJSX({
                jsx: null,
                shouldHidePromptInput: false,
                clearLocalJSX: true
              });
              void resolve({
                messages: [],
                shouldQuery: false,
                command
              });
            });
          });
        }
      case 'local':
        {
          const displayArgs = command.isSensitive && args.trim() ? '***' : args;
          const userMessage = createUserMessage({
            content: prepareUserContent({
              inputString: formatCommandInput(command, displayArgs),
              precedingInputBlocks
            })
          });
          try {
            const syntheticCaveatMessage = createSyntheticUserCaveatMessage();
            const mod = await command.load();
            const result = await mod.call(args, context);
            if (result.type === 'skip') {
              return {
                messages: [],
                shouldQuery: false,
                command
              };
            }

            // 使用判别联合类型，分别处理不同种类的返回结果。
            if (result.type === 'compact') {
              // 把 slash command 产生的消息追加进 `messagesToKeep`，
              // 这样 attachments 与 hookResults 就会自然排在用户消息之后。
              const slashCommandMessages = [syntheticCaveatMessage, userMessage, ...(result.displayText ? [createUserMessage({
                content: `<local-command-stdout>${result.displayText}</local-command-stdout>`,
                // `--resume` 会读取“时间戳最新”的那条消息，来判断应该从哪里继续恢复。
                // 这是一个性能优化，用来避免每次都重新计算叶子节点。
                // 由于 compact 会生成一批 synthetic message，
                // 因此这里必须把最后一条消息的时间戳略微调到“当前时间之后一点点”。
                // 这对 SDK / `-p` 模式尤其重要。
                timestamp: new Date(Date.now() + 100).toISOString()
              })] : [])];
              const compactionResultWithSlashMessages = {
                ...result.compactionResult,
                messagesToKeep: [...(result.compactionResult.messagesToKeep ?? []), ...slashCommandMessages]
              };
              // `full compact` 会整体替换消息，因此需要重置 microcompact 状态；
              // 旧的 tool ID 已经不再有意义。
              //
              // 预算状态（挂在 `toolUseContext` 上）则不需要重置：
              // 即便残留旧条目，它们也是惰性的，因为 UUID 不会重复，自然也不会再被命中。
              resetMicrocompactState();
              return {
                messages: buildPostCompactMessages(compactionResultWithSlashMessages),
                shouldQuery: false,
                command
              };
            }

            // 文本结果走 system message，避免它被渲染成用户气泡。
            return {
              messages: [userMessage, createCommandInputMessage(`<local-command-stdout>${result.value}</local-command-stdout>`)],
              shouldQuery: false,
              command,
              resultText: result.value
            };
          } catch (e) {
            logError(e);
            return {
              messages: [userMessage, createCommandInputMessage(`<local-command-stderr>${String(e)}</local-command-stderr>`)],
              shouldQuery: false,
              command
            };
          }
        }
      case 'prompt':
        {
          try {
            // 检查该命令是否应以 forked 子 agent 方式执行。
            if (command.context === 'fork') {
              return await executeForkedSlashCommand(command, args, context, precedingInputBlocks, setToolJSX, canUseTool ?? hasPermissionsToUseTool);
            }
            return await getMessagesForPromptSlashCommand(command, args, context, precedingInputBlocks, imageContentBlocks, uuid);
          } catch (e) {
            // 对中断错误做特殊处理，确保界面能显示正确的 “Interrupted” 提示。
            if (e instanceof AbortError) {
              return {
                messages: [createUserMessage({
                  content: prepareUserContent({
                    inputString: formatCommandInput(command, args),
                    precedingInputBlocks
                  })
                }), createUserInterruptionMessage({
                  toolUse: false
                })],
                shouldQuery: false,
                command
              };
            }
            return {
              messages: [createUserMessage({
                content: prepareUserContent({
                  inputString: formatCommandInput(command, args),
                  precedingInputBlocks
                })
              }), createUserMessage({
                content: `<local-command-stderr>${String(e)}</local-command-stderr>`
              })],
              shouldQuery: false,
              command
            };
          }
        }
    }
  } catch (e) {
    if (e instanceof MalformedCommandError) {
      return {
        messages: [createUserMessage({
          content: prepareUserContent({
            inputString: e.message,
            precedingInputBlocks
          })
        })],
        shouldQuery: false,
        command
      };
    }
    throw e;
  }
}
function formatCommandInput(command: CommandBase, args: string): string {
  return formatCommandInputTags(getCommandName(command), args);
}

/**
 * 生成 skill 加载消息所需的元数据。
 *
 * 这份元数据既会被 Skill tool 使用，
 * 也会被子 agent 的 skill 预加载流程复用。
 */
export function formatSkillLoadingMetadata(skillName: string, _progressMessage: string = 'loading'): string {
  // 这里只使用 skill 名称本身；`UserCommandMessage` 会把它渲染成 `Skill(name)`。
  return [`<${COMMAND_MESSAGE_TAG}>${skillName}</${COMMAND_MESSAGE_TAG}>`, `<${COMMAND_NAME_TAG}>${skillName}</${COMMAND_NAME_TAG}>`, `<skill-format>true</skill-format>`].join('\n');
}

/**
 * 生成 slash command 加载消息所需的元数据。
 */
function formatSlashCommandLoadingMetadata(commandName: string, args?: string): string {
  return [`<${COMMAND_MESSAGE_TAG}>${commandName}</${COMMAND_MESSAGE_TAG}>`, `<${COMMAND_NAME_TAG}>/${commandName}</${COMMAND_NAME_TAG}>`, args ? `<command-args>${args}</command-args>` : null].filter(Boolean).join('\n');
}

/**
 * 统一生成命令（skill 或 slash command）的加载元数据。
 *
 * 规则是：
 * - 用户可调用的 skill 使用 slash command 形式（`/name`）；
 * - 仅模型可调用的 skill 使用 skill 形式（例如 “The X skill is running”）。
 */
function formatCommandLoadingMetadata(command: CommandBase & PromptCommand, args?: string): string {
  // 这里使用 `command.name`（带插件前缀的完整限定名，例如
  // `product-management:feature-spec`），而不是 `userFacingName()`；
  // 后者可能因为 `displayName` 的 fallback 把插件前缀剥掉。
  //
  // 用户可调用的 skill 应当像普通 slash command 一样显示成 `/command-name`。
  if (command.userInvocable !== false) {
    return formatSlashCommandLoadingMetadata(command.name, args);
  }
  // 仅模型可调用的 skill（`userInvocable: false`）则显示成 “The X skill is running” 这类格式。
  if (command.loadedFrom === 'skills' || command.loadedFrom === 'plugin' || command.loadedFrom === 'mcp') {
    return formatSkillLoadingMetadata(command.name, command.progressMessage);
  }
  return formatSlashCommandLoadingMetadata(command.name, args);
}

/**
 * 供其他路径直接调用的 prompt slash command 包装器。
 *
 * 与 `processSlashCommand()` 不同，这里假设调用方已经明确知道：
 * - 目标命令存在；
 * - 且它必须是 `prompt` 类型。
 *
 * 因此这里的职责更偏“安全包装”：
 * 如果命令不存在或类型不对，立即抛错；
 * 否则直接转交给 `getMessagesForPromptSlashCommand()`。
 */
export async function processPromptSlashCommand(commandName: string, args: string, commands: Command[], context: ToolUseContext, imageContentBlocks: ContentBlockParam[] = []): Promise<SlashCommandResult> {
  const command = findCommand(commandName, commands);
  if (!command) {
    throw new MalformedCommandError(`Unknown command: ${commandName}`);
  }
  if (command.type !== 'prompt') {
    throw new Error(`Unexpected ${command.type} command. Expected 'prompt' command. Use /${commandName} directly in the main conversation.`);
  }
  return getMessagesForPromptSlashCommand(command, args, context, [], imageContentBlocks);
}

/**
 * 把 prompt 类型的 slash command 展开成真正的消息内容。
 *
 * 这里会负责：
 * - 处理 coordinator 模式下的“摘要化 skill 委派”；
 * - 获取 skill / prompt 正文；
 * - 注册 skill hooks；
 * - 记录 skill 调用，供 compaction 恢复；
 * - 拼接主消息、附件与命令权限附件。
 */
async function getMessagesForPromptSlashCommand(command: CommandBase & PromptCommand, args: string, context: ToolUseContext, precedingInputBlocks: ContentBlockParam[] = [], imageContentBlocks: ContentBlockParam[] = [], uuid?: string): Promise<SlashCommandResult> {
  // 在 Coordinator 模式下（且仅限主线程），不去加载完整的 skill 内容和权限。
  // 因为 coordinator 本身只有 Agent + TaskStop 两个工具，
  // 对 coordinator 来说，skill 正文和 `allowedTools` 都没有实际价值。
  // 更合理的做法是发一段摘要，告诉 coordinator 应该如何把这个 skill 委派给 worker。
  //
  // 注意 worker 是 in-process 运行的，并会继承父进程的 `CLAUDE_CODE_COORDINATOR_MODE`；
  // 因此这里还要额外判断 `!context.agentId`：
  // `agentId` 只会在真正的子 agent 上出现，这样 worker 在调用 Skill tool 时，
  // 仍会自然落到 `getPromptForCommand()`，拿到完整 skill 内容。
  if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) && !context.agentId) {
    const metadata = formatCommandLoadingMetadata(command, args);
    const parts: string[] = [`Skill "/${command.name}" is available for workers.`];
    if (command.description) {
      parts.push(`Description: ${command.description}`);
    }
    if (command.whenToUse) {
      parts.push(`When to use: ${command.whenToUse}`);
    }
    const skillAllowedTools = command.allowedTools ?? [];
    if (skillAllowedTools.length > 0) {
      parts.push(`This skill grants workers additional tool permissions: ${skillAllowedTools.join(', ')}`);
    }
    parts.push(`\nInstruct a worker to use this skill by including "Use the /${command.name} skill" in your Agent prompt. The worker has access to the Skill tool and will receive the skill's content and permissions when it invokes it.`);
    const summaryContent: ContentBlockParam[] = [{
      type: 'text',
      text: parts.join('\n')
    }];
    return {
      messages: [createUserMessage({
        content: metadata,
        uuid
      }), createUserMessage({
        content: summaryContent,
        isMeta: true
      })],
      shouldQuery: true,
      model: command.model,
      effort: command.effort,
      command
    };
  }
  const result = await command.getPromptForCommand(args, context);

  // 如果 skill 定义了 hooks，就在这里注册。
  //
  // 但在 `["hooks"]-only` 模式下（即 skill 本体未锁，但 hooks 被单独控制），
  // 用户 skill 依然可能被加载并走到这里；因此真正拦截“是否允许注册 hook”，
  // 必须放在这个已知 source 的位置处理。
  // 这里与 `runAgent.ts` 中 frontmatter 的 gate 逻辑保持一致。
  const hooksAllowedForThisSkill = !isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(command.source);
  if (command.hooks && hooksAllowedForThisSkill) {
    const sessionId = getSessionId();
    registerSkillHooks(context.setAppState, sessionId, command.hooks, command.name, command.type === 'prompt' ? command.skillRoot : undefined);
  }

  // 记录这次 skill 调用，供 compaction 保留。
  // 这份记录会带上 `agentId`，从而确保 compact 恢复时只还原当前 agent 自己的 skill，
  // 避免跨 agent 泄漏。
  const skillPath = command.source ? `${command.source}:${command.name}` : command.name;
  const skillContent = result.filter((b): b is TextBlockParam => b.type === 'text').map(b => b.text).join('\n\n');
  addInvokedSkill(command.name, skillPath, skillContent, getAgentContext()?.agentId ?? null);
  const metadata = formatCommandLoadingMetadata(command, args);
  const additionalAllowedTools = parseToolListFromCLI(command.allowedTools ?? []);

  // 构造主消息内容，并把粘贴图片等前置内容一并拼进去。
  const mainMessageContent: ContentBlockParam[] = imageContentBlocks.length > 0 || precedingInputBlocks.length > 0 ? [...imageContentBlocks, ...precedingInputBlocks, ...result] : result;

  // 从命令参数中提取附件：例如 @ 提及、MCP 资源，以及 `SKILL.md` 里的 agent mention。
  // 开启 `skipSkillDiscovery` 是为了防止 `SKILL.md` 正文本身再次触发 skill discovery。
  // 因为这些内容只是元信息，不代表真实用户意图；
  // 如果一个很大的 `SKILL.md`（例如 110KB）也被拿去做 chunked AKI 查询，
  // 每次技能调用都会平白增加数秒延迟。
  const attachmentMessages = await toArray(getAttachmentMessages(result.filter((block): block is TextBlockParam => block.type === 'text').map(block => block.text).join(' '), context, null, [],
  // `queuedCommands` 会由 `query.ts` 在中途附件路径统一处理，这里不重复接管。
  context.messages, 'repl_main_thread', {
    skipSkillDiscovery: true
  }));
  const messages = [createUserMessage({
    content: metadata,
    uuid
  }), createUserMessage({
    content: mainMessageContent,
    isMeta: true
  }), ...attachmentMessages, createAttachmentMessage({
    type: 'command_permissions',
    allowedTools: additionalAllowedTools,
    model: command.model
  })];
  return {
    messages,
    shouldQuery: true,
    allowedTools: additionalAllowedTools,
    model: command.model,
    effort: command.effort,
    command
  };
}
