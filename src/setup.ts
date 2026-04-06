/* eslint-disable custom-rules/no-process-exit */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getCwd } from 'src/utils/cwd.js'
import { checkForReleaseNotes } from 'src/utils/releaseNotes.js'
import { setCwd } from 'src/utils/Shell.js'
import { initSinks } from 'src/utils/sinks.js'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from './bootstrap/state.js'
import { getCommands } from './commands.js'
import { initSessionMemory } from './services/SessionMemory/sessionMemory.js'
import { asSessionId } from './types/ids.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { checkAndRestoreTerminalBackup } from './utils/appleTerminalBackup.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from './utils/auth.js'
import { clearMemoryFileCaches } from './utils/claudemd.js'
import { getCurrentProjectConfig, getGlobalConfig } from './utils/config.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { env } from './utils/env.js'
import { envDynamic } from './utils/envDynamic.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { errorMessage } from './utils/errors.js'
import { findCanonicalGitRoot, findGitRoot, getIsGit } from './utils/git.js'
import { initializeFileChangedWatcher } from './utils/hooks/fileChangedWatcher.js'
import {
  captureHooksConfigSnapshot,
  updateHooksConfigSnapshot,
} from './utils/hooks/hooksConfigSnapshot.js'
import { hasWorktreeCreateHook } from './utils/hooks.js'
import { checkAndRestoreITerm2Backup } from './utils/iTermBackup.js'
import { logError } from './utils/log.js'
import { getRecentActivity } from './utils/logoV2Utils.js'
import { lockCurrentVersion } from './utils/nativeInstaller/index.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { getPlanSlug } from './utils/plans.js'
import { saveWorktreeState } from './utils/sessionStorage.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
} from './utils/worktree.js'

