/**
 * `queryContext.ts` 提供的是“组装 query 上下文前缀”的共享工具。
 *
 * 这里的“上下文前缀”主要指三部分：
 * - `systemPrompt`
 * - `userContext`
 * - `systemContext`
 *
 * 这三者共同决定了模型请求前半段的大部分稳定内容，
 * 同时也是 API 缓存键前缀的重要组成部分。
 *
 * 之所以把这部分逻辑单独放在当前文件里，是为了避开依赖环：
 * - 它需要从 `context.ts` 和 `constants/prompts.ts` 取值；
 * - 这两个模块在依赖图里位置比较靠上；
 * - 如果把这些逻辑塞进 `systemPrompt.ts` 或 `sideQuestion.ts`
 *   （它们都可能被 `commands.ts` 间接触达），就容易形成循环依赖。
 *
 * 因此，这里更像是一个“入口层可复用的上下文拼装站”：
 * 目前主要由 `QueryEngine.ts` 和 `cli/print.ts` 这类入口层文件使用。
 */

import type { Command } from '../commands.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { getSystemContext, getUserContext } from '../context.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../types/message.js'
import { createAbortController } from './abortController.js'
import type { FileStateCache } from './fileStateCache.js'
import type { CacheSafeParams } from './forkedAgent.js'
import { getMainLoopModel } from './model/model.js'
import { asSystemPrompt } from './systemPromptType.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './thinking.js'

/**
 * 取回构成 API 缓存键前缀的三块基础上下文：
 * - 默认 system prompt 片段
 * - `userContext`
 * - `systemContext`
 *
 * 这里返回的是“原始素材”，而不是最终可直接发给模型的完整 prompt。
 * 调用方会在此基础上继续做拼装，例如追加：
 * - 自定义 system prompt
 * - 额外 prompt 片段
 * - `appendSystemPrompt`
 *
 * 需要特别注意 `customSystemPrompt`：
 * - 一旦传入，它就意味着“完全替换默认 system prompt”；
 * - 因此默认的 `getSystemPrompt()` 不再需要执行；
 * - `systemContext` 也不应再参与拼接，因为它本来是附着在默认 prompt 之后的。
 *
 * 不同调用方对返回结果的使用方式略有区别：
 * - `QueryEngine` 会在此基础上继续注入 coordinator 相关的 `userContext`
 *   以及 memory-mechanics prompt；
 * - `sideQuestion` 的 fallback 路径则更保守，通常直接使用这里产出的基础结果。
 */
export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
  customSystemPrompt,
}: {
  tools: Tools
  mainLoopModel: string
  additionalWorkingDirectories: string[]
  mcpClients: MCPServerConnection[]
  customSystemPrompt: string | undefined
}): Promise<{
  defaultSystemPrompt: string[]
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
}> {
  // 三部分可以并行获取：
  // - 默认 prompt 片段
  // - 用户上下文
  // - 系统上下文
  //
  // 如果已经指定了 `customSystemPrompt`，就不再构建默认 prompt，
  // 同时把 `systemContext` 置空，保持“完全替换默认前缀”的语义。
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : getSystemPrompt(
          tools,
          mainLoopModel,
          additionalWorkingDirectories,
          mcpClients,
        ),
    getUserContext(),
    customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
  ])
  return { defaultSystemPrompt, userContext, systemContext }
}

/**
 * 当 `getLastCacheSafeParams()` 为空时，用原始输入重建一份 `CacheSafeParams`。
 *
 * 这个函数主要服务于 SDK 的 `side_question` fallback 场景：
 * - 例如在 `print.ts` 恢复会话时，
 * - 某一轮对话还没真正结束，
 * - `stopHooks` 也还没有留下可复用快照，
 * - 这时就只能临时根据现有输入，把“足够安全的缓存前缀参数”重新拼出来。
 *
 * 它会尽量镜像 `QueryEngine.ts:ask()` 中的 system prompt 组装方式，
 * 目标是让重建出来的前缀尽可能贴近主循环真正会发出的请求，
 * 从而在常见情况下依然命中缓存。
 *
 * 当然，这条 fallback 路径并不保证 100% 与主循环完全一致。
 * 如果主循环额外叠加了这里不知道的上下文（例如 coordinator 模式、
 * 记忆机制相关的补充提示词），缓存仍可能无法命中。
 *
 * 但这是可以接受的：比起“缓存不命中”，更糟的情况是直接返回 `null`
 * 导致 side question 整体失败。
 */
export async function buildSideQuestionFallbackParams({
  tools,
  commands,
  mcpClients,
  messages,
  readFileState,
  getAppState,
  setAppState,
  customSystemPrompt,
  appendSystemPrompt,
  thinkingConfig,
  agents,
}: {
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  messages: Message[]
  readFileState: FileStateCache
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  customSystemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  thinkingConfig: ThinkingConfig | undefined
  agents: AgentDefinition[]
}): Promise<CacheSafeParams> {
  const mainLoopModel = getMainLoopModel()
  const appState = getAppState()

  // 先重建 system prompt / user context / system context 三件套。
  // 这一步是整条 fallback 路径能否尽量贴近主循环请求的关键。
  const { defaultSystemPrompt, userContext, systemContext } =
    await fetchSystemPromptParts({
      tools,
      mainLoopModel,
      additionalWorkingDirectories: Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt,
    })

  // 按照主循环的基本拼装顺序构建最终的 system prompt：
  // 1. 若存在 `customSystemPrompt`，则直接使用它；
  // 2. 否则使用默认 system prompt 片段；
  // 3. 最后再按需拼上 `appendSystemPrompt`。
  const systemPrompt = asSystemPrompt([
    ...(customSystemPrompt !== undefined
      ? [customSystemPrompt]
      : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])

  // 如果最后一条消息是“尚未结束”的 assistant 消息（`stop_reason === null`），
  // 就先把它剥掉，不参与 fallback 上下文。
  //
  // 原因是：SDK 可能会在一个 turn 尚未真正结束时就触发 `side_question`。
  // 这时把半成品 assistant 消息带进去，会让上下文既不稳定，也不利于缓存复用。
  //
  // 这里沿用与 `btw.tsx` 相同的保护逻辑。
  const last = messages.at(-1)
  const forkContextMessages =
    last?.type === 'assistant' && last.message.stop_reason === null
      ? messages.slice(0, -1)
      : messages

  // 这里构造的是一份“最小可用”的 `ToolUseContext`：
  // - 只补齐 side question fallback 真正需要的字段；
  // - 所有会在正常主循环里被动态更新的 setter，这里都用空函数兜底；
  // - 目标不是完整复刻运行时，而是保证缓存安全参数能被顺利组装出来。
  const toolUseContext: ToolUseContext = {
    options: {
      commands,
      debug: false,
      mainLoopModel,
      tools,
      verbose: false,
      thinkingConfig:
        thinkingConfig ??
        (shouldEnableThinkingByDefault() !== false
          ? { type: 'adaptive' }
          : { type: 'disabled' }),
      mcpClients,
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: agents, allAgents: [] },
      customSystemPrompt,
      appendSystemPrompt,
    },
    abortController: createAbortController(),
    readFileState,
    getAppState,
    setAppState,
    messages: forkContextMessages,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }

  // 返回给调用方的就是一份可直接用于缓存安全请求前缀的参数包。
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  }
}
