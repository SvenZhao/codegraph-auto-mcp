import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as fs from "fs";
import * as net from "net";

let _mcpDisposable: vscode.Disposable | undefined;
let _statusBar: vscode.StatusBarItem;
let _codegraphPath: string | undefined;
let _root: string | undefined;
let _context: vscode.ExtensionContext | undefined;
let _mcpChangeEmitter: vscode.EventEmitter<void> | undefined;
let _extensionVersion = "0.0.0";
// Per-registration server version. Changing it on every registration forces
// VS Code to discard any stale (dead) cached server connection instead of
// reusing it — a reused dead connection surfaces as
// `TypeError: Cannot read properties of undefined (reading 'invoke')`.
let _mcpVersion = "1.0.0";
let _initTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
  _context = context;
  _extensionVersion = context.extension?.packageJSON?.version ?? "0.0.0";
  _statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );

  // Register commands EARLY — always available regardless of CLI/init state
  context.subscriptions.push(
    vscode.commands.registerCommand("codegraph.restart", () => doRestart(context)),
    vscode.commands.registerCommand("codegraph.initProject", () => doInit()),
    vscode.commands.registerCommand("codegraph.sync", () => doSync()),
    vscode.commands.registerCommand("codegraph.showMenu", () => doShowMenu(context)),
  );

  _root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!_root) {
    _statusBar.text = "$(warning) CodeGraph: No workspace";
    _statusBar.tooltip = "未打开工作区";
    _statusBar.show();
    return;
  }

  _codegraphPath = resolveCodegraph();
  if (!_codegraphPath) {
    _statusBar.text = "$(error) CodeGraph: Not found";
    _statusBar.tooltip =
      "未找到 codegraph 命令。请确认已安装 (npm install -g @sven/codegraph) 且环境变量 PATH 正确。";
    _statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    _statusBar.show();
    return;
  }

  // Register the MCP provider SYNCHRONOUSLY and IMMEDIATELY — before any async
  // work. Every project window runs this on open, and each project's daemon is
  // independent (rooted at its own `.codegraph`). Registration must NOT wait on
  // the `codegraph status` check: VS Code exposes the cached tool list to
  // Copilot the instant the window opens, so any gap between that moment and
  // provider registration is a window where a call routes to `undefined` →
  // `TypeError: ... (reading 'invoke')`. Readiness (daemon up, project indexed)
  // is handled lazily by `resolveMcpServerDefinition`.
  doRegisterMcp(context);

  // Status check runs afterwards purely to drive the status bar (init hint).
  void refreshInitStatus();
}

/**
 * Check whether this project is initialized and update the status bar.
 * Display-only — never gates registration. Each project is checked
 * independently against its own root.
 */
async function refreshInitStatus() {
  if (!_root || !_codegraphPath) { return; }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      cp.execFile(_codegraphPath!, ["status", _root!, "--json"], {
        encoding: "utf-8",
        timeout: 5000,
      }, (err, out) => {
        if (err) { reject(err); } else { resolve(out); }
      });
    });
    const result = JSON.parse(stdout);
    if (!result.initialized) {
      _statusBar.text = "$(info) CodeGraph: Not initialized";
      _statusBar.tooltip = "项目未初始化，点击查看操作菜单";
      _statusBar.command = "codegraph.showMenu";
      _statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      _statusBar.show();
    }
  } catch {
    // Status check failed — leave whatever doRegisterMcp set on the status bar.
  }
}

