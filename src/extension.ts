import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export function activate(context: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return;
  }

  // Verify .codegraph/codegraph.db exists to avoid registering a broken MCP
  const dbPath = path.join(root, ".codegraph", "codegraph.db");
  if (!fs.existsSync(dbPath)) {
    console.log(
      `[codegraph-auto-mcp] Skipping: ${dbPath} not found`
    );
    return;
  }

  // Check that codegraph CLI is available
  const codegraphPath = findCodegraph();
  if (!codegraphPath) {
    console.log(
      "[codegraph-auto-mcp] 'codegraph' binary not found in PATH"
    );
    return;
  }

  const disposable =
    vscode.lm.registerMcpServerDefinitionProvider("codegraph", {
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
    });

  context.subscriptions.push(disposable);

  console.log(
    `[codegraph-auto-mcp] Registered CodeGraph MCP server for ${root}`
  );
}

function findCodegraph(): string | undefined {
  // Look for codegraph in PATH
  const envPath = process.env.PATH || "";
  const paths = envPath.split(path.delimiter);
  const binaryName = process.platform === "win32"
    ? "codegraph.cmd"
    : "codegraph";

  for (const dir of paths) {
    const fullPath = path.join(dir, binaryName);
    try {
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

export function deactivate() {
  // Nothing to clean up; disposables are handled by VS Code
}
