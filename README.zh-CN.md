# CodeGraph Auto MCP

> **语言**: [English](README.md) | [中文 (Chinese)](README.zh-CN.md)

一个 VS Code 扩展，**为 GitHub Copilot 自动注册 [CodeGraph](https://github.com/svenzhao/codegraph) MCP 服务器**，内置项目初始化与重索引支持——无需手动编辑 `mcp.json`。

## 问题

[CodeGraph](https://github.com/svenzhao/codegraph) 提供了 [MCP（模型上下文协议）](https://modelcontextprotocol.io) 服务器，让 GitHub Copilot 可以使用 codegraph 的代码智能工具（`codegraph_explore`、`codegraph_node` 等）。但实际使用中存在几个痛点：

1. **工作区路径不固定**——CodeGraph 需要 `--path <workspace_root>` 参数，每个项目不同。
2. **VS Code Bug [#14166](https://github.com/microsoft/vscode-copilot-release/issues/14166)**——全局 `mcp.json` 配置的 MCP 服务器**不会自动启动**。
3. **Shell 环境竞争**——VS Code 启动时，shell 初始化文件（`.zshrc` 等）可能尚未加载完毕，导致 `codegraph` CLI 暂时找不到。
4. **项目尚未初始化**——即使 CLI 已安装，项目也需要先执行 `codegraph init`。跑去终端执行是一个上下文切换成本。

结果就是：开发者需要反复重载窗口、编辑配置、或跳转到终端——这些摩擦正是本扩展要消除的。

## 特性

- 🚀 **自动 MCP 注册**——通过 `registerMcpServerDefinitionProvider` 为每个工作区自动注册 CodeGraph MCP 服务器
- 🔄 **智能重试**——启动时若 `codegraph` CLI 找不到（shell 环境竞争），自动重试 3 次（2s/5s/10s），仍失败则显示可点击的状态栏供手动重试
- 👁️ **文件监听**——监听 `.codegraph/` 目录变化；你执行 `codegraph init` 或 `codegraph sync` 后，扩展自动感知并（重新）注册 MCP 服务器
- 🛠️ **内置命令**——在命令面板中直接运行 **CodeGraph: Initialize Project** 和 **CodeGraph: Force Re-index**，无需打开终端
- 👆 **状态栏可点击**——状态栏始终显示当前状态；点击即可触发全流程重新检测
- 🌐 **跨平台**——macOS、Linux、Windows（自动识别 `codegraph.cmd`）
- 📦 **零运行时依赖**——轻量级，代码精炼

## 命令

| 命令 | 标题 | 说明 |
|------|------|------|
| `codegraph.restart` | **CodeGraph: Restart MCP Server** | 全流程重新检测：查找 CLI、验证初始化、注册 MCP |
| `codegraph.initProject` | **CodeGraph: Initialize Project** | 在终端中执行 `codegraph init --path <root>` |
| `codegraph.sync` | **CodeGraph: Force Re-index** | 在终端中执行 `codegraph sync` |

所有命令可通过 `Cmd+Shift+P`（Windows/Linux 为 `Ctrl+Shift+P`）执行。

## 工作原理

```mermaid
flowchart TD
    A[VS Code 启动] --> B{tryRegisterServer}
    B --> C[查找 codegraph CLI]
    C -->|找不到| D[重试 2s/5s/10s]
    D -->|仍找不到| E[状态栏显示 ❌<br/>点击重试]
    D -->|后续找到| F
    C -->|找到| F[检查 codegraph status]
    F -->|未初始化| G[状态栏显示 ⚠️<br/>+ 监听 .codegraph/]
    G -->|用户执行 init<br/>(命令或终端)| H[文件变化 → 防抖]
    H --> B
    F -->|已就绪| I[注册 MCP 服务器 ✅]
    I --> J[持续监听 .codegraph/<br/>用于后续重索引]
    J -->|codegraph sync| B
```

### 状态覆盖

| CLI 已安装 | 项目已初始化 | 状态栏显示 | 你可以做什么 |
|:---:|:---:|---|---|
| ❌ | ❌ | `$(error) Not found` | 安装 CLI → 点击状态栏 |
| ❌ | ✅ | `$(error) Not found` | （极少见——init 需要 CLI） |
| ✅ | ❌ | `$(info) Not initialized` | 执行 **CodeGraph: Initialize Project** |
| ✅ | ✅ | `$(check) Ready` | 一切正常 |

## 安装

### 通过 VSIX 安装

1. 从 [Releases](https://github.com/svenzhao/codegraph-auto-mcp/releases) 下载最新的 `.vsix` 文件
2. 在 VS Code 中运行 **Extensions: Install from VSIX...**
3. 选择下载的文件

### 从源码构建

```bash
git clone https://github.com/svenzhao/codegraph-auto-mcp.git
cd codegraph-auto-mcp
npm install
npm run build
code --install-extension codegraph-auto-mcp-*.vsix
```

要调试，在 VS Code 中打开项目并按 `F5`。

## 前提条件

- VS Code ^1.106.0（带 Copilot Chat）
- [CodeGraph CLI](https://github.com/svenzhao/codegraph)（`npm install -g @sven/codegraph`）
- 项目已通过 `codegraph init` 初始化

## 架构

本扩展使用官方 VS Code API `vscode.lm.registerMcpServerDefinitionProvider` 动态注册 MCP 服务器：

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

这与 [GitLens](https://www.gitkraken.com/lens) 注册 GitKraken MCP 服务器所使用的模式完全相同——这是 VS Code 扩展提供 MCP 服务的最佳实践。

## 构建

```bash
npm run build      # TypeScript 编译检查 + esbuild 打包
npm run compile    # 同 build
npm run watch      # 开发模式监听文件变更
npm run release    # 通过 standard-version 提升版本号并打 tag
npm run publish    # release + 发布到 VS Code Marketplace
```

## 许可证

MIT