async function doRegisterMcp(context: vscode.ExtensionContext) {
  if (!_root || !_codegraphPath) { return; }

  const codegraphDir = path.join(_root, ".codegraph");
  const sockPath = path.join(codegraphDir, "daemon.sock");
  const isInitialized = fs.existsSync(codegraphDir);

  // Bump the server version on every (re)registration so VS Code never reuses a
  // stale/dead cached server connection from a previous session.
  _mcpVersion = `${_extensionVersion}+${Date.now()}`;

  // Dispose previous registration if any (restart)
  _mcpDisposable?.dispose();
  _mcpChangeEmitter?.dispose();

  // Create change event emitter for this registration
  _mcpChangeEmitter = new vscode.EventEmitter<void>();

  // CRITICAL: register the provider IMMEDIATELY, do NOT block on prewarm.
  // VS Code caches the tool list across sessions and exposes those tools to
  // Copilot the moment the window opens. If we delayed registration by
  // awaiting a (≤15s) prewarm, there would be a window where the cached tools
  // are callable but no provider exists to resolve/start the server → the call
  // routes to `undefined` → `TypeError: ... (reading 'invoke')`.
  // Readiness is instead guaranteed lazily by `resolveMcpServerDefinition`
  // below, which VS Code awaits before actually starting the server. Prewarm
  // now runs in the background purely to make that first call fast.
  _mcpDisposable = vscode.lm.registerMcpServerDefinitionProvider(
    "codegraph",
    {
      onDidChangeMcpServerDefinitions: _mcpChangeEmitter.event,
      provideMcpServerDefinitions(_token: vscode.CancellationToken) {
        return [
          new vscode.McpStdioServerDefinition(
            "CodeGraph",
            _codegraphPath!,
            ["serve", "--mcp", "--path", _root!],
            undefined,
            _mcpVersion
          ),
        ];
      },
      // Verification gate: verify daemon is truly responsive via hello
      // handshake. If socket exists but hello fails, daemon is stuck/crashed —
      // clean up and respawn.
      async resolveMcpServerDefinition(
        server: vscode.McpStdioServerDefinition,
        _token: vscode.CancellationToken
      ) {
        // 项目未初始化 → 跳过 daemon 验证，不自动 init
        if (!fs.existsSync(path.join(_root!, ".codegraph"))) {
          return server;
        }

        const ok = await verifyDaemonHello(sockPath, 3000);
        if (!ok) {
          // Daemon unresponsive — clean up stale state and respawn
          const pidPath = path.join(_root!, ".codegraph", "daemon.pid");
          try {
            if (fs.existsSync(pidPath)) {
              const raw = fs.readFileSync(pidPath, "utf-8").trim();
              // Lockfile is JSON: { pid, version, socketPath, startedAt }
              // Be tolerant of legacy plain-pid format too.
              let pid: number | undefined;
              try {
                const info = JSON.parse(raw);
                pid = typeof info.pid === "number" ? info.pid : undefined;
              } catch {
                pid = parseInt(raw, 10);
              }
              if (pid && Number.isFinite(pid)) {
                try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
              }
            }
          } catch { /* ignore */ }
          try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
          try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
          // Spawn fresh daemon and wait for hello
          await prewarmDaemon(_codegraphPath!, _root!, 15000);
        }
        return server;
      },
    }
  );
  context.subscriptions.push(_mcpDisposable);

  // Provider is live immediately.
  // 只在已初始化时显示预热状态并后台 prewarm；未 init 的状态栏由 refreshInitStatus 更新
  if (isInitialized) {
    _statusBar.text = "$(loading~spin) CodeGraph: Warming up...";
    _statusBar.tooltip = "MCP 已注册，daemon 预热中（首次调用前完成即可）";
    _statusBar.command = "codegraph.showMenu";
    _statusBar.backgroundColor = undefined;
    _statusBar.show();

    // Background prewarm — does NOT gate registration. Its only job is to make
    // the first real tool call fast. Correctness (daemon truly ready before a
    // call runs) is still guaranteed by resolveMcpServerDefinition above.
    const changeEmitter = _mcpChangeEmitter;
    const registeredVersion = _mcpVersion;
    void prewarmDaemon(_codegraphPath, _root, 15000).then((ready) => {
      // Ignore if a newer registration superseded this one (e.g. restart).
      if (_mcpVersion !== registeredVersion) { return; }
      if (ready) {
        _statusBar.text = "$(check) CodeGraph: Ready";
        _statusBar.tooltip = "CodeGraph MCP 已注册，daemon 已就绪";
        _statusBar.command = "codegraph.showMenu";
        _statusBar.backgroundColor = undefined;
        // Notify VS Code the definition is now backed by a ready daemon so it
        // re-resolves against the live connection instead of any stale handle.
        try { changeEmitter?.fire(); } catch { /* ignore */ }
      } else {
        _statusBar.text = "$(check) CodeGraph: Ready";
        _statusBar.tooltip =
          "MCP 已注册；daemon 预热超时，首次调用可能需冷启动";
        _statusBar.command = "codegraph.showMenu";
        _statusBar.backgroundColor = undefined;
      }
      _statusBar.show();
    });
  } else {
    // 不设 status bar，由 refreshInitStatus 异步更新为 "Not initialized"
  }
}

