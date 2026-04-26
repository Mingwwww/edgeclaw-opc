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
| H+12 | **里程碑 1**: 第一个 ad-hoc DMG，UI 能加载 | ⏳ 待跑 `npm run release:adhoc` |
| H+20 | **里程碑 2**: 端到端 chat 跑通 (需 ~/.edgeclaw/config.yaml) | ⏳ |
| H+24 | verify-dmg.sh 跑通 | ⏳ |
| H+30 | **里程碑 3**: signed + notarized DMG | ⏳ |

## 风险

| 风险 | 缓解 |
|---|---|
| Native 模块 (better-sqlite3 等) 与 bundled Node ABI 不匹配 | 用 `electron-rebuild` 或对 bundled Node 重编（通过 N-API 通常通） |
| claude-code-main 在 packaged App 内能不能找到 plugin 目录 | spawn 时设 `cwd=<resources>/repo/claude-code-main`，PLUGIN_DIR 显式传 |
| `~/.edgeclaw/config.yaml` 不存在导致首启 crash | onboarding flow 或 main.ts 检测后弹 dialog 引导 |
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
│   ├── preload.ts
│   └── server-manager.ts      # 改造自 OpenClaw GatewayManager
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

## 后续 follow-up

每个里程碑过后会更新该文件并附 git commit hash。

