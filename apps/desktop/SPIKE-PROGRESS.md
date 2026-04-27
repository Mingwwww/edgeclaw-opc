# Mac App v1 Spike Progress

> **Worktree**: `/Users/da/ws/edgeclaw-desktop-spike` (branch `spike/desktop-runtime`)
> **Started**: 2026-04-27
> **Goal**: 第一个能 ad-hoc + signed 安装并端到端跑通 chat 的 EdgeClaw.app

## 决策已锁

| 项 | 决定 |
|---|---|
| 目录 | `apps/desktop/` |
| 桌面框架 | Electron 39 (复用 OpenClaw 经验) |
| Web server | claudecodeui server (Node 22 LTS arm64) |
| Agent runtime | claude-code-main 整套源码 + bun runtime |
| 打包模式 | tar bundle + extraResources |
| Runtime 绑定 | `node-bin/node` + `bun-bin/bun` 都进 Resources |
| MVP-β | Developer ID signed + notarized DMG, no auto-update |

## 关键发现

1. **bun --compile 路径不可行**：`node:sqlite` polyfill 不全（claudecodeui/server-bundle 已留下证据）
2. **claudecodeui 已与 claude-code-main 联动**：通过 `CLAUDE_CODE_MAIN_DIR` env 找 dev tree，再 spawn `bun run preload.ts cli.tsx`
3. **CCR in-process**：embedded-ccr.js 直接加载 claude-code-main 的 router 模块，无独立 proxy 进程（除非用户用 `start.sh`）
4. **Health endpoint 已存在**：claudecodeui server `app.get('/health', ...)` at line 513
5. **SERVER_PORT 默认 3001**，由 `process.env.SERVER_PORT` 覆盖

## 时间线

| 时点 | 里程碑 | 状态 |
|---|---|---|
| H+0  | Worktree + 骨架建立 | ✅ 完成 |
| H+4  | 改造 release.sh 完成 | ✅ 完成 |
| H+8  | Electron main.ts + server-manager.ts 完成 | ✅ 完成 |
| H+9  | verify-dmg.sh 适配完成 | ✅ 完成 |
| H+10 | Node 22 + Bun 1.3.10 runtime 落盘 | ✅ 完成 (`resources/node-bin`, `resources/bun-bin`) |
| H+10 | TypeScript 编译通过 (`dist/main.js` etc.) | ✅ 完成 |
| H+12 | **里程碑 1**: 第一个 ad-hoc DMG (1.07GB)，server 可启动 | ✅ 完成 |
| H+13 | 修复 `edgeclaw-memory-core` 缺失 (新增第三个 tar bundle) | ✅ 完成 |
| H+13 | verify-dmg.sh 跑通 (Pass 25 / Warn 1 / Fail 0) | ✅ 完成 |
| H+15 | Onboarding 配置页 (内嵌 BrowserWindow + IPC 写 config.yaml) | ✅ 完成 |
| H+15 | DMG 体积优化 (tar --exclude dev deps 后从 1.07GB → 274MB) | ✅ 完成 |
| H+20 | **里程碑 2**: 端到端 chat 跑通 (UI 加载 + 实际请求 Claude) | ⏳ 待手动验证 |
| H+30 | **里程碑 3**: signed + notarized DMG | ⏳ |

## 风险

| 风险 | 缓解 |
|---|---|
| Native 模块 (better-sqlite3 等) 与 bundled Node ABI 不匹配 | 用 `electron-rebuild` 或对 bundled Node 重编（通过 N-API 通常通） |
| claude-code-main 在 packaged App 内能不能找到 plugin 目录 | spawn 时设 `cwd=<resources>/repo/claude-code-main`，PLUGIN_DIR 显式传 |
| ~~`~/.edgeclaw/config.yaml` 不存在导致首启 crash~~ | ✅ 已实现内嵌 onboarding 配置页（B 路线）|
| peekaboo 缺失 (computer-use MCP) | 非 v1 阻塞项，先跳过 |
| App size 超 1GB | 用 `tar --exclude` 砍 dev deps，目标 < 600MB DMG |

## 文件清单 (此 spike 产出)

```
apps/desktop/
├── package.json
├── tsconfig.json
├── electron-builder.yml
├── .gitignore
├── SPIKE-PROGRESS.md (本文件)
├── src/
│   ├── main.ts                # Electron 主进程
│   ├── preload.ts             # 暴露 window.edgeclaw + window.edgeclawOnboarding
│   ├── onboarding-window.ts   # 首启配置页 (BrowserWindow + IPC + 写 YAML)
│   └── server-manager.ts      # 改造自 OpenClaw GatewayManager
├── onboarding/
│   └── onboarding.html        # 单文件 HTML/CSS/JS 配置表单
├── resources/
│   ├── entitlements.mac.plist
│   └── icon.icns              # 后补
├── scripts/
│   ├── release.sh             # 改造自 OpenClaw release.sh
│   ├── verify-dmg.sh          # 改造自 OpenClaw verify-dmg.sh
│   ├── download-node.sh       # 几乎原样
│   ├── download-bun.sh        # 新增
│   └── notarize.js            # 改 bundleId
```

## 下一步操作 (复现实验)

