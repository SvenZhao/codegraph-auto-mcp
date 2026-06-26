import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";

export function activate(context: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return;
  }

  // Find codegraph CLI in PATH
  const codegraphPath = resolveCodegraph();
  if (!codegraphPath) {
    const msg =
      "未找到 \`codegraph\` 命令。请确认已安装 (\`npm install -g @sven/codegraph\") " +
      "且环境变量 PATH 正确（如通过 \`code\` 命令启动 VS Code，可能未加载 shell 配置文件）。";
    vscode.window.showWarningMessage(`[CodeGraph Auto MCP] ${msg}`);
    return;
  }

  // Optional sanity check — log but never block registration
  try {
    const stdout = cp.execFileSync(codegraphPath, [
      "status", root, "--json",
    ], { encoding: "utf-8", timeout: 5000 });
    const status = JSON.parse(stdout);
    if (status.initialized) {
      console.log(
        `[codegraph-auto-mcp] CodeGraph ready: ${status.fileCount} files, ${status.nodeCount} symbols`
      );
    } else {
      console.log(
        `[codegraph-auto-mcp] 项目未初始化（在 ${root} 中运行 \`codegraph init\`）`
      );
    }
  } catch (err) {
    console.log(
      `[codegraph-auto-mcp] Status check skipped: ${err}`
    );
  }

  // Register the MCP server definition provider
  const disposable = vscode.lm.registerMcpServerDefinitionProvider(
    "codegraph",
    {
      provideMcpServerDefinitions(_token: vscode.CancellationToken) {
        return [
          new vscode.McpStdioServerDefinition(
            "CodeGraph",
            codegraphPath!,
            ["serve", "--mcp", "--no-watch", "--path", root],
            undefined,
            "1.0.0"
          ),
        ];
      },
    }
  );

  context.subscriptions.push(disposable);

  console.log(
    `[codegraph-auto-mcp] Registered CodeGraph MCP server for ${root}`
  );
}

function resolveCodegraph(): string | undefined {
  const envPath = process.env.PATH || "";
  const binaryName = process.platform === "win32"
    ? "codegraph.cmd"
    : "codegraph";

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
