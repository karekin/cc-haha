import { feature } from 'bun:bundle'
import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import type { QuerySource } from 'src/constants/querySource.js'
import { logEvent } from 'src/services/analytics/index.js'
import { getContentText } from 'src/utils/messages.js'
import {
  findCommand,
  getCommandName,
  isBridgeSafeCommand,
  type LocalJSXCommandContext,
} from '../../commands.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { SetToolJSXFn, ToolUseContext } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import {
  isValidImagePaste,
  type PromptInputMode,
} from '../../types/textInputTypes.js'
import {
  type AgentMentionAttachment,
  createAttachmentMessage,
  getAttachmentMessages,
} from '../attachments.js'
import type { PastedContent } from '../config.js'
import type { EffortValue } from '../effort.js'
import { toArray } from '../generators.js'
import {
  executeUserPromptSubmitHooks,
  getUserPromptSubmitHookBlockingMessage,
} from '../hooks.js'
import {
  createImageMetadataText,
  maybeResizeAndDownsampleImageBlock,
} from '../imageResizer.js'
import { storeImages } from '../imageStore.js'
import {
  createCommandInputMessage,
  createSystemMessage,
  createUserMessage,
} from '../messages.js'
import { queryCheckpoint } from '../queryProfiler.js'
import { parseSlashCommand } from '../slashCommandParsing.js'
import {
  hasUltraplanKeyword,
  replaceUltraplanKeyword,
} from '../ultraplan/keyword.js'
import { processTextPrompt } from './processTextPrompt.js'

/**
 * `processUserInput.ts` 是“原始用户输入进入主循环之前”的总预处理入口。
 *
 * 这层逻辑负责把来自 UI、SDK、Bridge 的输入整理成主循环真正可消费的消息：
 * - 识别输入模式（普通 prompt / slash command / bash）；
 * - 处理粘贴图片、附件与 IDE 选区；
 * - 在合适的情况下本地执行 slash command / bash command；
 * - 执行 `UserPromptSubmit` hooks，并处理阻断与附加上下文；
 * - 最终把输入转换成标准的 `Message[]`。
 *
 * 可以把它理解成“输入装配线”：
 * 原始输入先在这里完成归一化、分流和补充上下文，
 * 然后才决定是继续发给模型，还是直接在本地结束。
 */
export type ProcessUserInputContext = ToolUseContext & LocalJSXCommandContext

export type ProcessUserInputBaseResult = {
  messages: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
    | ProgressMessage
  )[]
  shouldQuery: boolean
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  // 非交互模式（例如 forked command）下的直接输出文本。
  // 一旦设置，`-p` 模式会优先返回这里的内容，而不是空字符串。
  resultText?: string
  // 命令执行完成后，要预填或自动提交的下一条输入。
  // 主要用于 `/discover` 这类需要串联到下一条命令的场景。
  nextInput?: string
  submitNextInput?: boolean
}

/**
 * 对外暴露的用户输入处理入口。
 *
 * 这里主要做两层工作：
 * 1. 先调用 `processUserInputBase()` 完成输入分类与消息组装；
 * 2. 如果结果仍需要继续 query，再执行 `UserPromptSubmit` hooks。
 *
 * 因此它更像“总调度器”，
 * 而 `processUserInputBase()` 更接近底层的输入拆解与归一化核心。
 */
