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
    console.log(
      "[codegraph-auto-mcp] 'codegraph' binary not found in PATH"
    );
    return;
  }

  // Use "codegraph status" (official API) to check if the project is initialized
  try {
    const stdout = cp.execFileSync(codegraphPath, [
      "status", root, "--json",
    ], { encoding: "utf-8", timeout: 5000 });
    const status = JSON.parse(stdout);
    if (!status.initialized) {
      console.log(
        `[codegraph-auto-mcp] Project not initialized (run "codegraph init" in ${root})`
      );
      return;
    }
    console.log(
      `[codegraph-auto-mcp] CodeGraph ready: ${status.fileCount} files, ${status.nodeCount} symbols`
    );
  } catch (err) {
    console.log(
      `[codegraph-auto-mcp] Failed to check status: ${err}`
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
