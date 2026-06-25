# CodeGraph Auto MCP

A VS Code extension that **automatically registers the [CodeGraph](https://github.com/svenzhao/codegraph) MCP server** when you open a project containing a `.codegraph/` directory.

## Why?

VS Code has a [known bug](https://github.com/microsoft/vscode-copilot-release/issues/14166) where MCP servers configured in a **global** `mcp.json` do **not auto-start**. The server only becomes available after manually reloading the window or re-triggering the MCP discovery.

This extension works around that bug by using the official `registerMcpServerDefinitionProvider` API to dynamically register the CodeGraph MCP server. It activates automatically when it detects a `.codegraph/` directory in the workspace — no manual configuration needed.

## Features

- 🔄 **Auto-activation** — activates when opening any project that has `.codegraph/`
- ✅ **Dual validation** — checks both that `codegraph.db` exists and that the `codegraph` CLI is in PATH
- 🚀 **Zero config** — no `mcp.json` editing required
- 📦 **Lightweight** — minimal code, no dependencies beyond `@types/vscode`

## Installation

### From VSIX

1. Download the latest `.vsix` from [Releases](https://github.com/svenzhao/codegraph-auto-mcp/releases)
2. In VS Code, run **Extensions: Install from VSIX...**
3. Select the downloaded file

### From Source

```bash
git clone https://github.com/svenzhao/codegraph-auto-mcp.git
cd codegraph-auto-mcp
npm install
npm run build
```

Then press `F5` in VS Code to start debugging, or install the extension manually:

```bash
npm run build
code --install-extension codegraph-auto-mcp-0.0.1.vsix
```

## Usage

Once installed, the extension works automatically:

1. Open any project that has a `.codegraph/` directory with a `codegraph.db` file
2. Make sure the `codegraph` CLI is available in your PATH
3. The extension registers the CodeGraph MCP server — you can verify in VS Code's MCP server list
4. GitHub Copilot can now use CodeGraph tools (`codegraph_explore`, `codegraph_search`, `codegraph_node`, `codegraph_callers`) for code intelligence

### Requirements

- VS Code ^1.106.0 (with Copilot Chat)
- [CodeGraph CLI](https://github.com/svenzhao/codegraph) installed and in PATH
- A project with `.codegraph/` directory (initialized via `codegraph init`)

## How It Works

```mermaid
flowchart LR
    A[Open project<br/>with .codegraph/] --> B{Extension activates}
    B --> C[Check .codegraph/<br/>codegraph.db exists]
    B --> D[Find codegraph<br/>CLI in PATH]
    C --> E[Register MCP server<br/>via registerMcpServerDefinitionProvider]
    D --> E
    E --> F[Copilot can now use<br/>CodeGraph tools]
```

The extension calls `vscode.lm.registerMcpServerDefinitionProvider("codegraph", ...)` with a provider that returns a `McpStdioServerDefinition`. This tells VS Code to start the CodeGraph MCP server using:

```
codegraph serve --mcp --no-watch --path <workspace_root>
```

The server is registered with the ID `"codegraph"`, which matches the contribution in `contributes.mcpServerDefinitionProviders`.

## Building

```bash
npm run build      # compile TypeScript check + esbuild bundle
npm run compile    # same as build
npm run watch      # watch mode for development
```

## License

MIT
