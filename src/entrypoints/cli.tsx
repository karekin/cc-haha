import { feature } from 'bun:bundle';

/**
 * 这是 Claude Code 的“超早期入口文件”。
 *
 * 设计目标：
 * 1. 在**尽可能少加载模块**的前提下，先识别若干“快速路径”命令；
 * 2. 只有在确认需要完整 CLI 时，才去加载庞大的 `src/main.tsx`；
 * 3. 借助动态 import + feature gate，把很多重量级路径延迟到真正使用时再加载；
 * 4. 在这里处理那些**必须发生在模块加载之前**的环境变量副作用。
 *
 * 可以把它理解成：
 * - 外层：极轻量的启动分流器
 * - 内层：真正完整的 Claude Code 主程序（`../main.js`）
 *
 * 这也是为什么本文件里会看到很多：
 * - 顶层 `process.env` 写入
 * - `feature('...')` 宏判断
 * - `await import(...)` 的动态按需加载
 */

// 修复 corepack 自动往 package.json 里写 yarnpkg 的问题。
// 这个副作用必须尽早执行，否则后面再加载其他模块时可能已经触发了 corepack 的错误行为。
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// 在 CCR（远程/容器）环境里，子进程可能会吃到更大的上下文和更多任务，
// 这里提前给 Node 子进程设置更大的堆上限，避免默认内存配置过小导致 OOM。
// 之所以放在入口层而不是更晚的位置，是因为某些子进程会继承当前进程的 NODE_OPTIONS。
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level, custom-rules/safe-env-boolean-check
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  const existing = process.env.NODE_OPTIONS || '';
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192';
}

// ABLATION_BASELINE 是一个实验/基线模式。
// 这里故意不放到 init.ts，因为很多工具会在“模块导入时”把环境变量读取进模块级常量；
// 如果等 init() 执行时再设置，这些工具已经完成初始化，实验开关就来不及生效了。
// `feature()` 是 Bun 的编译期开关：当该特性关闭时，这整个分支会被 DCE 移除。
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_THINKING', 'DISABLE_INTERLEAVED_THINKING', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']) {
    // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
    process.env[k] ??= '1';
  }
}

