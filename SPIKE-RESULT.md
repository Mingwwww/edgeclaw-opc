# EdgeClaw macOS App — Distribution Spike 结果报告

> Spike 目标：验证 EdgeClaw 能以"完全开源 + Developer ID 签名 + 公证 DMG"的方式，
> 一次双击安装并跑通端到端 chat。本报告是该 spike 的最终验收记录。
>
> 报告日期：2026-04-27 · 工作区：`edgeclaw-desktop-spike` (HEAD: `880b1aa`) · 平台：macOS Apple Silicon

---

## 1. TL;DR

- **DMG 已成品并通过 Apple 公证**：`apps/desktop/dist-electron/EdgeClaw-0.1.0-arm64.dmg`（275 MB）。
- **状态**：Developer ID 签名 ✅ · Apple notarize **Accepted** ✅ · ticket **stapled** ✅ · Gatekeeper `accepted` (`source=Notarized Developer ID`) ✅。
- **端到端 chat 跑通**：UI（uiV2 风格）加载、本地 server 起来、`claude-code-main` agent 子进程能正常返回模型回复。
- **打包结构**：单一 DMG，内含 Electron shell、bundled Node 22 + Bun 1.3、`claudecodeui` 前端 + server、`claude-code-main` agent runtime、`edgeclaw-memory-core`。
- **三层架构**就位：Electron shell（启动器/生命周期/onboarding）→ 本地 Node server（`claudecodeui`）→ Bun 子进程（`claude-code-main` agent）。
- **未做的**：自动更新、CLI 入口、多 workspace 切换、bundle 体积优化（详见第 7 节 follow-up）。

---

## 2. 产出清单

### 2.1 可直接发的 artifact

| 文件 | 路径 | 大小 |
|---|---|---|
| 已签名公证的 DMG | `apps/desktop/dist-electron/EdgeClaw-0.1.0-arm64.dmg` | 275 MB |
| 已 staple 的 .app | `apps/desktop/dist-electron/mac-arm64/EdgeClaw.app` | 1.4 GB |

DMG `md5`: `6bb36e9f5e5c60fcbba1a5983d774b01`

### 2.2 关键源码改动落地

新增/修改了以下"产品化"代码路径：

- `apps/desktop/`（新建 Electron shell 项目）
  - `src/main.ts` — Electron 入口（含 single-instance lock、动态端口、健康检查、`?uiV2=1` URL 注入）
  - `src/server-manager.ts` — Node server 子进程托管 + 日志 → `~/.edgeclaw/desktop.server.log`
  - `src/preload.ts` / `onboarding/` — 缺 `~/.edgeclaw/config.yaml` 时的 in-app 配置页
  - `electron-builder.yml` — Hardened Runtime + entitlements + DMG target
  - `scripts/release.sh` — 一键打包/签名/公证脚本
  - `resources/entitlements.mac.plist`、`resources/icon.icns`
- `claudecodeui/server/services/edgeclawConfig.js` — 让运行时优先读取环境变量（`SERVER_PORT` / `HOST` / `EDGECLAW_PROXY_PORT` / `ANTHROPIC_*`），保证 Electron 注入端口能生效。
- `claudecodeui/server/load-env.js` — 在 server 启动入口应用 `~/.edgeclaw/config.yaml` 派生的运行时环境。

### 2.3 Bundle 内容（DMG 解开后 `Contents/Resources/`）

```
Contents/Resources/
├── claudecodeui-bundle.tar        546 MB   # 前端 dist + server + 必要 node_modules
├── claude-code-main-bundle.tar    439 MB   # Bun-based agent runtime + skills
├── edgeclaw-memory-core-bundle.tar 615 KB
├── node-bin/node                  103 MB   # bundled Node v22.14.0 (modules 127, NAPI 10)
└── bun-bin/bun                    58 MB    # bundled Bun 1.3.10
```

- `app.asar` 内为编译后的 Electron shell（dist/）+ onboarding 页面。
- 三个 tar 在首次启动时解压到 `~/Library/Application Support/EdgeClaw/runtime/`。

---

## 3. 三层架构 — 跑通的形态

