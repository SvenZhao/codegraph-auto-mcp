# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.0.23](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.22...v0.0.23) (2026-07-07)


### Bug Fixes

* add resolveMcpServerDefinition as readiness gate + onDidChangeMcpServerDefinitions event ([3664ef5](https://github.com/SvenZhao/codegraph-auto-mcp/commit/3664ef5a71f2b92acf42ce0f36ddad267bf6c8f6))

### [0.0.22](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.21...v0.0.22) (2026-07-07)


### Bug Fixes

* prewarmDaemon exit handler race condition ([5ea16a6](https://github.com/SvenZhao/codegraph-auto-mcp/commit/5ea16a6eb67c54c434cee4a31cefae9ec489219a))

### [0.0.21](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.20...v0.0.21) (2026-07-07)


### Bug Fixes

* async status check + watcher debounce ([ea4a400](https://github.com/SvenZhao/codegraph-auto-mcp/commit/ea4a400eff151227351f8e8216ce0f6b3e54ffc0))

### [0.0.20](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.19...v0.0.20) (2026-07-07)


### Bug Fixes

* register commands before early returns + fs.watch filename null safety ([afa9b0b](https://github.com/SvenZhao/codegraph-auto-mcp/commit/afa9b0bb5be7456ffa7b31a42aaec6d63a27288e))

### [0.0.19](https://github.com/SvenZhao/codegraph-auto-mcp/compare/v0.0.18...v0.0.19) (2026-07-07)


### Bug Fixes

* 5 bugs - sync blocking, restart race, init re-activate, prewarm error, restart re-resolve ([e845ec6](https://github.com/SvenZhao/codegraph-auto-mcp/commit/e845ec6015881848f16064edbf6ef1928a22e178))

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