async function doRestart(context: vscode.ExtensionContext) {
  // Re-resolve CLI path (settings may have changed)
  _codegraphPath = resolveCodegraph();
  if (!_codegraphPath) {
    vscode.window.showErrorMessage("CodeGraph: 未找到 codegraph CLI");
    return;
  }
  // Kill daemon
  if (_root) {
    const sockPath = path.join(_root, ".codegraph", "daemon.sock");
    const pidPath = path.join(_root, ".codegraph", "daemon.pid");
    try {
      if (fs.existsSync(pidPath)) {
        const raw = fs.readFileSync(pidPath, "utf-8").trim();
        // Lockfile is JSON: { pid, version, socketPath, startedAt }
        // Be tolerant of legacy plain-pid format too.
        let pid: number | undefined;
        try {
          const info = JSON.parse(raw);
          pid = typeof info.pid === "number" ? info.pid : undefined;
        } catch {
          pid = parseInt(raw, 10);
        }
        if (pid && Number.isFinite(pid)) {
          process.kill(pid, "SIGTERM");
        }
      }
    } catch { /* ignore */ }
    // Wait for socket to disappear (daemon fully dead) before proceeding
    for (let i = 0; i < 20; i++) {
      if (!fs.existsSync(sockPath)) { break; }
      await new Promise(r => setTimeout(r, 200));
    }
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
  }
  await doRegisterMcp(context);
  vscode.window.showInformationMessage("CodeGraph: MCP 服务器已重启");
}

async function doInit() {
  if (!_codegraphPath || !_root) { return; }
  // Dispose previous init terminal to avoid accumulation on repeated calls
  try { _initTerminal?.dispose(); } catch { /* ignore */ }
  _initTerminal = vscode.window.createTerminal("CodeGraph Init");
  _initTerminal.sendText(`cd "${_root}" && ${_codegraphPath} init`);
  _initTerminal.show();

  // Watch for .codegraph directory creation (init completion)
  const codegraphDir = path.join(_root, ".codegraph");
  let initHandled = false;
  const watcher = fs.watch(_root, async (eventType, filename) => {
    if (initHandled) { return; }
    // Fast path: skip events clearly unrelated to .codegraph.
    // filename can be null on macOS (rename/delete events), in which case we
    // fall through to check .codegraph directory existence directly.
    if (filename && filename !== ".codegraph" && !filename.startsWith(".codegraph")) {
      return;
    }
    if (fs.existsSync(codegraphDir)) {
      initHandled = true;
      watcher.close();
      // Clean up terminal (init command has completed)
      try { _initTerminal?.dispose(); } catch { /* ignore */ }
      _initTerminal = undefined;
      // Give init a moment to finish writing index files
      await new Promise(r => setTimeout(r, 1000));
      _statusBar.text = "$(check) CodeGraph: Initialized";
      _statusBar.tooltip = "正在注册 MCP...";
      _statusBar.show();
      const action = await vscode.window.showInformationMessage(
        "CodeGraph: 项目已初始化，是否注册 MCP？",
        "注册"
      );
      if (action === "注册" && _context) {
        await doRegisterMcp(_context);
      }
    }
  });
  // Auto-close watcher after 5 minutes (also clean up terminal)
  setTimeout(() => {
    try { watcher.close(); } catch { /* ignore */ }
    try { _initTerminal?.dispose(); } catch { /* ignore */ }
    _initTerminal = undefined;
  }, 300_000);
}

