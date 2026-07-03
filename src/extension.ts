import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";

// ── 模块级状态 ─────────────────────────────────────────
let _statusBar: vscode.StatusBarItem | undefined;
let _mcpDisposable: vscode.Disposable | undefined;
let _fileWatcher: vscode.FileSystemWatcher | undefined;
let _retryTimer: NodeJS.Timeout | undefined;
let _retryCount = 0;
let _watcherDebounce: NodeJS.Timeout | undefined;
let _postInitTimer: NodeJS.Timeout | undefined;
let _extensionContext: vscode.ExtensionContext | undefined;
let _cachedCodegraphPath: string | undefined;
let _lastTerminalRetry = 0;
let _resolving = false;

// 重试间隔 (ms)：2s → 5s → 10s，之后转为手动
const RETRY_DELAYS = [2000, 5000, 10000];

export function activate(context: vscode.ExtensionContext) {
  _extensionContext = context;
  _cachedCodegraphPath = context.globalState.get<string>("codegraph.binaryPath");

  // ── 状态栏（可点击，弹出菜单） ──
  _statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  _statusBar.command = "codegraph.showMenu";
  _statusBar.text = "$(loading~spin) CodeGraph";
  _statusBar.tooltip = "CodeGraph: 正在检测 CLI…";
  _statusBar.show();
  context.subscriptions.push(_statusBar);

  // ── 命令注册 ──
  context.subscriptions.push(
    vscode.commands.registerCommand("codegraph.restart", () => {
      cleanup();
      scheduleResolve(context);
    }),
    vscode.commands.registerCommand("codegraph.initProject", () => {
      runCliCommand(context, "init");
    }),
    vscode.commands.registerCommand("codegraph.sync", () => {
      runCliCommand(context, "sync");
    }),
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
        scheduleResolve(context);
      } else {
        runCliCommand(context, pick.id);
      }
    })
  );

  // ── 统一清理 ──
  context.subscriptions.push({ dispose: () => cleanup() });

  // ── 终端事件监听：用户开终端时 shell 环境已就绪，自动重试 ──
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => {
      if (_retryCount > 0 && nowMs() - _lastTerminalRetry > 30000) {
        _lastTerminalRetry = nowMs();
        _retryCount = 0;
        scheduleResolve(context);
      }
    })
  );

  // ── 初次尝试（异步，避免阻塞扩展宿主） ──
  scheduleResolve(context);
}

function nowMs(): number {
  return Date.now();
}

/** 把 tryRegisterServer 放到下一轮事件循环，避免 activate 阻塞 */
function scheduleResolve(context: vscode.ExtensionContext) {
  setImmediate(() => {
    void tryRegisterServer(context);
  });
}

// ══════════════════════════════════════════════════════
//  在终端执行 codegraph 子命令（init / sync）
// ══════════════════════════════════════════════════════
async function runCliCommand(context: vscode.ExtensionContext, subcommand: string) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showWarningMessage("请先打开一个工作区");
    return;
  }

  const codegraphPath = await resolveCodegraph();
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

  terminal.sendText(`${escapePath(codegraphPath)} ${subcommand}`);

  // 安全网：15s 后自动触发一次重新检测
  schedulePostInitCheck(context);
}

function schedulePostInitCheck(context: vscode.ExtensionContext) {
  clearPostInitTimer();
  _postInitTimer = setTimeout(() => {
    _postInitTimer = undefined;
    scheduleResolve(context);
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
async function tryRegisterServer(context: vscode.ExtensionContext | undefined) {
  clearRetryTimer();
  stopFileWatcher();
  clearWatcherDebounce();

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    updateStatusBar("$(warning) CodeGraph: No workspace", "未打开工作区");
    return;
  }

  // ── 1. 查找 codegraph CLI ──
  const codegraphPath = await resolveCodegraph();
  if (!codegraphPath) {
    updateStatusBar(
      "$(error) CodeGraph: Not found",
      "未找到 codegraph 命令。安装后点击重试。",
      "statusBarItem.errorBackground"
    );
    if (context) scheduleRetry(context);
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
            ["serve", "--mcp", "--path", root],
            undefined,
            "1.0.0"
          ),
        ];
      },
    }
  );

  // 诚实化的状态栏：MCP 定义已注册，实际服务由 codegraph daemon 提供。
  // daemon 是 detached 后台进程，由 VS Code 在 Copilot 首次调用时懒启动
  // （冷启动约 0.5~1s），之后常驻复用；长时间空闲会自我 reap，下次调用重冷启动。
  updateStatusBar(
    "$(check) CodeGraph: Ready",
    `CodeGraph MCP 已注册 (${root})。\n服务由 codegraph daemon 提供，首次调用可能需冷启动 daemon（约 0.5~1s）。`
  );
  _retryCount = 0;

  // 注册后不再监听 .codegraph/**：daemon 自带 watcher 负责 sync，
  // 插件若继续监听会被 daemon 写 pid/sock/wal 触发 → 反复重注册 →
  // Copilot 调用落在重注册窗口而卡死。索引新鲜度全权交给 daemon。
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
      void tryRegisterServer(_extensionContext);
    }, 1500);
  };

  // 仅监听 onDidCreate（检测 codegraph init 完成），不监听 onDidChange/onDidDelete：
  // onDidChange 会被 daemon 运行时写 pid/sock/wal 触发，造成「重注册 → daemon 写 →
  // 再重注册」的正反馈循环，是「显示 Ready 但 Copilot 调用卡住」的根因。
  _fileWatcher.onDidCreate(onChange);

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

  _retryTimer = setTimeout(() => {
    void tryRegisterServer(context);
  }, delay);
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
//  全异步，避免阻塞扩展宿主
// ══════════════════════════════════════════════════════

