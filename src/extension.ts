import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";

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

  // 3. Register MCP server
  const disposable = vscode.lm.registerMcpServerDefinitionProvider(
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
  context.subscriptions.push(disposable);

  statusBar.text = "$(check) CodeGraph: Ready";
  statusBar.tooltip = `CodeGraph MCP 服务器已注册 (${root})`;
  statusBar.show();
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

  for (const shell of [
    { bin: "/bin/zsh", args: ["-lc", "command -v codegraph 2>/dev/null || true"] },
    { bin: "/bin/bash", args: ["-lc", "command -v codegraph 2>/dev/null || true"] },
    { bin: "/bin/sh", args: ["-c", "command -v codegraph 2>/dev/null || true"] },
  ]) {
    try {
      const output = cp.execFileSync(shell.bin, shell.args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
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
  // Nothing to clean up; disposables are handled by VS Code
}
