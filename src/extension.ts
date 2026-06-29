import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";

// ── 模块级状态 ─────────────────────────────────────────
let _statusBar: vscode.StatusBarItem | undefined;
let _mcpDisposable: vscode.Disposable | undefined;
let _fileWatcher: vscode.FileSystemWatcher | undefined;
let _retryTimer: NodeJS.Timeout | undefined;
let _retryCount = 0;
let _watcherDebounce: NodeJS.Timeout | undefined;
let _postInitTimer: NodeJS.Timeout | undefined;

// 重试间隔 (ms)：2s → 5s → 10s，之后转为手动
const RETRY_DELAYS = [2000, 5000, 10000];

export function activate(context: vscode.ExtensionContext) {
  // ── 状态栏（可点击，触发 restart） ──
  _statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  _statusBar.command = "codegraph.restart";
  _statusBar.show();
  context.subscriptions.push(_statusBar);

  // ── 命令：重启 MCP（直接触发） ──
  context.subscriptions.push(
    vscode.commands.registerCommand("codegraph.restart", () => {
      cleanup();
      tryRegisterServer(context);
    })
  );

  // ── 命令：弹出操作菜单 ──
  context.subscriptions.push(
    vscode.commands.registerCommand("codegraph.showMenu", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "$(debug-restart) Restart MCP Server", description: "重新检测 CLI + 注册 MCP", id: "restart" },
          { label: "$(new-folder) Initialize Project", description: "运行 codegraph init", id: "init" },
          { label: "$(sync) Force Re-index", description: "运行 codegraph sync", id: "sync" },
        ],
        { placeHolder: "选择 CodeGraph 操作" }
      );
      if (!pick) return;
      if (pick.id === "restart") {
        cleanup();
        tryRegisterServer(context);
      } else {
        runCliCommand(context, pick.id);
      }
    })
  );

  // 状态栏点击 → 弹出菜单
  _statusBar.command = "codegraph.showMenu";

  // ── 统一清理 ──
  context.subscriptions.push({ dispose: () => cleanup() });

  // ── 初次尝试 ──
  tryRegisterServer(context);
}

// ══════════════════════════════════════════════════════
//  在终端执行 codegraph 子命令（init / sync）
// ══════════════════════════════════════════════════════
function runCliCommand(context: vscode.ExtensionContext, subcommand: string) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showWarningMessage("请先打开一个工作区");
    return;
  }

  const codegraphPath = resolveCodegraph();
  if (!codegraphPath) {
    vscode.window.showErrorMessage(
      "未找到 codegraph 命令。请确认已安装 (npm install -g @sven/codegraph)。"
    );
    return;
  }

  const terminal = vscode.window.createTerminal({
    cwd: root,
    name: `CodeGraph ${subcommand}`,
  });
  terminal.show();

  // codegraph init/sync 在 cwd 目录下执行即可
  terminal.sendText(`${escapePath(codegraphPath)} ${subcommand}`);

  // 安全网：15s 后自动触发一次重新检测
  schedulePostInitCheck(context);
}

function schedulePostInitCheck(context: vscode.ExtensionContext) {
  clearPostInitTimer();
  _postInitTimer = setTimeout(() => {
    _postInitTimer = undefined;
    tryRegisterServer(context);
  }, 15000);
}

function clearPostInitTimer() {
  if (_postInitTimer) {
    clearTimeout(_postInitTimer);
    _postInitTimer = undefined;
  }
}

/** 给路径加引号（防止空格等特殊字符） */
function escapePath(p: string): string {
  return p.includes(" ") ? `"${p}"` : p;
}