/**
 * 入口主函数。
 *
 * 这里做的不是“完整 CLI 初始化”，而是先看命令行参数是否属于某些快速路径：
 * - 版本输出
 * - dump system prompt
 * - Chrome / Computer Use 的专用子进程
 * - remote-control / daemon / background session / template jobs
 * - 若都不匹配，最后才真正 import `../main.js`
 *
 * 这种设计能显著减少：
 * - 启动时的模块评估成本
 * - 不必要的全局初始化
 * - 某些仅工具/后台模式下的首屏等待时间
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  /**
   * 快速路径 1：仅输出版本号。
   *
   * 这是最极致的轻量路径：
   * - 不加载 profiler
   * - 不加载 config
   * - 不加载 main.tsx
   * - 直接输出编译时注入的 `MACRO.VERSION`
   */
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION 在构建期被内联到 bundle 里。
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
  }

  /**
   * 从这里开始，不再是零成本路径。
   *
   * 我们先加载启动性能分析器，用于记录从入口分流到最终 CLI 完成之间的各个关键阶段。
   */
  const {
    profileCheckpoint
  } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  /**
   * 快速路径 2：导出系统 Prompt。
   *
   * 用途：
   * - prompt 敏感性测试
   * - 调试当前版本的 system prompt 组合结果
   *
   * 特点：
   * - 需要加载 config，因为 prompt 组装依赖配置和模型选择
   * - 但仍然不需要走完整 main.tsx
   */
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      getMainLoopModel
    } = await import('../utils/model/model.js');
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 && args[modelIdx + 1] || getMainLoopModel();
    const {
      getSystemPrompt
    } = await import('../constants/prompts.js');
    const prompt = await getSystemPrompt([], model);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(prompt.join('\n'));
    return;
  }

  /**
   * 快速路径 3：若当前进程是作为某个专用 MCP/Native Host 子进程启动，
   * 则直接进入对应服务逻辑，而不是走完整 CLI。
   *
   * 这些模式本质上是在复用 Claude Code 的某些能力，但运行形态已经不是普通交互式 CLI 了。
   */
  if (process.argv[2] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_claude_in_chrome_mcp_path');
    const {
      runClaudeInChromeMcpServer
    } = await import('../utils/claudeInChrome/mcpServer.js');
    await runClaudeInChromeMcpServer();
    return;
  } else if (process.argv[2] === '--chrome-native-host') {
    profileCheckpoint('cli_chrome_native_host_path');
    const {
      runChromeNativeHost
    } = await import('../utils/claudeInChrome/chromeNativeHost.js');
    await runChromeNativeHost();
    return;
  } else if (process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path');
    const {
      runComputerUseMcpServer
    } = await import('../utils/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  /**
   * 快速路径 4：内部 daemon worker。
   *
   * 这个路径要求尽可能轻：
   * - 不启用完整 config 树
   * - 不初始化 analytics sinks
   * - 仅把控制权交给 worker registry
   *
   * 因为这是 supervisor 派生出的子 worker，本身就应该是“专用执行体”。
   */
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const {
      runDaemonWorker
    } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(args[1]);
    return;
  }

  /**
   * 快速路径 5：remote-control / bridge 模式。
   *
   * 这是把当前本机变成一个 bridge 环境的入口：
   * - 会先启用配置系统
   * - 校验桥接功能开关
   * - 校验登录态
   * - 校验远程控制策略是否允许
   * - 最后进入 `bridgeMain`
   *
   * 注意：这里先检查 auth，再检查 GrowthBook / gate，
   * 是因为 gate 判定本身也依赖用户上下文；如果未登录，直接查 gate 可能拿到过期/默认值。
   */
  if (feature('BRIDGE_MODE') && (args[0] === 'remote-control' || args[0] === 'rc' || args[0] === 'remote' || args[0] === 'sync' || args[0] === 'bridge')) {
    profileCheckpoint('cli_bridge_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      getBridgeDisabledReason,
      checkBridgeMinVersion
    } = await import('../bridge/bridgeEnabled.js');
    const {
      BRIDGE_LOGIN_ERROR
    } = await import('../bridge/types.js');
    const {
      bridgeMain
    } = await import('../bridge/bridgeMain.js');
    const {
      exitWithError
    } = await import('../utils/process.js');

    const {
      getClaudeAIOAuthTokens
    } = await import('../utils/auth.js');
    if (!getClaudeAIOAuthTokens()?.accessToken) {
      exitWithError(BRIDGE_LOGIN_ERROR);
    }
    const disabledReason = await getBridgeDisabledReason();
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`);
    }
    const versionError = checkBridgeMinVersion();
    if (versionError) {
      exitWithError(versionError);
    }

    // bridge 属于远程控制能力，除登录态外，还需要通过组织策略限制。
    const {
      waitForPolicyLimitsToLoad,
      isPolicyAllowed
    } = await import('../services/policyLimits/index.js');
    await waitForPolicyLimitsToLoad();
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError("Error: Remote Control is disabled by your organization's policy.");
    }
    await bridgeMain(args.slice(1));
    return;
  }

  /**
   * 快速路径 6：daemon supervisor。
   *
   * 与 daemon worker 不同，这里进入的是 daemon 的主控逻辑：
   * - 会加载配置
   * - 会初始化 sinks
   * - 然后运行 `daemonMain`
   */
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      initSinks
    } = await import('../utils/sinks.js');
    initSinks();
    const {
      daemonMain
    } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  /**
   * 快速路径 7：后台会话管理命令。
   *
   * 这些命令对应 ~/.claude/sessions/ 里的后台 session registry：
   * - ps
   * - logs
   * - attach
   * - kill
   * - 或通过 --bg / --background 直接进入后台执行路径
   */
  if (feature('BG_SESSIONS') && (args[0] === 'ps' || args[0] === 'logs' || args[0] === 'attach' || args[0] === 'kill' || args.includes('--bg') || args.includes('--background'))) {
    profileCheckpoint('cli_bg_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const bg = await import('../cli/bg.js');
    switch (args[0]) {
      case 'ps':
        await bg.psHandler(args.slice(1));
        break;
      case 'logs':
        await bg.logsHandler(args[1]);
        break;
      case 'attach':
        await bg.attachHandler(args[1]);
        break;
      case 'kill':
        await bg.killHandler(args[1]);
        break;
      default:
        await bg.handleBgFlag(args);
    }
    return;
  }

  /**
   * 快速路径 8：template jobs。
   *
   * 这里执行完后会显式 `process.exit(0)`，
   * 原因是某些 Ink/TUI 相关句柄可能阻止事件循环自然退出。
   */
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    profileCheckpoint('cli_templates_path');
    const {
      templatesMain
    } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args);
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0);
  }

  /**
   * 快速路径 9：environment-runner（BYOC 场景）。
   */
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path');
    const {
      environmentRunnerMain
    } = await import('../environment-runner/main.js');
    await environmentRunnerMain(args.slice(1));
    return;
  }

  /**
   * 快速路径 10：self-hosted-runner。
   *
   * 这是另一类 headless runner，目标是 SelfHostedRunnerWorkerService API。
   */
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path');
    const {
      selfHostedRunnerMain
    } = await import('../self-hosted-runner/main.js');
    await selfHostedRunnerMain(args.slice(1));
    return;
  }

  /**
   * 快速路径 11：当用户同时传了 `--worktree` 和 `--tmux`，
   * 尽量在进入完整 CLI 前就直接切入 tmux/worktree 环境。
   *
   * 这样做可以减少主程序完全初始化后的再跳转成本。
   */
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (hasTmuxFlag && (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      isWorktreeModeEnabled
    } = await import('../utils/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const {
        execIntoTmuxWorktree
      } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      // 如果工作树/终端接管没有成功，回落到普通 CLI 路径。
      if (result.error) {
        const {
          exitWithError
        } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  /**
   * 用户常把 `claude --update` / `claude --upgrade` 写成 flag。
   * 这里把这种误用改写成真正的 `claude update` 子命令，提升可用性。
   */
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  /**
   * `--bare` 需要尽早写入环境变量，
   * 因为某些 gate 会在模块求值或 commander 构建阶段就读取该值。
   */
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  /**
   * 走到这里说明：
   * - 没命中任何特殊快速路径
   * - 需要真正加载完整 CLI
   *
   * 因此：
   * 1. 先开始捕获 early input，避免启动阶段用户输入丢失；
   * 2. 再 import 巨大的 `../main.js`；
   * 3. 最后调用它的 main()。
   */
  const {
    startCapturingEarlyInput
  } = await import('../utils/earlyInput.js');
  startCapturingEarlyInput();
  profileCheckpoint('cli_before_main_import');
  const {
    main: cliMain
  } = await import('../main.js');
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

// 顶层立即启动入口主函数。
// 这里故意保留顶层副作用，因为它就是整个可执行程序的真实启动点。
// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main();
