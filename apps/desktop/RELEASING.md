# EdgeClaw Desktop — 发版指南

> 简短规则：**版本号必须和 git tag 一一对应**。`apps/desktop/package.json#version` 是
> 所有版本号的 source of truth；git tag `vX.Y.Z` 把它钉到具体 commit。release.sh
> 会校验这两件事，避免发出"找不到对应代码"的 DMG。

---

## TL;DR — 90% 的发版流程

```bash
# 1. 在 apps/desktop/ 下，bump 版本（自动改 package.json + 自动 git commit + 自动 git tag）
cd apps/desktop
npm version patch -m "release(desktop): v%s"   # 0.1.0 → 0.1.1（仅修 bug）
# 或：
npm version minor -m "release(desktop): v%s"   # 0.1.0 → 0.2.0（加新功能）
npm version major -m "release(desktop): v%s"   # 0.1.0 → 1.0.0（破坏性更新）

# 2. 写一行 CHANGELOG（顶部追加），git commit --amend 顺手补进去
$EDITOR ../../CHANGELOG.md
git commit --amend --no-edit

# 3. 推 commit + tag 到 origin
git push --follow-tags

# 4. 打包（脚本会校验 tag = HEAD = package.json#version）
bash scripts/release.sh --signed
```

---

## 何时 bump 哪段？SemVer 速记

| 改动类型 | bump 哪段 | 例子 |
|---|---|---|
| 仅修 bug，用户行为不变 | **patch** | 0.1.0 → 0.1.1（修了 provider test 误报 400） |
| 加新功能，向后兼容 | **minor** | 0.1.0 → 0.2.0（加了 provider test 弹窗） |
| 用户必须重装/重配，配置文件不兼容 | **major** | 0.x → 1.0.0；1.x → 2.0.0 |

**0.x 阶段（当前）**：所有破坏性改动都走 **minor** 即可，不必动 major——这是 SemVer 对
0.x 的"宽容期"约定。等到产品稳定再 `npm version major` 跳到 1.0.0。

---

## Pre-release（rc / beta）

发给少量用户验证、不公开宣传时用：

```bash
npm version prerelease --preid=rc -m "release(desktop): v%s"  # 0.2.0 → 0.2.1-rc.0
# 反复迭代：
npm version prerelease --preid=rc -m "release(desktop): v%s"  # → 0.2.1-rc.1
# 转正：
npm version 0.2.1 -m "release(desktop): v%s"
```

---

## tag 应该打在哪个分支？

| 场景 | tag 在哪 | 是否强制 |
|---|---|---|
| 本地测试（`--ad-hoc`） | 任意分支 | ❌ 不强制（可设 `ALLOW_UNTAGGED=1` 跳过） |
| Pre-release（`-rc.*`） | release 分支 / feature 分支 | 建议但不强制 |
| 正式 release（`--signed`） | **必须 main / master** | ✅ release.sh 在非 main 分支会拒绝 |

**为什么正式 release 要打在 main**：feature 分支被 squash merge 进 main 后，原 commit 仍然
存在但不在 main 历史里——tag 没丢，但 `git log main` 找不到，给人"我装的版本对应的代码消失了"
的错觉。打在 main 才能保证 tag → main commit 在一条线上。

---

## CHANGELOG 维护

`CHANGELOG.md` 在仓库根目录。每次 bump 之前在顶部追加一段：

```markdown
## v0.1.1 - 2026-04-30
### Added
- Settings → Models 加入 Provider/Entry "测试连接"功能
### Fixed
- 修复 provider-only 测试默认使用 gpt-4o-mini 导致 MiniMax/DeepSeek 等兼容网关误报 400
```

写不出 "Added" 段就只 bump patch，"Added" 多就 bump minor——这是个非常实用的判断器。

---

## 如果忘了打 tag 就跑了 release.sh

```
✗ No git tag 'v0.1.1' for version 0.1.1.
    先跑: (cd apps/desktop && npm version patch -m 'release(desktop): v%s')
    本地测试可加: ALLOW_UNTAGGED=1 bash scripts/release.sh --ad-hoc
```

按提示来即可。**不要**手动改 package.json 然后 `git tag v0.1.1` —— 用 `npm version`
让两件事原子化。

---

## 如果在 feature 分支上跑了 `--signed`

```
✗ release(--signed) requires main/master branch (current: feat/merged-0428-ui-v2)
    内部测试请用: bash scripts/release.sh --ad-hoc
    正式发版请: git checkout main && git merge --ff-only <branch>
```

签名构建对外发，必须从 main 出。如果硬要在 feature 分支签名（极少数 hotfix 场景），
设环境变量 `ALLOW_NON_MAIN_SIGNED=1` 强制。

---

## 一些常见陷阱

1. **不要在 release.sh 里自动 bump**——同一份代码在我电脑/你电脑会被打成两个版本号；
   rebase / 分支地狱直接送命。版本号必须由人在准备发版时显式 `npm version`。
2. **不要手动改 package.json 后忘了打 tag**——release.sh 会拦下，但养成 `npm version`
   的习惯就再也不会犯。
3. **不要把 tag 推到错的 remote**——`git push --follow-tags` 默认推 origin；如果你有
   多个 remote 要清楚自己在推谁。
4. **electron-builder 自动从 package.json 读 version**——这是 single source of truth，
   不要在 electron-builder.yml 里硬编码 version。

---

## 历史记录与版本溯源

- `apps/desktop/package.json#version`  ← single source of truth
- `git tag vX.Y.Z` 指向那个 commit
- DMG 文件名 `EdgeClaw-X.Y.Z-arm64.dmg` 来自 package.json
- macOS 顶部菜单栏 → **EdgeClaw → 关于 EdgeClaw** 显示：
  ```
  EdgeClaw
  Version 0.1.1
  build a2f682b · 2026-04-30
  Copyright © 2026 EdgeClaw Contributors. AGPL-3.0-or-later.
  ```
  （macOS 原生 About 面板，由 `app.setAboutPanelOptions()` 注入；不需要进 Settings）
- release.sh 末尾的 `Build` 行同样的三段信息，方便发包前核对

任何用户报 bug，让他打开"关于 EdgeClaw"截图，三个数字（version、git-sha、date）就能精确定位代码。

**Dev 模式**（`npm run dev`）下 `build-info.json` 不存在，About 面板会显示
`build` 那行为 `dev build`，与正式包视觉上一眼可分辨。
