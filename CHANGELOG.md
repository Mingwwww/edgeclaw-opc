# EdgeClaw Desktop Changelog

All notable user-visible changes to the macOS desktop app are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Source of truth for version numbers: `apps/desktop/package.json#version`.
Each version below corresponds to a `vX.Y.Z` git tag — see `apps/desktop/RELEASING.md`.

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
