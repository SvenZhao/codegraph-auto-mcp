import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as fs from "fs";

export function activate(context: vscode.ExtensionContext) {
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    statusBar.text = "$(warning) CodeGraph: No workspace";
    statusBar.tooltip = "未打开工作区";
    statusBar.show();
    return;
  }

  // 1. Look for codegraph CLI
  const codegraphPath = resolveCodegraph();
  if (!codegraphPath) {
    statusBar.text = "$(error) CodeGraph: Not found";
    statusBar.tooltip =
      "未找到 codegraph 命令。请确认已安装 (npm install -g @sven/codegraph) 且环境变量 PATH 正确。";
    statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    statusBar.show();
    return;
  }

  // 2. Check project initialization
  try {
    const stdout = cp.execFileSync(codegraphPath, [
      "status",
      root,
      "--json",
    ], { encoding: "utf-8", timeout: 5000 });
    const result = JSON.parse(stdout);
    if (!result.initialized) {
      statusBar.text = "$(info) CodeGraph: Not initialized";
      statusBar.tooltip = `项目未初始化，在 ${root} 中运行 \`codegraph init\``;
      statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      statusBar.show();
      return;
    }
  } catch (err) {
    // Status check failed, still try to register
  }

  // 3. Prewarm daemon before registration
  statusBar.text = "$(loading~spin) CodeGraph: Starting...";
  statusBar.tooltip = "正在预热 daemon...";
  statusBar.show();

  prewarmDaemon(codegraphPath, root).then((success) => {
    if (!success) {
      statusBar.text = "$(warning) CodeGraph: Prewarm failed";
      statusBar.tooltip = "daemon 预热失败，工具调用可能不稳定";
      statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    }

    // 4. Register MCP server
    const disposable = vscode.lm.registerMcpServerDefinitionProvider(
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
    context.subscriptions.push(disposable);

    statusBar.text = "$(check) CodeGraph: Ready";
    statusBar.tooltip = `CodeGraph MCP 服务器已注册 (${root})，服务由 daemon 提供，首次调用可能需冷启动`;
    statusBar.backgroundColor = undefined;
    statusBar.show();
  });
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
    const child = cp.spawn(
      codegraphPath,
      ["serve", "--mcp", "--path", root],
      { stdio: ["pipe", "ignore", "ignore"], detached: true }
    );
    child.unref();

    const start = Date.now();
    const poll = setInterval(() => {
      if (fs.existsSync(sockPath)) {
        clearInterval(poll);
        clearTimeout(timer);
        // 杀 launcher，detached daemon 独立存活
        try { child.kill(); } catch { /* ignore */ }
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        clearTimeout(timer);
        try { child.kill(); } catch { /* ignore */ }
        resolve(false);
      }
    }, 200);

    const timer = setTimeout(() => {
      clearInterval(poll);
      try { child.kill(); } catch { /* ignore */ }
      resolve(false);
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
  // Nothing to clean up; disposables are handled by VS Code
}
