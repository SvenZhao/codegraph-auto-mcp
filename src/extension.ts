import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as fs from "fs";

let _mcpDisposable: vscode.Disposable | undefined;
let _statusBar: vscode.StatusBarItem;
let _codegraphPath: string | undefined;
let _root: string | undefined;
let _context: vscode.ExtensionContext | undefined;

export function activate(context: vscode.ExtensionContext) {
  _context = context;
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

  // Check init & register MCP
  doActivate(context);
}

async function doActivate(context: vscode.ExtensionContext) {
  if (!_root || !_codegraphPath) { return; }

  // Check project initialization (async — don't block extension host)
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
      _statusBar.tooltip = `项目未初始化，点击初始化`;
      _statusBar.command = "codegraph.initProject";
      _statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      _statusBar.show();
      return;
    }
  } catch {
    // Status check failed, still try to register
  }

  await doRegisterMcp(context);
}

async function doRegisterMcp(context: vscode.ExtensionContext) {
  if (!_root || !_codegraphPath) { return; }

  _statusBar.text = "$(loading~spin) CodeGraph: Starting...";
  _statusBar.tooltip = "正在预热 daemon...";
  _statusBar.backgroundColor = undefined;
  _statusBar.show();

  const success = await prewarmDaemon(_codegraphPath, _root);
  if (!success) {
    _statusBar.text = "$(warning) CodeGraph: Prewarm failed";
    _statusBar.tooltip = "daemon 预热失败，工具调用可能不稳定";
    _statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }

  // Dispose previous registration if any (restart)
  _mcpDisposable?.dispose();

  _mcpDisposable = vscode.lm.registerMcpServerDefinitionProvider(
    "codegraph",
    {
      provideMcpServerDefinitions(_token: vscode.CancellationToken) {
        return [
          new vscode.McpStdioServerDefinition(
            "CodeGraph",
            _codegraphPath!,
            ["serve", "--mcp", "--path", _root!],
            undefined,
            "1.0.0"
          ),
        ];
      },
    }
  );
  context.subscriptions.push(_mcpDisposable);

  _statusBar.text = "$(check) CodeGraph: Ready";
  _statusBar.tooltip = `CodeGraph MCP 已注册，服务由 daemon 提供`;
  _statusBar.command = undefined;
  _statusBar.backgroundColor = undefined;
  _statusBar.show();
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
        const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
        if (pid) { process.kill(pid, "SIGTERM"); }
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
  const terminal = vscode.window.createTerminal("CodeGraph Init");
  terminal.sendText(`cd "${_root}" && ${_codegraphPath} init`);
  terminal.show();

  // Watch for .codegraph directory creation (init completion)
  const codegraphDir = path.join(_root, ".codegraph");
  let initHandled = false;
  const watcher = fs.watch(_root, async (eventType, filename) => {
    if (initHandled) { return; }
    // Fast path: skip events clearly unrelated to .codegraph
    if (filename && filename !== ".codegraph" && !filename.startsWith(".codegraph")) {
      return;
    }
    if (fs.existsSync(codegraphDir)) {
      initHandled = true;
      watcher.close();
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
  // Auto-close watcher after 5 minutes
  setTimeout(() => { try { watcher.close(); } catch { /* ignore */ } }, 300_000);
}

async function doSync() {
  if (!_codegraphPath || !_root) { return; }
  _statusBar.text = "$(loading~spin) CodeGraph: Syncing...";
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
    if (_statusBar.text.includes("Sync")) {
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
 * 预热 daemon：spawn launcher → 轮询 daemon.sock → 杀 launcher
 * detached daemon 独立存活，后续 VS Code spawn 的 launcher 会 fast-path 连到已就绪的 daemon
 */
async function prewarmDaemon(
  codegraphPath: string,
  root: string,
  timeoutMs = 12000
): Promise<boolean> {
  const sockPath = path.join(root, ".codegraph", "daemon.sock");

  // daemon 已经跑着，直接复用
  if (fs.existsSync(sockPath)) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (result: boolean) => {
      if (settled) { return; }
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(result);
    };

    const child = cp.spawn(
      codegraphPath,
      ["serve", "--mcp", "--path", root],
      { stdio: ["pipe", "ignore", "ignore"], detached: true }
    );
    child.unref();

    child.on("error", () => { done(false); });
    // Don't call done() on exit — launcher exits before daemon finishes starting.
    // The daemon is detached and continues running after launcher exits.
    // Socket detection is handled by the poll interval; timeout handles daemon crash.

    const start = Date.now();
    const poll = setInterval(() => {
      if (fs.existsSync(sockPath)) {
        done(true);
      } else if (Date.now() - start > timeoutMs) {
        done(false);
      }
    }, 200);

    const timer = setTimeout(() => {
      done(false);
    }, timeoutMs + 1000);
  });
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
        args: ["-il", "-c", "command -s codegraph"],
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
  _codegraphPath = undefined;
  _root = undefined;
}