export async function processUserInput({
  input,
  preExpansionInput,
  mode,
  setToolJSX,
  context,
  pastedContents,
  ideSelection,
  messages,
  setUserInputOnProcessing,
  uuid,
  isAlreadyProcessing,
  querySource,
  canUseTool,
  skipSlashCommands,
  bridgeOrigin,
  isMeta,
  skipAttachments,
}: {
  input: string | Array<ContentBlockParam>
  /**
   * `[Pasted text #N]` 展开之前的原始输入。
   *
   * 主要用于 `ultraplan` 关键字检测，避免粘贴内容里恰好包含关键字时误触发。
   * 如果未提供，则回退到当前字符串型 `input`。
   */
  preExpansionInput?: string
  mode: PromptInputMode
  setToolJSX: SetToolJSXFn
  context: ProcessUserInputContext
  pastedContents?: Record<number, PastedContent>
  ideSelection?: IDESelection
  messages?: Message[]
  setUserInputOnProcessing?: (prompt?: string) => void
  uuid?: string
  isAlreadyProcessing?: boolean
  querySource?: QuerySource
  canUseTool?: CanUseToolFn
  /**
   * 为 `true` 时，以 `/` 开头的输入也会被当作普通文本处理。
   *
   * 主要用于远端接收的消息（如 bridge / CCR）：
   * 这些消息不应在本地误触发 slash command 或 skill。
   */
  skipSlashCommands?: boolean
  /**
   * 为 `true` 时，即便 `skipSlashCommands` 已开启，
   * 只要命令通过 `isBridgeSafeCommand()` 检查，仍允许执行。
   *
   * 具体语义见 `QueuedCommand.bridgeOrigin`。
   */
  bridgeOrigin?: boolean
  /**
   * 为 `true` 时，生成出来的 `UserMessage` 会带上 `isMeta: true`：
   * - 对用户隐藏
   * - 但对模型可见
   *
   * 这通常来自 `QueuedCommand.isMeta`，用于系统自动生成的排队提示。
   */
  isMeta?: boolean
  skipAttachments?: boolean
}): Promise<ProcessUserInputBaseResult> {
  const inputString = typeof input === 'string' ? input : null
  // 在输入仍处于预处理阶段时，就尽快把它显示到界面上，
  // 避免用户觉得“按下发送后没有反应”。
  //
  // 但 `isMeta` 场景要跳过：
  // 这类系统自动生成的提示（例如定时任务）本来就应该静默运行。
  if (mode === 'prompt' && inputString !== null && !isMeta) {
    setUserInputOnProcessing?.(inputString)
  }

  queryCheckpoint('query_process_user_input_base_start')

  const appState = context.getAppState()

  const result = await processUserInputBase(
    input,
    mode,
    setToolJSX,
    context,
    pastedContents,
    ideSelection,
    messages,
    uuid,
    isAlreadyProcessing,
    querySource,
    canUseTool,
    appState.toolPermissionContext.mode,
    skipSlashCommands,
    bridgeOrigin,
    isMeta,
    skipAttachments,
    preExpansionInput,
  )
  queryCheckpoint('query_process_user_input_base_end')

  if (!result.shouldQuery) {
    return result
  }

  // 如果基础处理结果仍需要继续 query，
  // 就进入 `UserPromptSubmit` hooks 阶段，检查是否需要阻断或补充上下文。
  queryCheckpoint('query_hooks_start')
  const inputMessage = getContentText(input) || ''

  for await (const hookResult of executeUserPromptSubmitHooks(
    inputMessage,
    appState.toolPermissionContext.mode,
    context,
    context.requestPrompt,
  )) {
    // 这里不关心中间进度消息，只关心 hooks 的最终产物。
    if (hookResult.message?.type === 'progress') {
      continue
    }

    // 如果 hook 明确给出阻断错误，就只返回系统级错误消息，
    // 不再继续沿用原始用户输入。
    if (hookResult.blockingError) {
      const blockingMessage = getUserPromptSubmitHookBlockingMessage(
        hookResult.blockingError,
      )
      return {
        messages: [
          // 后续可改造成 attachment message，便于和普通系统消息区分。
          createSystemMessage(
            `${blockingMessage}\n\nOriginal prompt: ${input}`,
            'warning',
          ),
        ],
        shouldQuery: false,
        allowedTools: result.allowedTools,
      }
    }

    // 如果 hook 设置了 `preventContinuation`，
    // 就停止后续处理，但仍保留原始 prompt 在上下文中的痕迹。
    if (hookResult.preventContinuation) {
      const message = hookResult.stopReason
        ? `Operation stopped by hook: ${hookResult.stopReason}`
        : 'Operation stopped by hook'
      result.messages.push(
        createUserMessage({
          content: message,
        }),
      )
      result.shouldQuery = false
      return result
    }

    // 收集 hook 返回的附加上下文，并把它们封装成 attachment message。
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      result.messages.push(
        createAttachmentMessage({
          type: 'hook_additional_context',
          content: hookResult.additionalContexts.map(applyTruncation),
          hookName: 'UserPromptSubmit',
          toolUseID: `hook-${randomUUID()}`,
          hookEvent: 'UserPromptSubmit',
        }),
      )
    }

    // 历史兼容分支，后续还可以继续收敛整理。
    if (hookResult.message) {
      switch (hookResult.message.attachment.type) {
        case 'hook_success':
          if (!hookResult.message.attachment.content) {
            // 没有正文内容时就不必额外挂消息。
            break
          }
          result.messages.push({
            ...hookResult.message,
            attachment: {
              ...hookResult.message.attachment,
              content: applyTruncation(hookResult.message.attachment.content),
            },
          })
          break
        default:
          result.messages.push(hookResult.message)
          break
      }
    }
  }
  queryCheckpoint('query_hooks_end')

  // 正常路径下，`onQuery` 会通过 `startTransition`
  // 清掉 `userInputOnProcessing`，
  // 从而让它与 `deferredMessages` 在同一帧内完成切换，避免闪烁空档。
  // 错误路径则由 `handlePromptSubmit` 的 `finally` 负责兜底收尾。
  return result
}