```
                ┌────────────────────────────────────┐
                │ Electron shell (cc.edgeclaw.desktop) │
                │  · single-instance lock              │
                │  · 动态分配 SERVER_PORT              │
                │  · spawn Node child + 健康检查        │
                │  · BrowserWindow + ?uiV2=1 注入       │
                │  · onboarding （缺 config.yaml 时）   │
                └────────────────────┬───────────────┘
                                     │ child_process.spawn
                                     ▼
                ┌────────────────────────────────────┐
                │ Node 22 child: claudecodeui/server  │
                │  · http://127.0.0.1:<port>           │
                │  · /health /api ...                  │
                │  · stdio piped → desktop.server.log  │
                │  · 内部 spawn proxy + bun child      │
                └────────────────────┬───────────────┘
                                     │ child_process.spawn (bun)
                                     ▼
                ┌────────────────────────────────────┐
                │ Bun 1.3 child: claude-code-main      │
                │  · src/entrypoints/cli.tsx           │
                │  · text-loader 加载 skill .md        │
                │  · 通过 ANTHROPIC_BASE_URL 走代理     │
                └────────────────────────────────────┘
```

启动流程在 spike 中已用 `~/.edgeclaw/config.yaml` 驱动，端到端 chat 走通。

---

## 4. Milestones — 完成情况

| # | Milestone | 状态 | 关键证据 |
|---|---|---|---|
| 1 | App 双击能起来、UI 加载 | ✅ | 安装后 Dock 出现图标 → BrowserWindow 加载 `127.0.0.1:<port>/?uiV2=1` |
| 2 | 端到端 chat 跑通（UI 实际请求 Claude） | ✅ | 手动从 UI 发送消息、`cli.tsx` 子进程返回模型回复（修复 markdown bundle 后） |
| 3 | Developer ID 签名 + 公证 DMG | ✅ | submission `e94cd7d9-c5e4-4856-b104-f1e484b62844` → `Accepted` + stapled |
| native | bundled native module 在 bundled Node 下可用 | ✅ | `better-sqlite3@12.6.2` / `node-pty@1.1.0` / `bcrypt@6.0.0` 三件套 smoke test 全 OK |
| spike-result | 写本报告 | ✅ | 即本文件 |

---

## 5. 验证证据

### 5.1 codesign (.app)

```
Identifier=cc.edgeclaw.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 flags=0x10000(runtime)
Authority=Developer ID Application: Beijing ModelBest Technology Co., Ltd. (77Y5JFSH6H)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=77Y5JFSH6H
Timestamp=Apr 27, 2026 at 11:50:31
```

### 5.2 Apple notarize

```
xcrun notarytool history --keychain-profile EdgeClaw
  · createdDate: 2026-04-27T03:26:59Z
    id:          e94cd7d9-c5e4-4856-b104-f1e484b62844
    name:        EdgeClaw-notarize.zip
    status:      Accepted    ← 本次成品
  · createdDate: 2026-04-27T02:55:59Z
    id:          c606daba-ab73-4a6c-a9cc-67dcab9283a6
    status:      Invalid     ← 第一次失败（原因见 §6）
```

### 5.3 staple + Gatekeeper

```
$ xcrun stapler validate EdgeClaw.app
The validate action worked!

$ spctl -a -vv -t open EdgeClaw.app
EdgeClaw.app: accepted
source=Notarized Developer ID
origin=Developer ID Application: Beijing ModelBest Technology Co., Ltd. (77Y5JFSH6H)
```

### 5.4 release.sh 内置 smoke test 结果

```
── 5. Bundle extraction smoke test ──
  ✓ claudecodeui-bundle.tar extracted (537M)
  ✓ server/index.js present
  ✓ dist/index.html (vite build) present
  ✓ claude-code-main-bundle.tar extracted (425M)
  ✓ src/entrypoints/cli.tsx present
  ✓ preload.ts present
  ✓ edgeclaw-memory-core-bundle.tar extracted (592K)

── 6. claudecodeui server smoke test ──
  ✓ Server responding on http://127.0.0.1:<port>/health
  ✓ Server terminated cleanly

── Summary ──
  Pass: 28    Warn: 0    Fail: 0
```

### 5.5 native module smoke test（bundled Node v22.14.0）

