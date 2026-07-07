# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.0.18](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.17...v0.0.18) (2026-07-07)


### Features

* read codegraph.path from VS Code settings (highest priority) ([ee0cc88](https://github.com/SvenZhao/codegraph-auto-mcp/commit/ee0cc8856f0b8878838fcc7b9056a4c3c9054fb8))

### [0.0.17](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.16...v0.0.17) (2026-07-07)


### Bug Fixes

* clean up module-level variables in deactivate() ([0f1e789](https://github.com/SvenZhao/codegraph-auto-mcp/commit/0f1e7890a8bbb6b7a417e36c6b3888c5b046d72a))

### [0.0.16](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.15...v0.0.16) (2026-07-07)


### Features

* register all commands (restart/init/sync/menu) ([b9e2f2c](https://github.com/SvenZhao/codegraph-auto-mcp/commit/b9e2f2c43c1c8c339248b462a62659843b354696))

### [0.0.15](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.14...v0.0.15) (2026-07-07)


### Bug Fixes

* use vscode.env.shell for CLI detection, respect user shell config ([6d77205](https://github.com/SvenZhao/codegraph-auto-mcp/commit/6d77205c866b0562437bb47dc26ac68be38b2f6f))

### [0.0.14](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.13...v0.0.14) (2026-07-07)


### Bug Fixes

* prewarm daemon before MCP registration & remove --no-watch ([01ae113](https://github.com/SvenZhao/codegraph-auto-mcp/commit/01ae1133b9e9d17170c7b955b1555bfe9c166bfe))

### [0.0.13](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.12...v0.0.13) (2026-07-03)

### [0.0.12](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.11...v0.0.12) (2026-07-03)


### Bug Fixes

* 注册前预热 daemon,消除 Copilot 调用撞 undefined.invoke 的时序窗口 ([42643a4](https://github.com/SvenZhao/codegraph-auto-mcp/commit/42643a4aa6e34784fbaa0f73869c1ae4850d3743))

### [0.0.11](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.10...v0.0.11) (2026-07-03)


### Bug Fixes

* 切断 .codegraph 监听反馈循环,修复"Ready 但 Copilot 调用卡死" ([312421b](https://github.com/SvenZhao/codegraph-auto-mcp/commit/312421b1f364e2e15992a7ff07c8ed643c279348))

### [0.0.10](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.9...v0.0.10) (2026-06-30)

### [0.0.9](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.8...v0.0.9) (2026-06-29)


### Features

* retry mechanism, file watcher, commands, and shell PATH fix ([ae232fd](https://github.com/SvenZhao/codegraph-auto-mcp/commit/ae232fded93cebc4e80b4d83d97e861983ab1934))

### [0.0.8](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.7...v0.0.8) (2026-06-26)

### [0.0.7](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.6...v0.0.7) (2026-06-26)
