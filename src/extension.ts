import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as os from "os";

export function activate(context: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return;
  }

  // Find codegraph CLI — try PATH first, then common install locations
  const codegraphPath = resolveCodegraph();
  if (!codegraphPath) {
    console.log(
      "[codegraph-auto-mcp] 'codegraph' binary not found in PATH"
    );
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
        `[codegraph-auto-mcp] Project not initialized (run "codegraph init" in ${root})`
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

  console.log(
    `[codegraph-auto-mcp] Registered CodeGraph MCP server for ${root}`
  );
}

/** Common directories where codegraph might be installed outside $PATH. */
const COMMON_BIN_DIRS = (() => {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm_global/bin"),
    path.join(home, ".local/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, "go/bin"),
  ];
})();

function resolveCodegraph(): string | undefined {
  const binaryName =
    process.platform === "win32" ? "codegraph.cmd" : "codegraph";

  // Collect candidates from PATH and common locations
  const candidates: string[] = [];
  const envPath = process.env.PATH || "";
  for (const dir of envPath.split(path.delimiter)) {
    if (dir.trim()) {
      candidates.push(path.join(dir.trim(), binaryName));
    }
  }
  for (const dir of COMMON_BIN_DIRS) {
    candidates.push(path.join(dir, binaryName));
  }

  // Try each — first match wins
  const seen = new Set<string>();
  for (const fullPath of candidates) {
    if (seen.has(fullPath)) continue;
    seen.add(fullPath);
    try {
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