// ══════════════════════════════════════════════════════
//  核心：查找 binary + 检查初始化 + 注册 MCP
// ══════════════════════════════════════════════════════
function tryRegisterServer(context: vscode.ExtensionContext) {
  clearRetryTimer();
  stopFileWatcher();
  clearWatcherDebounce();

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    updateStatusBar("$(warning) CodeGraph: No workspace", "未打开工作区");
    return;
  }

  // ── 1. 查找 codegraph CLI ──
  const codegraphPath = resolveCodegraph();
  if (!codegraphPath) {
    updateStatusBar(
      "$(error) CodeGraph: Not found",
      "未找到 codegraph 命令。安装后点击重试。",
      "statusBarItem.errorBackground"
    );
    scheduleRetry(context);
    return;
  }

  // ── 2. 检查项目初始化状态 ──
  let initialized = false;
  try {
    const stdout = cp.execFileSync(codegraphPath, ["status", root, "--json"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const result = JSON.parse(stdout);
    initialized = !!result.initialized;
  } catch {
    // status 命令失败，按未初始化处理
  }

  if (!initialized) {
    updateStatusBar(
      "$(info) CodeGraph: Not initialized",
      `运行 "CodeGraph: Initialize Project" 命令或在终端执行 \`codegraph init\`。\n检测到 .codegraph/ 变更时自动注册。`,
      "statusBarItem.warningBackground"
    );
    startFileWatcher(context, root);
    return;
  }

  // ── 3. 注册 MCP server ──
  doRegisterMcp(codegraphPath, root);
}

// ══════════════════════════════════════════════════════
//  MCP 注册（可热替换）
// ══════════════════════════════════════════════════════
function doRegisterMcp(codegraphPath: string, root: string) {
  if (_mcpDisposable) {
    _mcpDisposable.dispose();
    _mcpDisposable = undefined;
  }

  _mcpDisposable = vscode.lm.registerMcpServerDefinitionProvider(
    "codegraph",
    {
      provideMcpServerDefinitions(_token: vscode.CancellationToken) {
        return [
          new vscode.McpStdioServerDefinition(
            "CodeGraph",
            codegraphPath,
            ["serve", "--mcp", "--no-watch", "--path", root],
            undefined,
            "1.0.0"
          ),
        ];
      },
    }
  );

  updateStatusBar(
    "$(check) CodeGraph: Ready",
    `CodeGraph MCP 服务器已注册 (${root})。点击重新注册。`
  );
  _retryCount = 0;

  // 保持监听，用于 re-init / sync 后自动重注册
  startFileWatcher(undefined, root);
}

// ══════════════════════════════════════════════════════
//  文件监听：检测 .codegraph/ 变化
//  仅在 CLI 已找到时创建；context 传 undefined 表示不重复注册到 subscriptions
// ══════════════════════════════════════════════════════
function startFileWatcher(
  context: vscode.ExtensionContext | undefined,
  root: string
) {
  if (_fileWatcher) return;

  _fileWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, ".codegraph/**")
  );

  const onChange = () => {
    clearWatcherDebounce();
    _watcherDebounce = setTimeout(() => {
      tryRegisterServer(undefined as any);
    }, 1500);
  };

  _fileWatcher.onDidCreate(onChange);
  _fileWatcher.onDidChange(onChange);
  _fileWatcher.onDidDelete(onChange);

  if (context) {
    context.subscriptions.push(_fileWatcher);
  }
}

function stopFileWatcher() {
  if (_fileWatcher) {
    _fileWatcher.dispose();
    _fileWatcher = undefined;
  }
}

function clearWatcherDebounce() {
  if (_watcherDebounce) {
    clearTimeout(_watcherDebounce);
    _watcherDebounce = undefined;
  }
}

// ══════════════════════════════════════════════════════
//  重试调度 — 仅用于 binary not found
//  3 次（2s/5s/10s）后放弃，转手动
// ══════════════════════════════════════════════════════
function scheduleRetry(context: vscode.ExtensionContext) {
  if (_retryCount >= RETRY_DELAYS.length) {
    updateStatusBar(
      "$(error) CodeGraph: Not found",
      `已重试 ${_retryCount} 次仍未找到 codegraph。安装后点击状态栏重试。`,
      "statusBarItem.errorBackground"
    );
    return;
  }

  const delay = RETRY_DELAYS[_retryCount];
  _retryCount++;

  _retryTimer = setTimeout(() => tryRegisterServer(context), delay);
}

function clearRetryTimer() {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = undefined;
  }
}