```bash
cd /Users/da/ws/edgeclaw-desktop-spike/apps/desktop

# 1) 装 desktop app deps (electron + electron-builder)
npm install

# 2) 装 claudecodeui 和 claude-code-main 的 deps (打包要用)
(cd ../../claudecodeui && npm install)
(cd ../../claude-code-main && bun install)   # 或 npm install

# 3) 第一次 ad-hoc 构建 (本地测试，不签名)
npm run release:adhoc        # 大约 5-10 分钟

# 4) 验证产物
npm run verify:dmg -- dist-electron/EdgeClaw-0.1.0-arm64.dmg adhoc

# 5) Signed + notarized (需 keychain profile "EdgeClaw" 已配)
npm run release:signed
```

## 已知架构事实 (Milestone 1 后追加)

1. **三个 sibling tar bundle 必须共存**：claudecodeui 和 claude-code-main 都通过相对路径
   `../../../edgeclaw-memory-core/lib/index.js` 引入 memory-core，所以
   `Resources/{claudecodeui,claude-code-main,edgeclaw-memory-core}/` 必须并列存在。
   遗漏任一个都会导致 `ERR_MODULE_NOT_FOUND`。
2. **配置文件必须用 structured YAML schema**：claudecodeui 的 `load-env.js` 在
   import-time 调用 `applyConfigToProcessEnv`，会把 `process.env.SERVER_PORT` 之类
   覆盖成 config.yaml 里 `runtime.serverPort` 的值。也就是说 env 变量优先级低于
   YAML，所以 verify-dmg.sh 必须把动态 PORT 写进 YAML，不能只靠 env 注入。
3. **DMG 体积**：经 `tar --exclude` 剔除 dev deps（typescript/eslint/vite/vitest/
   playwright/rollup/esbuild/babel/types 等）+ examples/tests/__tests__/*.md 后，
   ad-hoc DMG 从 ~1.07GB 压到 **274MB**。bundle 内部仍是 561M (claudecodeui) +
   449M (claude-code-main) + 1M (memory-core)，但 DMG 用 `ULMO` (LZFSE) 压缩。
4. **Onboarding 流程**：首启时 main.ts 调 `ensureConfigOrOnboard()`：
   - 若 `~/.edgeclaw/config.yaml` 存在 → 直接进 ServerManager。
   - 不存在 → 弹一个 580×640 的 BrowserWindow 加载 `onboarding/onboarding.html`，
     用户选 provider 类型（anthropic/openai-chat/openai-responses）+ 填 baseUrl/
     apiKey/model，提交后通过 `ipcMain.handle('onboarding:save', ...)` 写一份
     最小 structured YAML（5 个字段，剩下交给 claudecodeui 的 deepMerge 默认值）。
   - 内置 4 个预设按钮：Anthropic 官方 / OpenRouter / MiniMax / OpenAI。

## Milestone 2 手动验证步骤

DMG 路径：`apps/desktop/dist-electron/EdgeClaw-0.1.0-arm64.dmg` (ad-hoc, 274MB)

### 路径 A — 用已有 `~/.edgeclaw/config.yaml` 快速验 chat

适用：本机已经跑过 `start.sh` / 现有 EdgeClaw 配置仍可用。

```bash
open /Users/da/ws/edgeclaw-desktop-spike/apps/desktop/dist-electron/EdgeClaw-0.1.0-arm64.dmg
# DMG 弹出后：
#   1) 把 EdgeClaw.app 拖到 Applications
#   2) 在 Applications 里 *右键 → 打开*（ad-hoc 必经）
#   3) Gatekeeper 会再问一次 → 允许
#   4) App 启动后会发现 ~/.edgeclaw/config.yaml 存在 → 跳过 onboarding
#   5) 主窗口加载 http://127.0.0.1:<port>/ 进入 claudecodeui
#   6) 发一条消息验证 MiniMax 回复
```

### 路径 B — 强制走新 onboarding 配置页

适用：要验证首启体验。

```bash
# 1) 把现有 config 备份挪走
mv ~/.edgeclaw/config.yaml ~/.edgeclaw/config.yaml.bak

# 2) 启动 App（上面同样的 open + 右键打开流程）
# 3) 应该看到 580×640 的 "EdgeClaw — 初始化" 窗口
# 4) 点 [MiniMax] 预设 → 自动填 baseUrl=https://api.minimaxi.com / type=anthropic /
#    model=MiniMax-M2.7-highspeed
# 5) 粘贴 EDGECLAW_API_KEY (来自 /Users/da/ws/edgeclaw-test-0422/.env)
# 6) 点 [保存并启动] → 窗口关闭，主 App 启动
# 7) 验证 chat

# 验完恢复原 config:
mv ~/.edgeclaw/config.yaml.bak ~/.edgeclaw/config.yaml
```

### 排查

- App 启动后白屏 / 转圈不停 → server 没起。看 `~/Library/Logs/EdgeClaw/` 或
  `Console.app` 里搜 `EdgeClaw`。
- "本地服务启动失败" dialog → 弹框里的 detail 文本就是 server 进程的 stderr 摘要。
- 端口冲突 → SERVER_PORT 在 config.yaml 里默认 0 (随机)，应不会冲突。

## 后续 follow-up

每个里程碑过后会更新该文件并附 git commit hash。