| Module | 版本 | 结果 |
|---|---|---|
| `better-sqlite3` | 12.6.2 (darwin-arm64) | ✅ 内存数据库 CRUD OK |
| `node-pty` | 1.1.0 | ✅ `spawn /bin/sh` 能拿到 stdout |
| `bcrypt` | 6.0.0 | ✅ hash + compare OK |

测试覆盖了 a) 已安装 `/Applications/EdgeClaw.app/Contents/Resources/claudecodeui` 路径 和 b) 源工作区 `claudecodeui/` 路径，结论一致。

### 5.6 端到端 chat（UI → 模型回复）

- 安装后 BrowserWindow 加载 `127.0.0.1:<port>/?uiV2=1`，UI 显示 v2 风格。
- 在 UI 输入框发消息，server 日志显示 spawn `bun run cli.tsx`，子进程返回正常的 assistant text。
- 同样的 `cli.tsx` 用 ad-hoc 命令在 `.app` 内部直接执行，可拿到 `"Hi! How can I help you today?"` 的回复，证明 bundle 完整 + 环境注入正确。

---

## 6. Spike 中暴露并修复的问题清单

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 安装后 Dock 有图标但无窗口，60s 后弹窗"Server health check failed" | a) `claudecodeui` 总是按 `config.yaml` 端口（3001）监听，不理会 Electron 注入的 `SERVER_PORT`；b) child stdio = `inherit`，看不到崩溃原因 | `edgeclawConfig.js` 改为环境变量优先；`server-manager.ts` 改为 `pipe` 并写 `~/.edgeclaw/desktop.server.log`；强制 `HOST=127.0.0.1` |
| 2 | 端到端 chat 无回复 | `release.sh` 用 `--exclude='**/*.md'` / `--exclude='**/examples'` 通配，把 `claude-code-main/src/skills/bundled/verify/*.md` 一起吃掉了，Bun text-loader 找不到 module | tar exclusion 限定到 `node_modules/...`；source 树里的 `*.md`、`examples/` 不再被剥离 |
| 3 | UI 不是 v2 风格 | `useIsUiV2()` 需要 `?uiV2=1` 或 `VITE_UI_V2`，但 `main.ts` 的 `loadURL` 没带参数 | `main.ts` 在两处 `loadURL` URL 末尾追加 `?uiV2=1` |
| 4 | 第一次公证 `Invalid`，submission `c606daba-ab73-...` | tar 包内有未签名 ripgrep `rg` 二进制（6 个，覆盖 `arm64-darwin` / `x64-darwin` / `aarch64-apple-darwin`），Apple notary 会递归扫 archive 内的 Mach-O；`release.sh` 签名步骤只 cover `*.node/*.dylib/*.so/*.bare/spawn-helper`，把 `rg` 漏了 | 扩展 `find` 模式：增加 `-o \( -name "rg" -path "*darwin*" \)`，并把搜索根加上 `claude-code-main/src`（因为 `src/utils/vendor/ripgrep/...` 里也有 `rg`）。第二次公证 `Accepted`。已签名 native 二进制数从 46 → 52。 |
| 5 | 重装 DMG 时，`/Applications/EdgeClaw.app` 没被覆盖 | EdgeClaw 后台进程没退；旧 DMG mount 没卸 | reinstall 流程加 `pkill -9 -f EdgeClaw` + `hdiutil detach -force` |

> 详细诊断过程及命令痕迹保留在 chat transcript 中。

---

## 7. Follow-ups（spike 之外、需要在 v1.x / v2 解决）

按优先级排序。每条都附建议规模评估。

### 7.1 高优先级

- **bundle 体积压缩**（**~1 GB 节省空间**）  
  当前 `tar.gz` 没启用，纯 `tar`；首次启动会同时存在 `*.tar` 和解压后的目录，磁盘占用 ~2× 浪费。  
  建议：a) `tar.zst`/`tar.gz` 压缩；b) 解压后删 tar；c) `node_modules` 走 `npm prune --production` + 抽掉 dev/test 资源；d) 评估 `electron-builder` 的 `asarUnpack` 替代方案。
- **自动更新**  
  v1 故意没做。建议接 `electron-updater` + GitHub Releases / 自托管 squirrel server。需要 release flow 同时签名 + 公证 ZIP（不仅 DMG）。
