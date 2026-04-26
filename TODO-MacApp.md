# TODO: EdgeClaw macOS App 分发方案

> 目标：把 EdgeClaw 做成可分发给外部用户安装的 Apple Silicon macOS App。
>
> 当前 `apps/electron` 只作为实验记录保留。正式方案需要重做 Electron packaging/runtime 层，保留现有 `claudecodeui`、`claude-code-main`、memory、plugin 等业务能力。

## 1. 当前结论

不建议全仓库从零开始。

建议：

- **废弃当前 `apps/electron` 的实现基础**：当前 Electron 壳、打包配置、`dist-electron` 产物、`.env` 打包方式、绝对路径资源引用都不适合作为可分发产品基础。
- **保留业务层**：`claudecodeui` 前端/server、`claude-code-main` 运行时能力、`edgeclaw-memory-core`、plugin/hook/skill 相关逻辑继续沿用。
- **重做桌面分发层**：新建干净的 Electron app runtime，专门负责启动本地 server、管理窗口、配置、签名、公证、自动更新。

关键原因：

- 当前 `main.js` 使用 `process.execPath` 启动 `server/index.js`，但打包后 `process.execPath` 是 `EdgeClaw.app/Contents/MacOS/EdgeClaw`。如果不设置 `ELECTRON_RUN_AS_NODE=1`，子进程会再次启动 Electron App，形成递归启动，可能把 Mac 卡死。
- 当前 `electron-builder.yml` 把本机 `.env` 打进 App，这是分发产品不能接受的密钥泄漏风险。
- 当前 `extraResources` 使用 `/Users/da/ws/...` 绝对路径，不具备可复现构建能力。
- 当前 `dist-electron` 是巨大构建产物，不应该进入 git。
- 当前方案固定 `SERVER_PORT=3001`，没有端口冲突处理、single-instance lock、健康检查、进程生命周期约束。

## 2. 产品约束

已确认：

- 目标用户：外部用户安装使用，不是只给本机自用。
- 平台：macOS Apple Silicon only。
- 分发：需要 Apple Developer ID 签名、公证、DMG 分发。
- 更新：需要 auto-update。
- 运行模式：App 必须自己启动本地 server。
- CLI 能力：用户不需要自己安装本机 Claude/Codex/Gemini CLI，EdgeClaw App 内置/托管运行时能力。
- API Key：用户自己填写 Claude/Codex/Gemini key。
- workspace：用户显式选择本机项目目录，EdgeClaw 在该 workspace 内运行 agent、shell、git、文件读写。

## 3. 推荐架构

### 3.1 App 分层

正式 App 分三层：

1. **Electron shell**
   - single instance lock
   - 窗口生命周期
   - 本地 server 启停
   - health check
   - auto-update
   - Keychain / config bridge
   - workspace 目录选择

2. **Local server runtime**
   - 从 `claudecodeui/server` 整理出的 production runtime
   - 监听 `127.0.0.1`
   - 使用动态端口或端口检测
   - 通过一次性 token 与 Electron 窗口通信
   - 只访问用户授权 workspace

3. **Agent runtime bundle**
   - 从 `claude-code-main` 整理出的受控运行时包
   - 包含运行所需代码、依赖、native module、版本信息
   - 不包含开发缓存、测试文件、本机 `.claude` 状态、本机绝对路径配置

### 3.2 启动流程

目标流程：

1. Electron App 启动。
2. 获取 single instance lock；如果已有实例，聚焦已有窗口并退出新实例。
3. 读取 `~/Library/Application Support/EdgeClaw` 下的非敏感配置。
4. 从 macOS Keychain 读取用户 API key。
5. 选择或恢复用户授权 workspace。
6. 分配本地端口，生成一次性 session token。
7. 启动 server child process。
8. 等待 `/healthz` 通过。
9. `BrowserWindow.loadURL(http://127.0.0.1:<port>/?uiV2=1&token=...)`。
10. App 退出时只清理自己拥有的 child process。

