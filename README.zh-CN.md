# CodeGraph Auto MCP

> **语言**: [English](README.md) | [中文 (Chinese)](README.zh-CN.md)

让 GitHub Copilot **真正理解你的代码结构**——不只是文本搜索，而是通过 [CodeGraph](https://github.com/svenzhao/codegraph) MCP 获得 AST 级别的代码智能。

本扩展为 Copilot 自动注册 CodeGraph MCP 服务器。无需编辑 `mcp.json`，无需操心路径配置，装上就能用。

## ⚡ 快速上手

```bash
# 1. 安装 CodeGraph CLI
npm install -g @sven/codegraph
```

```
# 2. 安装本扩展（从 Releases 下载 VSIX，或从源码构建）
# 3. 打开任意项目 → Ctrl+Shift+P → "CodeGraph: Initialize Project"
# 4. 完成！Copilot 现在能结构性地理解你的代码库。
```

初始化后，Copilot 获得 `codegraph_explore` 等工具，能够遍历调用图、追踪数据流、理解跨文件依赖——远超纯文本上下文的能力。

## 为什么要用？

**没有 CodeGraph MCP** 时，Copilot 把你的代码当文本看。它能 grep 符号名、读你指向的文件、猜测关系。

**有了 CodeGraph MCP**，Copilot 获得整个代码库的预构建知识图谱：
- **调用图**——谁调用了这个函数？它又被谁调用？
- **数据流**——这个值从哪来？最终到哪去？
- **跨文件理解**——依赖、重导出、类型在模块间的传播
- **影响范围分析**——改这个符号会破坏什么？

结果：更准确的回答、更少幻觉的 API、真正尊重代码架构的修改。

## 特性

- 🚀 **零配置**——装上就用。自动查找 CLI、检测工作区路径、向 Copilot 注册 MCP
- 🔄 **自愈**——智能重试（2s/5s/10s），处理启动时 shell 环境竞争
- 👁️ **自动感知初始化**——文件监听器捕获 `codegraph init` / `codegraph sync`，无需重启
- 🛠️ **命令面板**——直接在 VS Code 中执行 `Initialize Project` 和 `Force Re-index`
- 👆 **状态栏**——始终显示当前状态；点击重试或访问命令
- 🌐 **跨平台**——macOS、Linux、Windows（自动识别 `codegraph.cmd`）
- 📦 **轻量**——零运行时依赖，打包后 ~20KB

## 命令

| 命令 | 说明 |
|------|------|
| `CodeGraph: Restart MCP Server` | 全流程重新检测：查找 CLI、验证初始化、注册 MCP |
| `CodeGraph: Initialize Project` | 为当前工作区运行 `codegraph init` |
| `CodeGraph: Force Re-index` | 运行 `codegraph sync` 重新索引项目 |

通过 `Cmd+Shift+P` / `Ctrl+Shift+P` 访问。

## 工作原理

扩展启动时执行一个简单的状态机：

1. **查找 CLI**——搜索 PATH、shell 环境、nvm/fnm/volta/asdf 目录、常见安装位置
2. **检查初始化**——运行 `codegraph status` 确认 `.codegraph/` 存在且有效
3. **预热 daemon**——预启动 codegraph daemon，避免 Copilot 首次调用时的冷启动延迟
4. **注册 MCP**——调用 `vscode.lm.registerMcpServerDefinitionProvider` 向 Copilot 暴露工具

任何步骤失败，状态栏会显示问题。`.codegraph/` 的文件监听器会在你执行 `codegraph init` 或 `codegraph sync` 后自动恢复。

## 安装

### 前提条件

- VS Code ^1.106.0 + GitHub Copilot
- [CodeGraph CLI](https://github.com/svenzhao/codegraph)：`npm install -g @sven/codegraph`

### 安装扩展

**从 [Releases](https://github.com/svenzhao/codegraph-auto-mcp/releases) 下载：**
1. 下载最新的 `.vsix`
2. VS Code → **Extensions: Install from VSIX...** → 选择文件

**从源码构建：**
```bash
git clone https://github.com/svenzhao/codegraph-auto-mcp.git
cd codegraph-auto-mcp
npm install && npm run build
code --install-extension codegraph-auto-mcp-*.vsix
```

## 开发者指南

### 架构

使用官方 VS Code API `vscode.lm.registerMcpServerDefinitionProvider`——与 GitLens 注册 MCP 服务器的模式相同：

```typescript
vscode.lm.registerMcpServerDefinitionProvider("codegraph", {
  provideMcpServerDefinitions(_token) {
    return [
      new vscode.McpStdioServerDefinition(
        "CodeGraph",
        codegraphPath,
        ["serve", "--mcp", "--path", workspaceRoot],
      ),
    ];
  },
});
```

CLI 查找使用 7 层降级：用户配置 → 缓存路径 → `PATH` → npm prefix → Node 版本管理器（nvm/fnm/volta/asdf/n）→ 常见目录 → shell `command -v`。

### 构建

```bash
npm run build      # 类型检查 + esbuild 打包
npm run watch      # 开发模式，监听文件变更
npm run release    # 提升版本号 + 打 tag（standard-version）
npm run publish    # release + 发布到 Marketplace
```

## 许可证

MIT
