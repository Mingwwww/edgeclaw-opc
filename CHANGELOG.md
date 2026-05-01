# EdgeClaw Desktop Changelog

All notable user-visible changes to the macOS desktop app are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Source of truth for version numbers: `apps/desktop/package.json#version`.
Each version below corresponds to a `vX.Y.Z` git tag — see `apps/desktop/RELEASING.md`.

---

## v0.1.3 - 2026-05-02

### Fixed
- 根治 Mac App 启动期连环 TCC 弹窗：getProjects() 不再在启动时 stat 用户项目目录（移除 detectTaskMasterFolder + package.json 读取）
- workspacesRoot 默认值改为 ~/，Mac App ↔ Web UI 行为一致

### Added
- Settings → Security 面板：可编辑的敏感路径黑名单（默认屏蔽 ~/.ssh、~/.aws、~/Library/Keychains 等 9 条路径），带安全警告
- validateWorkspacePath 接入可配置黑名单，plugin/MCP 无法访问受保护路径

### Changed
- Onboarding 精简为仅配置 API 凭证（移除"选择工作目录"步骤），减少首次启动的决策负担
- 项目 displayName 不再读取 package.json，直接使用文件夹名（零 fs 开销、零 TCC 风险）

---

## v0.1.2 - 2026-05-01

### Changed
- 替换默认 Electron 图标为 EdgeClaw 品牌图标（黑底红蟹 `.icns`），Dock / Launchpad / About 面板均生效
- 新增 Tray 图标素材（`trayIconTemplate @1x/2x/3x`），为后续 menu bar 常驻做准备

### Docs
- 新增 `docs/desktop-app/preferences-storage.md`：用户偏好存储设计提案

---

## v0.1.1 - 2026-05-01

### Added
- macOS 顶部菜单新增「帮助」菜单：在浏览器中打开本机 UI、复制本机地址、显示服务日志、显示配置文件夹、报告问题、项目主页（`apps/desktop/src/main.ts`）

### Changed
- 启动 splash 进度文案统一为「正在解压应用资源 (N/3)」，不再暴露内部 bundle 名（claudecodeui / claude-code-main / edgeclaw-memory-core）
- 「清理旧 bundle」与「解压 bundle」合并为单条 phase——清理是瞬时操作，splash 闪两次没有信息量
- 主窗口加载 URL 移除已废弃的 `?uiV2=1` query 参数（V2 已是唯一入口，参数无意义；详见 commit `2899ba5`）

### Fixed
- Help 菜单中「在浏览器中打开 / 复制本机地址」在服务重启窗口期会自动禁用，避免复制到失效端口

---

## v0.1.0 - 2026-04-30

EdgeClaw Desktop 首次公开 DMG（macOS arm64）。

### Highlights
- Electron shell + bundled claudecodeui server + bundled claude-code-main + edgeclaw-memory-core
- 首次启动 onboarding 流程（API 凭据填写）+ `~/.edgeclaw/config.yaml` 校验
- macOS About 面板显示 version + git sha + build date
- Developer ID Application 签名 + Apple notarization + DMG envelope stapling