### 3.3 子进程要求

如果继续用 Electron 内置 Node 启动 server，必须满足：

- `env.ELECTRON_RUN_AS_NODE = '1'`
- server entrypoint 必须是明确的 runtime entrypoint，不直接依赖开发目录结构
- child process 需要 stdout/stderr 日志归档
- 启动超时后失败退出，不能循环重试 `open`
- 必须记录 pid，并只 kill 自己启动的 pid

更稳的中期方案：

- 构建一个 `server-runner` entrypoint，专门给 Electron child process 使用。
- `server-runner` 负责加载 production config、设置 `NODE_ENV=production`、启动 Express server、暴露 `/healthz`。
- Electron main 不直接理解业务 server 内部细节。

## 4. 打包策略

不建议把完整 repo 快照塞进 App。

建议构建阶段生成干净 artifact：

- `app/`：Electron shell 代码。
- `resources/web/`：`claudecodeui/dist`。
- `resources/server/`：server production 代码。
- `resources/runtime/claude-code-main/`：受控 agent runtime。
- `resources/memory/`：memory 必要运行资源。
- `resources/default-config/`：默认配置模板，不含密钥。

包含：

- 前端 build 产物。
- server 运行代码。
- production dependencies。
- 必要 native `.node` 模块，并通过 `asarUnpack` 处理。
- 默认配置模板。
- 图标、entitlements、签名配置。

不包含：

- `.env`
- `dist-electron`
- `/Users/da/...` 绝对路径
- dev dependencies
- 测试文件
- 构建缓存
- 用户 token / API key / session
- `.claude/settings.local.json`
- `.claude/session_scheduled_tasks.json`
- 未筛选的完整 `node_modules`

## 5. 配置与密钥

配置位置：

- 非敏感配置：`~/Library/Application Support/EdgeClaw/config.json`
- workspace 列表：`~/Library/Application Support/EdgeClaw/workspaces.json`
- 日志：`~/Library/Logs/EdgeClaw/`
- 缓存：`~/Library/Caches/EdgeClaw/`
- 敏感凭据：macOS Keychain

用户首次启动流程：

1. 输入 Claude/Codex/Gemini API key。
2. 写入 Keychain。
3. 选择默认 workspace。
4. App 启动本地 server。
5. server 从 Electron 注入的安全环境或 IPC bridge 获取必要凭据引用。

禁止：

- 把用户 key 写入 App bundle。
- 把本机 `.env` 打包。
- 把 key 写入普通日志。
- 在 URL query 中长期携带 API key。

## 6. Workspace 权限模型

“访问用户任意 workspace”指 EdgeClaw 是否能读写用户电脑上的项目目录，例如 `~/Projects/my-app`。

建议模型：

- 用户必须显式选择 workspace。
- App 只在已授权 workspace 中执行文件读写、shell、git、npm/test 命令。
- 每个 workspace 有独立会话、日志、权限状态。
- 默认不扫描全盘。
- 对 destructive 操作继续保留确认机制。

Electron 层需要提供：

- 选择目录 UI。
- 最近 workspace 列表。
- workspace path 验证。
- 将授权路径传给 local server。

server 层需要保证：

- API 请求不能绕过 workspace root 访问任意路径。
- shell cwd 必须落在授权 workspace 内。
- 文件上传、MCP、plugin hook 的路径也要受 workspace root 约束。

## 7. 签名、公证、更新

Apple Silicon only 可以简化为：

- build target: `mac.arm64`
- signing: Developer ID Application
- notarization: Apple notarytool
- distribution: signed + notarized DMG

需要从第一版开始固定：

- `appId`
- `productName`
- bundle identifier
- version 规则
- update channel
- release artifact 命名

auto-update 推荐：

- `electron-updater`
- `electron-builder`
- GitHub Releases / S3 / R2 / 私有更新服务任选其一
- arm64-only channel

注意：