// ══════════════════════════════════════════════════════
//  统一清理
// ══════════════════════════════════════════════════════
function cleanup() {
  clearRetryTimer();
  clearWatcherDebounce();
  clearPostInitTimer();
  stopFileWatcher();
  _retryCount = 0;
}

// ══════════════════════════════════════════════════════
//  状态栏
// ══════════════════════════════════════════════════════
function updateStatusBar(
  text: string,
  tooltip: string,
  backgroundColor?: string
) {
  if (!_statusBar) return;
  _statusBar.text = text;
  _statusBar.tooltip = tooltip;
  _statusBar.backgroundColor = backgroundColor
    ? new vscode.ThemeColor(backgroundColor)
    : undefined;
  _statusBar.show();
}

// ══════════════════════════════════════════════════════
//  查找 codegraph CLI
// ══════════════════════════════════════════════════════

function resolveCodegraph(): string | undefined {
  const envPath = process.env.PATH || "";
  const homeDir = process.env.HOME || "";
  const binaryName =
    process.platform === "win32" ? "codegraph.cmd" : "codegraph";

  // ── 收集候选目录 ──
  const candidateDirs = new Set<string>();
  const addDir = (dir?: string) => {
    if (dir) {
      candidateDirs.add(dir);
    }
  };

  // 1. 环境变量显式指定
  const explicitPath = process.env.CODEGRAPH_PATH || process.env.CODEGRAPH_BIN;
  if (explicitPath) {
    const resolved = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.resolve(explicitPath);
    if (isExecutable(resolved)) {
      return resolved;
    }
  }

  // 2. process.env.PATH
  for (const dir of envPath.split(path.delimiter)) {
    addDir(dir);
  }

  // 3. npm 全局前缀
  for (const prefix of [
    process.env.npm_config_prefix,
    process.env.NPM_CONFIG_PREFIX,
  ]) {
    addDir(prefix ? path.join(prefix, "bin") : undefined);
  }

  // 4. 常见安装目录
  const commonDirs = [
    path.join(homeDir, ".npm_global", "bin"),
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".bun", "bin"),
    path.join(homeDir, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];

  for (const dir of commonDirs) {
    addDir(dir);
  }

  // ── 在候选目录中搜索 ──
  const searchCandidates = (): string | undefined => {
    for (const dir of candidateDirs) {
      const fullPath = path.join(dir, binaryName);
      if (isExecutable(fullPath)) {
        return fullPath;
      }
    }
    return undefined;
  };

  const found = searchCandidates();
  if (found) return found;

  // ── 5. 通过 shell 获取完整 PATH（关键！解决 shell 环境异步问题） ──
  //    使用 zsh -l（login）让 .zprofile / .zshrc 完整加载
  try {
    const output = cp.execFileSync(
      "/bin/zsh",
      ["-l", "-c", "echo $PATH"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }
    );
    const shellPath = output.trim();
    if (shellPath) {
      for (const dir of shellPath.split(":")) {
        addDir(dir);
      }
    }
  } catch {
    // 获取 shell PATH 失败，继续
  }

  const foundByShell = searchCandidates();
  if (foundByShell) return foundByShell;

  // ── 6. 终极手段：直接通过 shell 命令查找 ──
  for (const shell of [
    { bin: "/bin/zsh", args: ["-li", "-c", "command -v codegraph 2>/dev/null || true"] },
    { bin: "/bin/zsh", args: ["-lc", "command -v codegraph 2>/dev/null || true"] },
    { bin: "/bin/bash", args: ["-lc", "command -v codegraph 2>/dev/null || true"] },
    { bin: "/bin/sh", args: ["-c", "command -v codegraph 2>/dev/null || true"] },
  ]) {
    try {
      const output = cp.execFileSync(shell.bin, shell.args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
      const resolved = output.trim();
      if (resolved && isExecutable(resolved)) {
        return resolved;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function isExecutable(fullPath: string): boolean {
  if (!fullPath) {
    return false;
  }

  try {
    cp.execFileSync(fullPath, ["--version"], {
      encoding: "utf-8",
      stdio: "ignore",
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
}

export function deactivate() {
  cleanup();
  _mcpDisposable?.dispose();
  _mcpDisposable = undefined;
  _statusBar = undefined;
}