- **CLI 入口**  
  当前 `claudeApiContent.ts` 引用了未来才会有的 `claude-api/` 目录（仓库里实际不存在），那批 skill 不会 load 但不影响 chat。日后若要 enable，需要补回 `claude-api/` 内容。
- **`stapled` ticket revoke 测试**  
  尚未在断网环境验证 staple 后还能离线启动；建议加进 release 验收清单。

### 7.2 中优先级

- **多 workspace 切换 + Keychain 化 API key**  
  `~/.edgeclaw/config.yaml` 当前是明文存的。生产形态应：a) Electron 启动后用 macOS Keychain 存 `ANTHROPIC_API_KEY`；b) 单独存非敏感 workspace 列表；c) onboarding 不直接写 yaml。
- **健康检查升级**  
  `/health` 当前只看 server 是否回 200。后续应该再 ping 一次 agent runtime（`bun cli.tsx --print`）保证 chat 真的能跑。
- **崩溃上报与诊断包**  
  目前用户报障只能让其手动 `cat ~/.edgeclaw/desktop.server.log`。建议加 in-app "导出诊断 zip"（含日志、版本、bundle hash、配置脱敏副本）。
- **release.sh 阶段性缓存**  
  现在 `--skip-build` 只跳 vite。`tar` 重打 ~5 min 是冷热路径都要走的。建议根据 `git rev-parse` + 文件 mtime 做内容哈希缓存。

### 7.3 低优先级 / 工程债

- **测试体系**：spike 没写自动化测试；建议加一条 release 前必跑的 e2e（`spawn .app → curl /health → POST /api/chat → assert 非空响应`）。
- **签名脚本独立化**：`release.sh` 已经接近 400 行；`[3] Sign native binaries` 的 find 规则和 `[7] Apple notarization` 的 zip/notarytool 调用建议拆出 `scripts/sign-natives.sh` / `scripts/notarize.sh`，便于单步 retry。
- **Universal binary**：当前 arm64 only。Intel Mac 用户需要补 x64 build（涉及交叉编译 native module + bundled runtime）。
- **VERSION/CHANGELOG**：`apps/desktop/package.json` 用的是 `0.1.0`；需要建立 release 节奏 + tag 策略。

---

## 8. 重新构建/分发的命令速查

```bash
cd /Users/da/ws/edgeclaw-desktop-spike/apps/desktop

bash scripts/release.sh --signed                  # 全流程：build + sign + notarize + DMG + verify
bash scripts/release.sh --signed --skip-build     # 复用 vite dist
bash scripts/release.sh --signed --skip-notarize  # 仅签名（CI debug 用）
bash scripts/release.sh --ad-hoc                  # 本机 smoke test，不签名
```

依赖的环境约束：
- Apple 证书：`Developer ID Application: Beijing ModelBest Technology Co., Ltd. (77Y5JFSH6H)` 必须在登录 keychain。
- `notarytool` keychain profile 名为 **`EdgeClaw`**（`xcrun notarytool store-credentials EdgeClaw ...`）。
- bundled runtime：`apps/desktop/resources/node-bin/node` (v22.14.0) 与 `apps/desktop/resources/bun-bin/bun` (1.3.10)。

---

## 9. 安装与首跑步骤（用户视角）

1. 双击 `EdgeClaw-0.1.0-arm64.dmg`。
2. 拖 `EdgeClaw.app` 到 `Applications`。
3. 第一次启动若没有 `~/.edgeclaw/config.yaml`，Electron 会显示 onboarding 页，让用户填 API key（写到 yaml）。
4. 首次启动会解压 `claudecodeui` / `claude-code-main` / `edgeclaw-memory-core` 三个 tar 到 `~/Library/Application Support/EdgeClaw/runtime/`，约 30–60 秒。
5. 完成后 BrowserWindow 加载 `127.0.0.1:<port>/?uiV2=1`，进入 chat 界面。

如卡在第 4 步：`tail -f ~/.edgeclaw/desktop.server.log`。

---

## 10. 结论

Spike 三个 milestone 全部达成。
EdgeClaw 已经具备**对外分发的最小闭环**：用户拿到 DMG → 双击 → 装入 Applications → 首次启动配 API key → 端到端跑通 chat。

下一阶段建议按 §7.1 的"高优先级 follow-up"展开：先压 bundle、加自动更新，再做多 workspace + Keychain 化 key。