async function doSync() {
  if (!_codegraphPath || !_root) { return; }
  _statusBar.text = "$(loading~spin) CodeGraph: Syncing...";
  _statusBar.command = "codegraph.showMenu";
  _statusBar.show();
  try {
    await new Promise<void>((resolve, reject) => {
      cp.execFile(_codegraphPath!, ["sync", _root!], {
        encoding: "utf-8",
        timeout: 30000,
      }, (err) => {
        if (err) { reject(err); } else { resolve(); }
      });
    });
    _statusBar.text = "$(check) CodeGraph: Synced";
    vscode.window.showInformationMessage("CodeGraph: 索引已更新");
  } catch (err: any) {
    _statusBar.text = "$(error) CodeGraph: Sync failed";
    vscode.window.showErrorMessage(`CodeGraph: sync 失败 - ${err.message}`);
  }
  setTimeout(() => {
    // Only reset to Ready if the status bar still shows our sync result text,
    // not if another operation has since updated it.
    const cur = _statusBar.text;
    if (cur === "$(check) CodeGraph: Synced" || cur === "$(error) CodeGraph: Sync failed") {
      _statusBar.text = "$(check) CodeGraph: Ready";
    }
  }, 3000);
}

async function doShowMenu(context: vscode.ExtensionContext) {
  const items: vscode.QuickPickItem[] = [
    { label: "$(sync) Restart MCP Server", description: "重启 daemon 并重新注册" },
    { label: "$(repo) Initialize Project", description: "运行 codegraph init" },
    { label: "$(refresh) Force Re-index", description: "强制重新索引" },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "CodeGraph 操作",
  });
  if (!picked) { return; }
  if (picked.label.includes("Restart")) {
    await doRestart(context);
  } else if (picked.label.includes("Initialize")) {
    await doInit();
  } else if (picked.label.includes("Re-index")) {
    await doSync();
  }
}

/**
 * Connect to the daemon socket and read the hello line.
 * The daemon writes a JSON line on every new connection:
 *   { "codegraph": "<version>", "pid": <n>, "socketPath": "<path>", "protocol": 1 }
 * This is the SAME handshake the codegraph proxy uses to verify readiness.
 * If we can read + parse + validate it, the daemon engine is up and ready
 * to serve MCP requests — not just listening on the socket.
 */
function verifyDaemonHello(sockPath: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (result: boolean) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => done(false), timeoutMs);
    const socket = net.createConnection(sockPath);
    socket.setTimeout(timeoutMs);
    socket.setEncoding("utf8");

    let buf = "";
    socket.on("data", (chunk: string) => {
      if (settled) { return; }
      buf += chunk;
      // Bound buffer against malicious/oversized hello
      if (buf.length > 4096) {
        done(false);
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        try {
          const hello = JSON.parse(line);
          if (
            typeof hello.codegraph === "string" &&
            typeof hello.pid === "number" &&
            typeof hello.socketPath === "string" &&
            hello.protocol === 1
          ) {
            done(true);
          } else {
            done(false);
          }
        } catch {
          done(false);
        }
      }
    });

    socket.on("timeout", () => { socket.destroy(); done(false); });
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
  });
}

/**
 * 预热 daemon：spawn launcher → 轮询 daemon.sock → hello 握手验证 → 关闭 launcher
 * 关键：仅 socket 文件存在不等于 daemon 就绪（仅代表 bind() 完成）。
 * 必须通过 hello 握手确认 engine 已起来，否则首次 MCP 调用会失败。
 */