- auto-update 要求签名链稳定。
- 公证失败不能绕过。
- 更新包不能包含本机密钥或本机构建残留。

## 8. 对当前 `apps/` 目录的处置

当前 `apps/` 目录按"实验废弃、保留记录、清理产物、重建正式层"处理。

### 8.1 Phase 0 已执行（整体改名方案）

在 `feat/turnkey-cc-plugin` 分支已完成以下动作（独立提交，不与 plugin/slash 主线混合）：

- 新增本文件 `TODO-MacApp.md` 作为正式方案记录。
- `git mv apps/electron apps/electron-archived`，整目录标记为实验存档。
  - 7 个跟踪文件保持原内容（`README.md`、`package.json`、`electron-builder.yml`、
    `src/{main,preload}.js`、`src/index.html`、`resources/entitlements.mac.plist`）。
  - 物理删除 `dist-electron/` 构建产物和 `node_modules/`。
  - 空 `scripts/` 目录一并清理。
- 在 `apps/electron-archived/README.md` 顶部加废弃 banner，末尾加勘误段，
  修正原文关于"macOS Sandbox 阻止启动外部二进制"和 `process.execPath` 直接启动 server
  的错误描述。
- 根 `.gitignore` 增补：

  ```text
  apps/electron-archived/dist-electron/
  apps/electron-archived/node_modules/
  ```

- 不再运行 `apps/electron-archived/dist-electron/mac-arm64/EdgeClaw.app` 做自动测试。

未做的事（有意保留）：

- 没有删除 `electron-builder.yml`、`src/main.js` 等跟踪源码。理由：保留递归启动、`.env`
  打包、绝对路径等反例作为事故复盘材料。整目录改名 + README banner 已经足够防止误运行
  （没人会在 `electron-archived/` 下跑 `npx electron-builder`）。
- 没有给 `main.js` 加 `throw` 守卫。改名后路径变化已经足够明显，加 throw 反而打断"作为
  反例阅读"的体验。

### 8.2 后续重建（新分支）

新 desktop 实现走独立分支 `feat/mac-app-runtime`，从 `feat/turnkey-cc-plugin` 合并入主线后切出。

- 在 `apps/desktop/` 下新建（不在 `apps/electron-archived/` 上改）。
- 推荐目录名：`apps/desktop`，避免未来扩展 Windows/Linux 时目录语义过窄。
- `apps/electron-archived/` 永久保留作为事故复盘材料；除非未来仓库瘦身，否则不删除。

推荐结构：

```text
apps/
  desktop/
    src/
      main/
      preload/
      renderer-shell/
    resources/
    scripts/
      build-runtime.mjs
      package-mac.mjs
      notarize.mjs
      smoke-test.mjs
    electron-builder.yml
    package.json
    README.md
```

### 8.3 git 分支策略

当前已经在 `feat/turnkey-cc-plugin` 分支上。

建议：

1. 本文件先提交到 `feat/turnkey-cc-plugin`，作为方案决策记录。
2. plugin/slash 修复继续在该分支推进。
3. Mac App 重建另起分支，例如 `feat/mac-app-runtime`，从 `feat/turnkey-cc-plugin` 或其合并后的主线切出。
4. 清理 `apps/electron/dist-electron` 可以作为 `feat/mac-app-runtime` 的第一批提交。

不建议：

- 在 plugin/slash 修复提交里夹带巨大 `dist-electron` 删除和 Electron 重构。
- 在未修 single-instance 与 `ELECTRON_RUN_AS_NODE` 前继续用当前 App 做自动化启动测试。
- 把构建产物提交到 git 后再依赖 `.gitignore` 补救。

## 9. 分阶段实施计划

### Phase 0: 止血（已完成）

实际采用整目录改名方案，详见 §8.1。已完成清单：

- [x] `git mv apps/electron apps/electron-archived`。
- [x] 物理删除 `dist-electron/`、`node_modules/`、空 `scripts/`、`.DS_Store`。
- [x] `.gitignore` 加入 `apps/electron-archived/dist-electron/` 和
      `apps/electron-archived/node_modules/`。