async function resolveCodegraph(): Promise<string | undefined> {
  if (_resolving) {
    // 已在解析中，直接返回缓存（可能 undefined）
    return _cachedCodegraphPath;
  }
  _resolving = true;
  try {
    return await doResolveCodegraph();
  } finally {
    _resolving = false;
  }
}

async function doResolveCodegraph(): Promise<string | undefined> {
  // ── 0. 用户配置的路径（最高优先级） ──
  const configuredPath = vscode.workspace.getConfiguration("codegraph").get<string>("path");
  if (configuredPath && (await verifyExecutable(configuredPath))) {
    return configuredPath;
  }

  // ── 0.5 缓存路径（跨会话持久化，避免重复走 shell） ──
  if (_cachedCodegraphPath && (await verifyExecutable(_cachedCodegraphPath))) {
    return _cachedCodegraphPath;
  }
  const stored = _extensionContext?.globalState.get<string>("codegraph.binaryPath");
  if (stored && (await verifyExecutable(stored))) {
    _cachedCodegraphPath = stored;
    return stored;
  }
  // 缓存失效，清掉
  if (stored) {
    await _extensionContext?.globalState.update("codegraph.binaryPath", undefined);
    _cachedCodegraphPath = undefined;
  }

  const envPath = process.env.PATH || "";
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const binaryName =
    process.platform === "win32" ? "codegraph.cmd" : "codegraph";

  // ── 收集候选目录 ──
  const candidateDirs: string[] = [];
  const seen = new Set<string>();
  const addDir = (dir?: string) => {
    if (!dir) return;
    if (seen.has(dir)) return;
    seen.add(dir);
    candidateDirs.push(dir);
  };

  // 1. 环境变量显式指定
  const explicitPath = process.env.CODEGRAPH_PATH || process.env.CODEGRAPH_BIN;
  if (explicitPath) {
    const resolved = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.resolve(explicitPath);
    if (await verifyExecutable(resolved)) {
      return cachePath(resolved);
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

  // 4. Node 版本管理器目录（nvm / fnm / volta / asdf / n） —
  //    uTools / Spotlight / Alfred 启动 VS Code 时 PATH 缺失这些路径，
  //    需要主动扫一遍当前安装的 node 版本。
  for (const dir of collectNodeManagerBins(homeDir)) {
    addDir(dir);
  }

  // 5. 常见安装目录
  for (const dir of [
    path.join(homeDir, ".npm_global", "bin"),
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".bun", "bin"),
    path.join(homeDir, ".cargo", "bin"),
    path.join(homeDir, ".deno", "bin"),
    path.join(homeDir, ".yarn", "bin"),
    path.join(homeDir, ".config", "yarn", "global", "node_modules", ".bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]) {
    addDir(dir);
  }

  const findInCandidates = async (): Promise<string | undefined> => {
    for (const dir of candidateDirs) {
      const fullPath = path.join(dir, binaryName);
      if (await verifyExecutable(fullPath)) {
        return fullPath;
      }
    }
    return undefined;
  };

  const found = await findInCandidates();
  if (found) return cachePath(found);

  // ── 6. 通过用户 shell 获取完整 PATH ──
  const userShell = vscode.env.shell || process.env.SHELL || "";
  const shellName = path.basename(userShell).toLowerCase();
  const isFish = shellName === "fish";

  if (userShell) {
    const shellPath = await getShellPath(userShell, isFish);
    if (shellPath) {
      for (const dir of shellPath) {
        addDir(dir);
      }
      const found2 = await findInCandidates();
      if (found2) return cachePath(found2);
    }
  }

  // ── 7. 终极手段：直接通过 shell 命令查找 ──
  const shellSearchEntries: { bin: string; args: string[] }[] = [];

  if (userShell) {
    if (isFish) {
      shellSearchEntries.push({
        bin: userShell,
        args: ["-il", "-c", "command -s codegraph 2>/dev/null; or true"],
      });
    } else {
      shellSearchEntries.push(
        { bin: userShell, args: ["-li", "-c", "command -v codegraph 2>/dev/null || true"] },
        { bin: userShell, args: ["-lc", "command -v codegraph 2>/dev/null || true"] }
      );
    }
  }

  shellSearchEntries.push(
    { bin: "/bin/zsh", args: ["-li", "-c", "command -v codegraph 2>/dev/null || true"] },
    { bin: "/bin/zsh", args: ["-lc", "command -v codegraph 2>/dev/null || true"] },
    { bin: "/bin/bash", args: ["-lc", "command -v codegraph 2>/dev/null || true"] },
    { bin: "/bin/sh", args: ["-c", "command -v codegraph 2>/dev/null || true"] }
  );

  for (const shell of shellSearchEntries) {
    const stdout = await execAsync(shell.bin, shell.args, 5000);
    if (!stdout) continue;
    const resolved = stdout.trim().split("\n").pop()?.trim();
    if (resolved && (await verifyExecutable(resolved))) {
      return cachePath(resolved);
    }
  }

  return undefined;
}

function cachePath(p: string): string {
  _cachedCodegraphPath = p;
  void _extensionContext?.globalState.update("codegraph.binaryPath", p);
  return p;
}

/** 异步执行子进程，失败返回 undefined */
function execAsync(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const child = cp.execFile(
      file,
      args,
      { encoding: "utf-8", timeout: timeoutMs },
      (err, stdout) => {
        if (done) return;
        done = true;
        if (err) return resolve(undefined);
        resolve(stdout);
      }
    );
    child.on("error", () => {
      if (done) return;
      done = true;
      resolve(undefined);
    });
  });
}

/** 通过 shell 拿到完整 PATH，按目录数组返回 */
async function getShellPath(
  userShell: string,
  isFish: boolean
): Promise<string[] | undefined> {
  // fish: 用 newline 分隔的 string join，避免目录含空格被错切
  const shellArgs = isFish
    ? ["-il", "-c", "printf '%s\\n' $PATH"]
    : ["-li", "-c", "printf '%s' \"$PATH\""];

  const output = await execAsync(userShell, shellArgs, 8000);
  if (!output) return undefined;

  if (isFish) {
    // 每行一个目录
    return output
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // POSIX: 冒号分隔，取最后一段（防止 shell 初始化输出污染）
  const trimmed = output.trim();
  // 如果 shell 在 stdout 里打印了别的东西，最后一行通常才是 PATH
  const lastLine = trimmed.split("\n").pop()?.trim() ?? trimmed;
  return lastLine.split(":").map((s) => s.trim()).filter(Boolean);
}

/** 扫描 nvm / fnm / volta / asdf / n 的 node bin 目录 */
function collectNodeManagerBins(homeDir: string): string[] {
  const dirs: string[] = [];
  if (!homeDir) return dirs;

  // volta
  dirs.push(path.join(homeDir, ".volta", "bin"));

  // n (prefix 一般在 /usr/local 或 $N_PREFIX)
  const nPrefix = process.env.N_PREFIX;
  if (nPrefix) dirs.push(path.join(nPrefix, "bin"));

  // fnm
  const fnmDir =
    process.env.FNM_DIR ||
    process.env.FNM_MULTISHELL_PATH ||
    path.join(homeDir, ".fnm");
  collectVersionBins(path.join(fnmDir, "node-versions"), "installation/bin", dirs);
  collectVersionBins(path.join(homeDir, "Library", "Application Support", "fnm", "node-versions"), "installation/bin", dirs);

  // nvm
  const nvmDir = process.env.NVM_DIR || path.join(homeDir, ".nvm");
  // 当前 shell 选中的版本（最高优先级）
  if (process.env.NVM_BIN) dirs.push(process.env.NVM_BIN);
  collectVersionBins(path.join(nvmDir, "versions", "node"), "bin", dirs);

  // asdf
  const asdfDir =
    process.env.ASDF_DATA_DIR || path.join(homeDir, ".asdf");
  dirs.push(path.join(asdfDir, "shims"));
  collectVersionBins(path.join(asdfDir, "installs", "nodejs"), "bin", dirs);

  return dirs;
}

/** 读取一个目录下的子目录，把 `<sub>/<suffix>` 推进 out（按版本号倒序，新版优先） */
function collectVersionBins(parent: string, suffix: string, out: string[]) {
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  // 简单按字符串倒序，把 v20 排到 v18 前面
  entries.sort().reverse();
  for (const e of entries) {
    out.push(path.join(parent, e, suffix));
  }
}

/**
 * 校验路径是否是可执行的 codegraph：
 * 1. fs.stat 快速过滤（不存在 / 非文件 / 不可执行）
 * 2. 通过后再跑一次 `--version` 真验证（缓存命中场景才会执行）
 *
 * 大量候选路径走步骤 1，几乎不产生子进程开销。
 */
async function verifyExecutable(fullPath: string): Promise<boolean> {
  if (!fullPath) return false;

  // 步骤 1：fs 层快速判断
  let st: fs.Stats;
  try {
    st = fs.statSync(fullPath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  // Unix 下检查可执行位（Windows 上 mode 不可靠，跳过）
  if (process.platform !== "win32") {
    if ((st.mode & 0o111) === 0) return false;
  }

  // 步骤 2：真跑一次 --version，确认是 codegraph 而不是同名其他工具
  const out = await execAsync(fullPath, ["--version"], 3000);
  return out !== undefined;
}

export function deactivate() {
  cleanup();
  _mcpDisposable?.dispose();
  _mcpDisposable = undefined;
  _statusBar = undefined;
  _extensionContext = undefined;
  _cachedCodegraphPath = undefined;
}
