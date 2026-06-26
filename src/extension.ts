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
  const binaryName =
    process.platform === "win32" ? "codegraph.cmd" : "codegraph";

  for (const dir of envPath.split(path.delimiter)) {
    try {
      const fullPath = path.join(dir, binaryName);
      cp.execFileSync(fullPath, ["--version"], {
        encoding: "utf-8",
        stdio: "ignore",
        timeout: 1000,
      });
      return fullPath;
    } catch {
      continue;
    }
  }

  return undefined;
}

export function deactivate() {
  // Nothing to clean up; disposables are handled by VS Code
}