async function prewarmDaemon(
  codegraphPath: string,
  root: string,
  timeoutMs = 15000
): Promise<boolean> {
  const codegraphDir = path.join(root, ".codegraph");
  const sockPath = path.join(codegraphDir, "daemon.sock");

  // 项目未初始化 → 不 spawn daemon（避免自动创建 .codegraph 目录）
  if (!fs.existsSync(codegraphDir)) {
    return false;
  }

  // Daemon 已存在 → 直接验证 hello
  if (fs.existsSync(sockPath)) {
    return await verifyDaemonHello(sockPath, 3000);
  }

  // Spawn launcher（它会启动 detached daemon）
  const child = cp.spawn(
    codegraphPath,
    ["serve", "--mcp", "--path", root],
    { stdio: ["ignore", "ignore", "ignore"], detached: true }
  );
  child.unref();

  // 轮询：socket 出现后立刻做 hello 握手
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(sockPath)) {
      const ready = await verifyDaemonHello(sockPath, 3000);
      if (ready) {
        // Daemon 已就绪 → 关掉我们的 prewarm launcher
        // daemon 是 detached 进程，会继续存活
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        return true;
      }
      // socket 在但 hello 失败 → daemon 还在初始化，继续轮询
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // 超时：杀掉 launcher
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  return false;
}

function resolveCodegraph(): string | undefined {
  const envPath = process.env.PATH || "";
  const homeDir = process.env.HOME || "";
  const binaryName =
    process.platform === "win32" ? "codegraph.cmd" : "codegraph";

  const candidateDirs = new Set<string>();
  const addDir = (dir?: string) => {
    if (dir) {
      candidateDirs.add(dir);
    }
  };

  // Step 1: VS Code 用户设置（最高优先级，逃生舱）
  const configPath = vscode.workspace.getConfiguration("codegraph").get<string>("path");
  if (configPath) {
    const resolved = path.isAbsolute(configPath)
      ? configPath
      : path.resolve(configPath);
    if (isExecutable(resolved)) {
      return resolved;
    }
  }

  // Step 2: 环境变量
  const explicitPath = process.env.CODEGRAPH_PATH || process.env.CODEGRAPH_BIN;
  if (explicitPath) {
    const resolved = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.resolve(explicitPath);
    if (isExecutable(resolved)) {
      return resolved;
    }
  }

  for (const dir of envPath.split(path.delimiter)) {
    addDir(dir);
  }

  for (const prefix of [
    process.env.npm_config_prefix,
    process.env.NPM_CONFIG_PREFIX,
  ]) {
    addDir(prefix ? path.join(prefix, "bin") : undefined);
  }

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

  for (const dir of candidateDirs) {
    const fullPath = path.join(dir, binaryName);
    if (isExecutable(fullPath)) {
      return fullPath;
    }
  }

  // Shell fallback: use vscode.env.shell (user's configured shell) first
  const userShell = vscode.env.shell || process.env.SHELL || "";
  const shellCandidates: { bin: string; args: string[] }[] = [];

  if (userShell) {
    const isFish = userShell.includes("fish");
    if (isFish) {
      shellCandidates.push({
        bin: userShell,
        args: ["-il", "-c", "type -s codegraph"],
      });
    } else {
      shellCandidates.push({
        bin: userShell,
        args: ["-lic", "command -v codegraph 2>/dev/null || true"],
      });
    }
  }

  // Fallback to common shells
  for (const fallback of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (fallback !== userShell) {
      shellCandidates.push({
        bin: fallback,
        args: ["-lc", "command -v codegraph 2>/dev/null || true"],
      });
    }
  }

  for (const shell of shellCandidates) {
    try {
      const output = cp.execFileSync(shell.bin, shell.args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      // Take last line to avoid shell init stdout pollution
      const lines = output.trim().split("\n");
      const resolved = lines[lines.length - 1].trim();
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
  _mcpDisposable?.dispose();
  _mcpDisposable = undefined;
  _mcpChangeEmitter?.dispose();
  _mcpChangeEmitter = undefined;
  _codegraphPath = undefined;
  _root = undefined;
}