/**
 * `setup.ts` 是主程序真正“进入业务运行态”之前的环境准备层。
 *
 * 这个文件主要负责把启动期必须建立的前置条件一次性做完，典型包括：
 * - 运行环境是否合法（Node 版本、危险权限模式、沙箱条件）；
 * - 当前工作目录 / 原始工作目录 / 项目根目录的全局状态初始化；
 * - hooks、session memory、watcher、analytics sink 的接线；
 * - worktree / tmux 这种会改变运行上下文的重型准备工作；
 * - 一些首轮交互前就应该可用的预取与缓存预热；
 * - 上一次会话统计信息的补记上报。
 *
 * 可以把它理解成：
 * - `main.tsx` 决定“启动哪条路径”
 * - `setup.ts` 负责“让这条路径具备可运行条件”
 */
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'setup_started')

  /**
   * 第一阶段：运行时最低版本检查。
   *
   * 先在最前面做 Node 版本校验，避免后面加载/执行大量初始化后才因为运行时版本不够而失败。
   */
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion) < 18) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      chalk.bold.red(
        'Error: Claude Code requires Node.js version 18 or higher.',
      ),
    )
    process.exit(1)
  }

  /**
   * 第二阶段：若调用方显式传入 sessionId，则先切换到该会话。
   *
   * 后面很多状态与文件路径都依赖当前 sessionId，因此必须在这些逻辑之前完成。
   */
  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }

  /**
   * 第三阶段：按需启动 UDS 消息通道。
   *
   * 正常交互模式下，本地 Claude 进程可能需要接收外部注入消息，因此要尽早启动 UDS inbox。
   * bare 模式默认跳过；但如果显式传入 `messagingSocketPath`，仍然允许强制启用。
   */
  if (!isBareMode() || messagingSocketPath !== undefined) {
    /**
     * 这里必须 await，原因是后面的 hook/子进程可能会立即读取
     * `CLAUDE_CODE_MESSAGING_SOCKET` 并尝试连接；如果 socket 还没 bind 完成，
     * 就会出现“环境变量存在但服务不可用”的竞态问题。
     */
    if (feature('UDS_INBOX')) {
      const m = await import('./utils/udsMessaging.js')
      await m.startUdsMessaging(
        messagingSocketPath ?? m.getDefaultUdsSocketPath(),
        { isExplicit: messagingSocketPath !== undefined },
      )
    }
  }

  /**
   * 第四阶段：记录 teammate mode 快照。
   *
   * 这一步只在启用 agent swarms 的前提下执行，用于后续多 Agent / team 能力识别当前后端模式。
   */
  if (!isBareMode() && isAgentSwarmsEnabled()) {
    const { captureTeammateModeSnapshot } = await import(
      './utils/swarm/backends/teammateModeSnapshot.js'
    )
    captureTeammateModeSnapshot()
  }

  /**
   * 第五阶段：终端设置恢复。
   *
   * 仅交互模式需要处理，因为 print/headless 模式不会去修改用户终端环境。
   * 这里的目的是把之前可能“半途失败”的 iTerm2 / Terminal.app 设置恢复到安全状态。
   */
  if (!getIsNonInteractiveSession()) {
    // iTerm2 恢复仅在相关集成开启时才有意义。
    if (isAgentSwarmsEnabled()) {
      const restoredIterm2Backup = await checkAndRestoreITerm2Backup()
      if (restoredIterm2Backup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.yellow(
            'Detected an interrupted iTerm2 setup. Your original settings have been restored. You may need to restart iTerm2 for the changes to take effect.',
          ),
        )
      } else if (restoredIterm2Backup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            `Failed to restore iTerm2 settings. Please manually restore your original settings with: defaults import com.googlecode.iterm2 ${restoredIterm2Backup.backupPath}.`,
          ),
        )
      }
    }

    // Terminal.app 的恢复逻辑与 iTerm2 类似，但单独包在 try/catch 里，避免终端恢复失败拖垮整个 setup。
    try {
      const restoredTerminalBackup = await checkAndRestoreTerminalBackup()
      if (restoredTerminalBackup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.yellow(
            'Detected an interrupted Terminal.app setup. Your original settings have been restored. You may need to restart Terminal.app for the changes to take effect.',
          ),
        )
      } else if (restoredTerminalBackup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            `Failed to restore Terminal.app settings. Please manually restore your original settings with: defaults import com.apple.Terminal ${restoredTerminalBackup.backupPath}.`,
          ),
        )
      }
    } catch (error) {
      // Log but don't crash if Terminal.app backup restoration fails
      logError(error)
    }
  }

  /**
   * 第六阶段：建立全局目录基线。
   *
   * `setCwd()` 必须尽早执行，因为后续几乎所有依赖本地配置、hooks、git、skills 的逻辑
   * 都会隐式依赖当前工作目录。
   */
  setCwd(cwd)
  setOriginalCwd(cwd)
  setProjectRoot(cwd)

  /**
   * 第七阶段：本地恢复模式的极简提前返回。
   *
   * 当显式进入 local recovery 时，setup 只保留最小必需动作，
   * 不再继续为完整 Ink/TUI 做昂贵初始化。
   */
  if (process.env.CLAUDE_CODE_LOCAL_RECOVERY === '1') {
    process.stderr.write('[local-recovery] setup early return\n')
    profileCheckpoint('setup_local_recovery_early_return')
    return
  }

  /**
   * 第八阶段：捕获 hooks 配置快照，并启动 FileChanged watcher。
   *
   * 目的：
   * - 后续可以检测“隐藏的 hook 配置变化”；
   * - watcher 依赖正确目录下的 hooks 配置，因此必须放在 setCwd() 之后。
   */
  const hooksStart = Date.now()
  captureHooksConfigSnapshot()
  logForDiagnosticsNoPII('info', 'setup_hooks_captured', {
    duration_ms: Date.now() - hooksStart,
  })

  // FileChanged watcher 是同步初始化的，并直接依赖刚刚捕获的 hooks 快照。
  initializeFileChangedWatcher(cwd)

  /**
   * 第九阶段：如果用户请求 `--worktree`，则在这里完成 worktree / tmux 环境切换。
   *
   * 这一段是 setup 中最“重”的分支之一：
   * - 校验当前是否有 git 或替代 hook；
   * - 解析 slug / PR 编号；
   * - 创建 worktree；
   * - 可选创建 tmux session；
   * - 把 cwd / projectRoot / originalCwd 等状态切换到新 worktree。
   *
   * 注：必须先于 `getCommands()` 执行，否则某些与 worktree 强相关的命令装配会丢失上下文。
   */
  if (worktreeEnabled) {
    // Mirrors bridgeMain.ts: hook-configured sessions can proceed without git
    // so createWorktreeForSession() can delegate to the hook (non-git VCS).
    const hasHook = hasWorktreeCreateHook()
    const inGit = await getIsGit()
    if (!hasHook && !inGit) {
      process.stderr.write(
        chalk.red(
          `Error: Can only use --worktree in a git repository, but ${chalk.bold(cwd)} is not a git repository. ` +
            `Configure a WorktreeCreate hook in settings.json to use --worktree with other VCS systems.\n`,
        ),
      )
      process.exit(1)
    }

    const slug = worktreePRNumber
      ? `pr-${worktreePRNumber}`
      : (worktreeName ?? getPlanSlug())

    // Git preamble runs whenever we're in a git repo — even if a hook is
    // configured — so --tmux keeps working for git users who also have a
    // WorktreeCreate hook. Only hook-only (non-git) mode skips it.
    let tmuxSessionName: string | undefined
    if (inGit) {
      // Resolve to main repo root (handles being invoked from within a worktree).
      // findCanonicalGitRoot is sync/filesystem-only/memoized; the underlying
      // findGitRoot cache was already warmed by getIsGit() above, so this is ~free.
      const mainRepoRoot = findCanonicalGitRoot(getCwd())
      if (!mainRepoRoot) {
        process.stderr.write(
          chalk.red(
            `Error: Could not determine the main git repository root.\n`,
          ),
        )
        process.exit(1)
      }

      // If we're inside a worktree, switch to the main repo for worktree creation
      if (mainRepoRoot !== (findGitRoot(getCwd()) ?? getCwd())) {
        logForDiagnosticsNoPII('info', 'worktree_resolved_to_main_repo')
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }

      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(mainRepoRoot, worktreeBranchName(slug))
        : undefined
    } else {
      // Non-git hook mode: no canonical root to resolve, so name the tmux
      // session from cwd — generateTmuxSessionName only basenames the path.
      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(getCwd(), worktreeBranchName(slug))
        : undefined
    }

    let worktreeSession: Awaited<ReturnType<typeof createWorktreeForSession>>
    try {
      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        tmuxSessionName,
        worktreePRNumber ? { prNumber: worktreePRNumber } : undefined,
      )
    } catch (error) {
      process.stderr.write(
        chalk.red(`Error creating worktree: ${errorMessage(error)}\n`),
      )
      process.exit(1)
    }

    logEvent('tengu_worktree_created', { tmux_enabled: tmuxEnabled })

    // 如果启用了 tmux，则在 worktree 创建成功后继续创建并关联 tmux session。
    if (tmuxEnabled && tmuxSessionName) {
      const tmuxResult = await createTmuxSessionForWorktree(
        tmuxSessionName,
        worktreeSession.worktreePath,
      )
      if (tmuxResult.created) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.green(
            `Created tmux session: ${chalk.bold(tmuxSessionName)}\nTo attach: ${chalk.bold(`tmux attach -t ${tmuxSessionName}`)}`,
          ),
        )
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.yellow(
            `Warning: Failed to create tmux session: ${tmuxResult.error}`,
          ),
        )
      }
    }

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    // --worktree means the worktree IS the session's project, so skills/hooks/
    // cron/etc. should resolve here. (EnterWorktreeTool mid-session does NOT
    // touch projectRoot — that's a throwaway worktree, project stays stable.)
    setProjectRoot(getCwd())
    saveWorktreeState(worktreeSession)
    // Clear memory files cache since originalCwd has changed
    clearMemoryFileCaches()
    // Settings cache was populated in init() (via applySafeConfigEnvironmentVariables)
    // and again at captureHooksConfigSnapshot() above, both from the original dir's
    // .claude/settings.json. Re-read from the worktree and re-capture hooks.
    updateHooksConfigSnapshot()
  }

  /**
   * 第十阶段：注册“首轮 query 前必须存在”的后台能力。
   *
   * 这里放的是 setup 阶段必须完成或发起的关键后台注册，
   * 与稍后更偏性能优化性质的 prefetch 是两类不同工作。
   */
  logForDiagnosticsNoPII('info', 'setup_background_jobs_starting')
  // Bundled skills/plugins are registered in main.tsx before the parallel
  // getCommands() kick — see comment there. Moved out of setup() because
  // the await points above (startUdsMessaging, ~20ms) meant getCommands()
  // raced ahead and memoized an empty bundledSkills list.
  if (!isBareMode()) {
    initSessionMemory() // Synchronous - registers hook, gate check happens lazily
    if (feature('CONTEXT_COLLAPSE')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js')
      ).initContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  void lockCurrentVersion() // Lock current version to prevent deletion by other processes
  logForDiagnosticsNoPII('info', 'setup_background_jobs_launched')

  profileCheckpoint('setup_before_prefetch')
  /**
   * 第十一阶段：首轮渲染/首轮交互前的预取。
   *
   * 目标是提前把第一轮最容易用到的插件、hooks、repo 分类、session file access 等能力热起来。
   * 但如果处于 bare 或 sync plugin install 等特殊路径，会有选择地跳过，避免无意义竞争和开销。
   */
  logForDiagnosticsNoPII('info', 'setup_prefetch_starting')
  // When CLAUDE_CODE_SYNC_PLUGIN_INSTALL is set, skip all plugin prefetch.
  // The sync install path in print.ts calls refreshPluginState() after
  // installing, which reloads commands, hooks, and agents. Prefetching here
  // races with the install (concurrent copyPluginToVersionedCache / cachePlugin
  // on the same directories), and the hot-reload handler fires clearPluginCache()
  // mid-install when policySettings arrives.
  const skipPluginPrefetch =
    (getIsNonInteractiveSession() &&
      isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) ||
    // --bare: loadPluginHooks → loadAllPlugins is filesystem work that's
    // wasted when executeHooks early-returns under --bare anyway.
    isBareMode()
  if (!skipPluginPrefetch) {
    void getCommands(getProjectRoot())
  }
  void import('./utils/plugins/loadPluginHooks.js').then(m => {
    if (!skipPluginPrefetch) {
      void m.loadPluginHooks() // Pre-load plugin hooks (consumed by processSessionStartHooks before render)
      m.setupPluginHookHotReload() // Set up hot reload for plugin hooks when settings change
    }
  })
  // --bare: skip attribution hook install + repo classification +
  // session-file-access analytics + team memory watcher. These are background
  // bookkeeping for commit attribution + usage metrics — scripted calls don't
  // commit code, and the 49ms attribution hook stat check (measured) is pure
  // overhead. NOT an early-return: the --dangerously-skip-permissions safety
  // gate, tengu_started beacon, and apiKeyHelper prefetch below must still run.
  if (!isBareMode()) {
    if (process.env.USER_TYPE === 'ant') {
      // Prime repo classification cache for auto-undercover mode. Default is
      // undercover ON until proven internal; if this resolves to internal, clear
      // the prompt cache so the next turn picks up the OFF state.
      void import('./utils/commitAttribution.js').then(async m => {
        if (await m.isInternalModelRepo()) {
          const { clearSystemPromptSections } = await import(
            './constants/systemPromptSections.js'
          )
          clearSystemPromptSections()
        }
      })
    }
    if (feature('COMMIT_ATTRIBUTION')) {
      // Dynamic import to enable dead code elimination (module contains excluded strings).
      // Defer to next tick so the git subprocess spawn runs after first render
      // rather than during the setup() microtask window.
      setImmediate(() => {
        void import('./utils/attributionHooks.js').then(
          ({ registerAttributionHooks }) => {
            registerAttributionHooks() // Register attribution tracking hooks (ant-only feature)
          },
        )
      })
    }
    void import('./utils/sessionFileAccessHooks.js').then(m =>
      m.registerSessionFileAccessHooks(),
    ) // Register session file access analytics hooks
    if (feature('TEAMMEM')) {
      void import('./services/teamMemorySync/watcher.js').then(m =>
        m.startTeamMemoryWatcher(),
      ) // Start team memory sync watcher
    }
  }
  initSinks() // Attach error log + analytics sinks and drain queued events

  /**
   * 第十二阶段：analytics sink 挂好后，立刻打出 `tengu_started`。
   *
   * 这个事件的作用不是业务功能，而是“启动成功分母”：
   * 如果后面任意一步崩掉，至少监控系统已经知道这次进程确实启动过。
   */
  logEvent('tengu_started', {})

  void prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession()) // Prefetch safely - only executes if trust already confirmed
  profileCheckpoint('setup_after_prefetch')

  /**
   * 第十三阶段：Logo / Release Notes 的交互式 UI 预热。
   *
   * 这部分明显偏展示体验，因此 bare 模式会跳过。
   */
  if (!isBareMode()) {
    const { hasReleaseNotes } = await checkForReleaseNotes(
      getGlobalConfig().lastReleaseNotesSeen,
    )
    if (hasReleaseNotes) {
      await getRecentActivity()
    }
  }

  /**
   * 第十四阶段：对 bypass 权限模式做最后的硬性安全校验。
   *
   * 即使用户显式要求 `--dangerously-skip-permissions`，这里仍然要确认：
   * - 不能在 root/sudo 下随便开启；
   * - 某些场景必须在隔离容器/沙箱且无外网时才允许；
   * - 这是整个启动路径里最关键的安全兜底之一。
   */
  if (
    permissionMode === 'bypassPermissions' ||
    allowDangerouslySkipPermissions
  ) {
    // Check if running as root/sudo on Unix-like systems
    // Allow root if in a sandbox (e.g., TPU devspaces that require root)
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)
    ) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(
        `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`,
      )
      process.exit(1)
    }

    if (
      process.env.USER_TYPE === 'ant' &&
      // Skip for Desktop's local agent mode — same trust model as CCR/BYOC
      // (trusted Anthropic-managed launcher intentionally pre-approving everything).
      // Precedent: permissionSetup.ts:861, applySettingsChange.ts:55 (PR #19116)
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent' &&
      // Same for CCD (Claude Code in Desktop) — apps#29127 passes the flag
      // unconditionally to unlock mid-session bypass switching
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop'
    ) {
      // Only await if permission mode is set to bypass
      const [isDocker, hasInternet] = await Promise.all([
        envDynamic.getIsDocker(),
        env.hasInternetAccess(),
      ])
      const isBubblewrap = envDynamic.getIsBubblewrapSandbox()
      const isSandbox = process.env.IS_SANDBOX === '1'
      const isSandboxed = isDocker || isBubblewrap || isSandbox
      if (!isSandboxed || hasInternet) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          `--dangerously-skip-permissions can only be used in Docker/sandbox containers with no internet access but got Docker: ${isDocker}, Bubblewrap: ${isBubblewrap}, IS_SANDBOX: ${isSandbox}, hasInternet: ${hasInternet}`,
        )
        process.exit(1)
      }
    }
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

  /**
   * 第十五阶段：补记上一轮会话的退出统计。
   *
   * 这里读取的是 project config 里持久化的上一轮 cost / duration / fps / token 统计，
   * 并在新的启动时补打一条 `tengu_exit`。
   *
   * 这些值不会被清空，因为恢复会话时仍可能依赖它们。
   */
  const projectConfig = getCurrentProjectConfig()
  if (
    projectConfig.lastCost !== undefined &&
    projectConfig.lastDuration !== undefined
  ) {
    logEvent('tengu_exit', {
      last_session_cost: projectConfig.lastCost,
      last_session_api_duration: projectConfig.lastAPIDuration,
      last_session_tool_duration: projectConfig.lastToolDuration,
      last_session_duration: projectConfig.lastDuration,
      last_session_lines_added: projectConfig.lastLinesAdded,
      last_session_lines_removed: projectConfig.lastLinesRemoved,
      last_session_total_input_tokens: projectConfig.lastTotalInputTokens,
      last_session_total_output_tokens: projectConfig.lastTotalOutputTokens,
      last_session_total_cache_creation_input_tokens:
        projectConfig.lastTotalCacheCreationInputTokens,
      last_session_total_cache_read_input_tokens:
        projectConfig.lastTotalCacheReadInputTokens,
      last_session_fps_average: projectConfig.lastFpsAverage,
      last_session_fps_low_1_pct: projectConfig.lastFpsLow1Pct,
      last_session_id:
        projectConfig.lastSessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...projectConfig.lastSessionMetrics,
    })
    // Note: We intentionally don't clear these values after logging.
    // They're needed for cost restoration when resuming sessions.
    // The values will be overwritten when the next session exits.
  }
}
