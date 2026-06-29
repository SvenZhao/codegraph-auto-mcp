# CodeGraph Auto MCP

> **Languages**: [English](README.md) | [中文 (Chinese)](README.zh-CN.md)

A VS Code extension that **automatically registers the [CodeGraph](https://github.com/svenzhao/codegraph) MCP server** for GitHub Copilot, with built-in project initialization and re-index support — no manual `mcp.json` editing required.

## The Problem

[CodeGraph](https://github.com/svenzhao/codegraph) provides an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server so that GitHub Copilot can use codegraph's code intelligence tools (`codegraph_explore`, `codegraph_node`, etc.). However, there are several pain points:

1. **Per-workspace path** — CodeGraph needs `--path <workspace_root>` to function correctly, which varies per project.
2. **VS Code bug [#14166](https://github.com/microsoft/vscode-copilot-release/issues/14166)** — Globally configured MCP servers via `mcp.json` **do not auto-start** reliably.
3. **Shell environment race** — When VS Code starts, shell init files (`.zshrc`, etc.) may not be fully loaded yet, so the `codegraph` CLI might not be found in PATH initially.
4. **Project not initialized** — Even with the CLI installed, a project needs `codegraph init` to start indexing. Running this from the terminal is a context switch.

The result: developers spend time reloading windows, editing configs, or jumping to terminals — friction that this extension eliminates.

## Features

- 🚀 **Auto MCP registration** — registers CodeGraph MCP server with the correct workspace path via `registerMcpServerDefinitionProvider`
- 🔄 **Smart retry** — if the `codegraph` CLI isn't found on startup (shell env race), retries 3 times (2s/5s/10s), then shows a clickable status bar for manual retry
- 👁️ **File watcher** — monitors `.codegraph/` for changes; when you run `codegraph init` or `codegraph sync`, the extension auto-detects it and (re)registers the MCP server
- 🛠️ **Built-in commands** — run `CodeGraph: Initialize Project` and `CodeGraph: Force Re-index` directly from VS Code's command palette, no terminal needed
- 👆 **Clickable status bar** — status bar always shows current state; click it to trigger a full re-check at any time
- 🌐 **Cross-platform** — macOS, Linux, Windows (auto-detects `codegraph.cmd`)
- 📦 **Zero runtime dependencies** — lightweight, minimal code

## Commands

| Command | Title | Description |
|---------|-------|-------------|
| `codegraph.restart` | **CodeGraph: Restart MCP Server** | Full re-check: find CLI, verify init, register MCP |
| `codegraph.initProject` | **CodeGraph: Initialize Project** | Open a terminal and run `codegraph init --path <root>` |
| `codegraph.sync` | **CodeGraph: Force Re-index** | Open a terminal and run `codegraph sync` |

All commands are accessible via `Cmd+Shift+P` (or `Ctrl+Shift+P` on Windows/Linux).

## How It Works

```mermaid
flowchart TD
    A[VS Code starts] --> B{tryRegisterServer}
    B --> C[Find codegraph CLI]
    C -->|Not found| D[Retry 2s/5s/10s]
    D -->|Still not found| E[Show ❌ in status bar<br/>Click to retry]
    D -->|Found later| F
    C -->|Found| F[Check codegraph status]
    F -->|Not initialized| G[Show ⚠️ in status bar<br/>+ watch .codegraph/]
    G -->|User runs init<br/>(command or terminal)| H[Files change → debounce]
    H --> B
    F -->|Ready| I[Register MCP server ✅]
    I --> J[Watch .codegraph/ for<br/>future re-index]
    J -->|codegraph sync| B
```

### State coverage

| CLI installed | Project init'd | Status bar | What you can do |
|:---:|:---:|---|---|
| ❌ | ❌ | `$(error) Not found` | Install CLI → click status bar |
| ❌ | ✅ | `$(error) Not found` | (unlikely — init needs CLI) |
| ✅ | ❌ | `$(info) Not initialized` | Run **CodeGraph: Initialize Project** |
| ✅ | ✅ | `$(check) Ready` | Everything working |

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
code --install-extension codegraph-auto-mcp-*.vsix
```

To debug, open the project in VS Code and press `F5`.

## Requirements

- VS Code ^1.106.0 (with Copilot Chat)
- [CodeGraph CLI](https://github.com/svenzhao/codegraph) (`npm install -g @sven/codegraph`)
- A project initialized via `codegraph init`

## Architecture

The extension uses the official VS Code API `vscode.lm.registerMcpServerDefinitionProvider` to dynamically register the MCP server:

```typescript
vscode.lm.registerMcpServerDefinitionProvider("codegraph", {
  provideMcpServerDefinitions(_token) {
    return [
      new vscode.McpStdioServerDefinition(
        "CodeGraph",
        codegraphPath,
        ["serve", "--mcp", "--no-watch", "--path", workspaceRoot],
        undefined,
        "1.0.0"
      ),
    ];
  },
});
```

This is the same pattern used by [GitLens](https://www.gitkraken.com/lens) to register the GitKraken MCP server — a best practice for VS Code extensions that provide MCP services.

## Building

```bash
npm run build      # TypeScript 检查 + esbuild 打包
npm run compile    # 同 build
npm run watch      # 开发模式监听文件变更
npm run release    # 通过 standard-version 提升版本号并打 tag
npm run publish    # release + 发布到 VS Code Marketplace
```

## License

MIT