const MAX_HOOK_OUTPUT_LENGTH = 10000

/**
 * 对 hook 输出做长度截断，避免超长文本直接灌进会话消息。
 */
function applyTruncation(content: string): string {
  if (content.length > MAX_HOOK_OUTPUT_LENGTH) {
    return `${content.substring(0, MAX_HOOK_OUTPUT_LENGTH)}… [output truncated - exceeded ${MAX_HOOK_OUTPUT_LENGTH} characters]`
  }
  return content
}

/**
 * 用户输入预处理的底层实现。
 *
 * 这部分负责：
 * - 归一化字符串 / 富媒体输入；
 * - 处理粘贴图片与图片元数据；
 * - 分流 bash / slash command / 普通 prompt；
 * - 预先加载附件；
 * - 在需要时走 Bridge-safe slash command、Ultraplan 等特殊路径。
 *
 * 它的任务不是执行完整 query，
 * 而是把“原始输入”转换成“清晰可执行的基础结果”。
 */
async function processUserInputBase(
  input: string | Array<ContentBlockParam>,
  mode: PromptInputMode,
  setToolJSX: SetToolJSXFn,
  context: ProcessUserInputContext,
  pastedContents?: Record<number, PastedContent>,
  ideSelection?: IDESelection,
  messages?: Message[],
  uuid?: string,
  isAlreadyProcessing?: boolean,
  querySource?: QuerySource,
  canUseTool?: CanUseToolFn,
  permissionMode?: PermissionMode,
  skipSlashCommands?: boolean,
  bridgeOrigin?: boolean,
  isMeta?: boolean,
  skipAttachments?: boolean,
  preExpansionInput?: string,
): Promise<ProcessUserInputBaseResult> {
  let inputString: string | null = null
  let precedingInputBlocks: ContentBlockParam[] = []

  // 为后续的 `isMeta` 消息收集图片元数据文本。
  // 这些文本不会直接展示给用户，但会作为模型可见的补充上下文。
  const imageMetadataTexts: string[] = []

  // `normalizedInput` 表示“归一化后的输入视图”：
  // - 如果原始输入是字符串，它就是原值；
  // - 如果原始输入是 block 数组，它就是经过图片缩放/字段标准化后的结果。
  //
  // 后面必须把它传给 `processTextPrompt()`，而不能把原始 `input` 直接传下去，
  // 否则上面做好的图片缩放与归一化就会白费。
  //
  // 这一步也顺手兼容 bridge 输入里 iOS 可能传来的 `mediaType`
  // （而不是标准字段 `media_type`）问题，见 `mobile-apps#5825`。
  let normalizedInput: string | ContentBlockParam[] = input

  if (typeof input === 'string') {
    inputString = input
  } else if (input.length > 0) {
    queryCheckpoint('query_image_processing_start')
    const processedBlocks: ContentBlockParam[] = []
    for (const block of input) {
      if (block.type === 'image') {
        const resized = await maybeResizeAndDownsampleImageBlock(block)
        // 同步收集图片元数据，供后续生成 `isMeta` 补充消息使用。
        if (resized.dimensions) {
          const metadataText = createImageMetadataText(resized.dimensions)
          if (metadataText) {
            imageMetadataTexts.push(metadataText)
          }
        }
        processedBlocks.push(resized.block)
      } else {
        processedBlocks.push(block)
      }
    }
    normalizedInput = processedBlocks
    queryCheckpoint('query_image_processing_end')
    // 如果最后一个 block 是文本，就把它当作“主输入文本”；
    // 前面的 block 则记为前置输入内容。
    const lastBlock = processedBlocks[processedBlocks.length - 1]
    if (lastBlock?.type === 'text') {
      inputString = lastBlock.text
      precedingInputBlocks = processedBlocks.slice(0, -1)
    } else {
      precedingInputBlocks = processedBlocks
    }
  }

  if (inputString === null && mode !== 'prompt') {
    throw new Error(`Mode: ${mode} requires a string input.`)
  }

  // 尽早把粘贴图片筛出来并转成内容块，
  // 同时保留原始 ID，便于后续写入消息存储。
  const imageContents = pastedContents
    ? Object.values(pastedContents).filter(isValidImagePaste)
    : []
  const imagePasteIds = imageContents.map(img => img.id)

  // 先把图片落盘，这样 Claude 后续就能在上下文里引用文件路径，
  // 用于 CLI 工具处理、上传到 PR 等场景。
  const storedImagePaths = pastedContents
    ? await storeImages(pastedContents)
    : new Map<number, string>()

  // 并行缩放粘贴图片，确保它们符合 API 限制。
  queryCheckpoint('query_pasted_image_processing_start')
  const imageProcessingResults = await Promise.all(
    imageContents.map(async pastedImage => {
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (pastedImage.mediaType ||
            'image/png') as Base64ImageSource['media_type'],
          data: pastedImage.content,
        },
      }
      logEvent('tengu_pasted_image_resize_attempt', {
        original_size_bytes: pastedImage.content.length,
      })
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return {
        resized,
        originalDimensions: pastedImage.dimensions,
        sourcePath:
          pastedImage.sourcePath ?? storedImagePaths.get(pastedImage.id),
      }
    }),
  )
  // 按原始顺序收集处理结果，避免图片顺序在消息里错位。
  const imageContentBlocks: ContentBlockParam[] = []
  for (const {
    resized,
    originalDimensions,
    sourcePath,
  } of imageProcessingResults) {
    // 优先使用缩放后的尺寸生成元数据，因为它更接近真正发给模型的图片。
    if (resized.dimensions) {
      const metadataText = createImageMetadataText(
        resized.dimensions,
        sourcePath,
      )
      if (metadataText) {
        imageMetadataTexts.push(metadataText)
      }
    } else if (originalDimensions) {
      // 如果缩放结果没有尺寸信息，就退回使用原图尺寸。
      const metadataText = createImageMetadataText(
        originalDimensions,
        sourcePath,
      )
      if (metadataText) {
        imageMetadataTexts.push(metadataText)
      }
    } else if (sourcePath) {
      // 即便拿不到尺寸，只要有来源路径，也尽量补一条来源说明。
      imageMetadataTexts.push(`[Image source: ${sourcePath}]`)
    }
    imageContentBlocks.push(resized.block)
  }
  queryCheckpoint('query_pasted_image_processing_end')

  // Bridge-safe slash command 例外路径：
  // 移动端 / Web 客户端可能会在 `bridgeOrigin` 为真时，
  // 仍把 `skipSlashCommands` 维持为真，作为一层额外防御，
  // 避免远端输入误触发本地退出词或“立即执行”类命令。
  //
  // 但如果命令本身通过 `isBridgeSafeCommand()` 检查，
  // 我们仍允许它继续走 slash command 流程。
  //
  // 反过来，如果这是一个“已知但不安全”的本地命令
  // （例如依赖本地 JSX UI，或只能在终端里执行），
  // 就直接短路返回友好提示，不把原始 `/config` 之类文本继续交给模型。
  let effectiveSkipSlash = skipSlashCommands
  if (bridgeOrigin && inputString !== null && inputString.startsWith('/')) {
    const parsed = parseSlashCommand(inputString)
    const cmd = parsed
      ? findCommand(parsed.commandName, context.options.commands)
      : undefined
    if (cmd) {
      if (isBridgeSafeCommand(cmd)) {
        effectiveSkipSlash = false
      } else {
        const msg = `/${getCommandName(cmd)} isn't available over Remote Control.`
        return {
          messages: [
            createUserMessage({ content: inputString, uuid }),
            createCommandInputMessage(
              `<local-command-stdout>${msg}</local-command-stdout>`,
            ),
          ],
          shouldQuery: false,
          resultText: msg,
        }
      }
    }
    // 如果是未知命令，或者根本解析失败，就退回普通文本路径。
    // 这保持了 #19134 之前的行为：例如移动端用户输入 `/shrug`，
    // 不应该被硬提示成 “Unknown skill”。
  }

  // `Ultraplan` 关键字快捷路由：
  // - 如果普通 prompt 中命中了关键字，就自动改走 `/ultraplan`；
  // - 检测时使用“展开粘贴文本之前”的输入，避免粘贴内容误触发 CCR 会话；
  // - 替换时则在展开后的输入里把关键字改成 `plan`，
  //   这样 CCR prompt 既能吃到粘贴内容，又能保持语句通顺。
  //
  // 这条路径只在“交互式 prompt + 非 slash 前缀”场景下生效。
  // 对于 headless / print 模式，`context.options` 里通常已经过滤掉 local-jsx 命令，
  // 如果这里还强行路由到 `/ultraplan`，只会得到 “Unknown skill”；
  // 而且 print 模式本来也没有彩虹动画之类的体验需求。
  //
  // 它必须发生在附件提取之前，
  // 这样才能和下面正式的 slash command 路径保持一致：
  // `setUserInputOnProcessing` 与 `setAppState` 中间没有额外 `await`，
  // React 才能把两次更新批到同一帧里，避免界面闪一下。
  if (
    feature('ULTRAPLAN') &&
    mode === 'prompt' &&
    !context.options.isNonInteractiveSession &&
    inputString !== null &&
    !effectiveSkipSlash &&
    !inputString.startsWith('/') &&
    !context.getAppState().ultraplanSessionUrl &&
    !context.getAppState().ultraplanLaunching &&
    hasUltraplanKeyword(preExpansionInput ?? inputString)
  ) {
    logEvent('tengu_ultraplan_keyword', {})
    const rewritten = replaceUltraplanKeyword(inputString).trim()
    const { processSlashCommand } = await import('./processSlashCommand.js')
    const slashResult = await processSlashCommand(
      `/ultraplan ${rewritten}`,
      precedingInputBlocks,
      imageContentBlocks,
      [],
      context,
      setToolJSX,
      uuid,
      isAlreadyProcessing,
      canUseTool,
    )
    return addImageMetadataMessage(slashResult, imageMetadataTexts)
  }

  // 如果最终要走 slash command 路径，
  // 附件会在 `getMessagesForSlashCommand` 内部自行提取，这里无需重复处理。
  const shouldExtractAttachments =
    !skipAttachments &&
    inputString !== null &&
    (mode !== 'prompt' || effectiveSkipSlash || !inputString.startsWith('/'))

  queryCheckpoint('query_attachment_loading_start')
  const attachmentMessages = shouldExtractAttachments
    ? await toArray(
        getAttachmentMessages(
          inputString,
          context,
          ideSelection ?? null,
          [], // `queuedCommands` 会在 `query.ts` 中统一处理，这里不重复接管
          messages,
          querySource,
        ),
      )
    : []
  queryCheckpoint('query_attachment_loading_end')

  // Bash 命令路径。
  if (inputString !== null && mode === 'bash') {
    const { processBashCommand } = await import('./processBashCommand.js')
    return addImageMetadataMessage(
      await processBashCommand(
        inputString,
        precedingInputBlocks,
        attachmentMessages,
        context,
        setToolJSX,
      ),
      imageMetadataTexts,
    )
  }

  // Slash command 路径。
  // 远端 bridge 消息默认跳过这里，因为来自 CCR 客户端的输入应被视为普通文本。
  if (
    inputString !== null &&
    !effectiveSkipSlash &&
    inputString.startsWith('/')
  ) {
    const { processSlashCommand } = await import('./processSlashCommand.js')
    const slashResult = await processSlashCommand(
      inputString,
      precedingInputBlocks,
      imageContentBlocks,
      attachmentMessages,
      context,
      setToolJSX,
      uuid,
      isAlreadyProcessing,
      canUseTool,
    )
    return addImageMetadataMessage(slashResult, imageMetadataTexts)
  }

  // 记录 `@agent-xxx` 提及用法，方便分析用户是否在主动使用子 agent 能力。
  if (inputString !== null && mode === 'prompt') {
    const trimmedInput = inputString.trim()

    const agentMention = attachmentMessages.find(
      (m): m is AttachmentMessage<AgentMentionAttachment> =>
        m.attachment.type === 'agent_mention',
    )

    if (agentMention) {
      const agentMentionString = `@agent-${agentMention.attachment.agentType}`
      const isSubagentOnly = trimmedInput === agentMentionString
      const isPrefix =
        trimmedInput.startsWith(agentMentionString) && !isSubagentOnly

      // 记录用户是“只发 agent mention”，还是“把它作为前缀附着在自然语言前面”。
      logEvent('tengu_subagent_at_mention', {
        is_subagent_only: isSubagentOnly,
        is_prefix: isPrefix,
      })
    }
  }

  // 普通用户 prompt 路径：
  // 经过前面的所有分流之后，剩下的输入最终都会落到这里，
  // 并交给 `processTextPrompt()` 生成标准 query 消息。
  return addImageMetadataMessage(
    processTextPrompt(
      normalizedInput,
      imageContentBlocks,
      imagePasteIds,
      attachmentMessages,
      uuid,
      permissionMode,
      isMeta,
    ),
    imageMetadataTexts,
  )
}

/**
 * 如果收集到了图片元数据，就把它们作为一条 `isMeta` 用户消息附加到结果中。
 *
 * 这样做的目的，是让模型在不打扰用户界面的前提下，
 * 仍能看到图片尺寸、来源路径等辅助信息。
 */
function addImageMetadataMessage(
  result: ProcessUserInputBaseResult,
  imageMetadataTexts: string[],
): ProcessUserInputBaseResult {
  if (imageMetadataTexts.length > 0) {
    result.messages.push(
      createUserMessage({
        content: imageMetadataTexts.map(text => ({ type: 'text', text })),
        isMeta: true,
      }),
    )
  }
  return result
}