- [x] `apps/electron-archived/README.md` 顶部加废弃 banner，末尾加勘误段。
- [x] 停止使用当前递归启动风险 App 做测试。

验收：

- [x] `git status` 不再出现大量 `dist-electron` 未跟踪文件。
- [x] 没有自动脚本会反复 `open EdgeClaw.app`。
- [x] `apps/electron/` 目录不再存在；`apps/electron-archived/` 仅含 7 个跟踪源码文件，作为事故复盘材料。

### Phase 1: 新 desktop shell 骨架

- 新建 `apps/desktop`。
- 实现 Electron main/preload 最小骨架。
- 加入 single instance lock。
- 加入安全的 child process manager。
- 加入 health check。
- 加入日志目录。
- 加入 smoke test，测试只允许启动一次，并在超时后退出。

验收：

- 启动 App 不会产生多个 `EdgeClaw` 进程。
- server 启动失败时 App 显示错误页，不循环重启。
- smoke test 能断言进程数、端口、窗口加载状态。

### Phase 2: Server runtime artifact

- 从 `claudecodeui` 生成 production artifact。
- 前端 `vite build` 输出到 runtime。
- server 依赖裁剪为 production dependencies。
- native modules 标记 `asarUnpack`。
- 添加 `/healthz`。
- server 强制监听 `127.0.0.1`。

验收：

- `apps/desktop` 不依赖 `/Users/da/ws/...` 绝对路径。
- 打包后能在干净用户目录启动。
- 不读取 bundled `.env`。

### Phase 3: Agent runtime bundle

- 整理 `claude-code-main` 为受控 runtime。
- 排除测试、开发缓存、本机 `.claude` 状态。
- 明确 Codex/Gemini/Claude 的 provider 配置入口。
- 验证 plugin hook / slash / skill 能在 packaged runtime 中工作。

验收：

- 用户不安装 CLI 也能调用内置 runtime。
- 用户 API key 来自 Keychain/config flow。
- packaged runtime 不含本机个人状态。

### Phase 4: Workspace 与凭据

- 首次启动配置向导。
- Keychain 写入/读取 API key。
- workspace picker。
- server API workspace root 校验。
- shell/git/file APIs 限定在授权 workspace。

验收：

- 未选择 workspace 时不能执行项目读写。
- 切换 workspace 后会话隔离。
- 日志不输出 key。

### Phase 5: 签名、公证、DMG、更新

- 配置 Developer ID 签名。
- 配置 Hardened Runtime 和 entitlements。
- 配置 notarization。
- 配置 `electron-updater`。
- 建立 arm64-only release channel。

验收：

- DMG 可在另一台 Apple Silicon Mac 安装打开。
- Gatekeeper 不拦截。
- auto-update 能从旧版本升级到新版本。

## 10. 测试护栏

禁止任何测试脚本执行无限循环启动。

所有 App 测试必须满足：

- 启动前检查是否已有 EdgeClaw 实例。
- 只启动一次。
- 有总超时。
- 有进程数断言。
- 有端口断言。
- 失败后收集日志并退出。
- 不使用 `killall -9 "EdgeClaw"` 作为常规清理手段。
- 只 kill 测试自己启动并记录的 pid。

推荐 smoke test 行为：

1. 构建 unpacked app。
2. 启动一次。
3. 等待 server health check。
4. 检查窗口 URL。
5. 检查进程树不超过预期数量。
6. 退出 App。
7. 确认 child process 已清理。

## 11. 待确认问题

- auto-update 后端使用 GitHub Releases、S3/R2，还是自建更新服务。
- Claude/Codex/Gemini key 是否全部必填，还是按 provider 延迟填写。
- 是否需要企业内部分发 channel。
- 是否需要崩溃报告和诊断包导出。
- 是否启用 macOS sandbox；如果启用，需要更严格设计 workspace 文件访问和 child process 能力。

