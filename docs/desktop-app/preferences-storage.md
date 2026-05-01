# EdgeClaw Desktop — 用户偏好与状态存储

> Status: Design proposal · Audience: 维护者 · Last updated: 2026-04-30
>
> 本文论证为什么需要把若干"用户偏好"从浏览器端 `localStorage` 搬到
> 后端 `~/.edgeclaw/preferences.json`，给出具体清单、API 设计、迁移路径
> 与未列入第一批的项的兜底方案。
>
> 关联代码：`apps/desktop/src/main.ts` · `ui/src/i18n/config.js` ·
> `ui/src/contexts/ThemeContext.jsx` · `ui/src/components/chat/utils/chatStorage.ts`

---

## 1. 起因

为方便用户在系统浏览器里使用同一份本地 UI（多标签页对照、用浏览器扩展、
DevTools 调试、远程协助等），桌面端在 macOS「帮助」菜单里加了：

- 在浏览器中打开（`shell.openExternal('http://127.0.0.1:<port>/')`）
- 复制本机地址

落地见 `apps/desktop/src/main.ts:setupAppMenu()`。

随即有用户反馈：**点击"在浏览器中打开"后，浏览器里看到的若干设置和 App 内不一致**，
典型如：

- 「外观 → 语言」：App 里是中文，浏览器里默认变英文（或反之）
- 「权限 → 跳过权限提示（请谨慎使用）」：App 里勾了，浏览器里没勾
- 浏览器里要再登一次（`auth-token` 不一致）

直觉怀疑："是不是开了两个实例？"——并非如此。

---

## 2. 归因：不是两个实例，是 Chromium session 隔离

### 2.1 事实

- `ServerManager` (`apps/desktop/src/server-manager.ts`) 只 spawn **一个**
  `node ui/server` 子进程，监听 `127.0.0.1:18790–18799` 区间内的一个端口。
- App 的 `BrowserWindow.loadURL(...)` 与系统浏览器打开的 URL 完全相同
  （origin 一致：`http://127.0.0.1:<port>`）。
- 因此 **server 进程是同一个、URL 是同一个、被持久化到磁盘的"server 端
  状态"也是同一份**（如 `~/.edgeclaw/config.yaml`、会话历史等）。

### 2.2 那为什么会"分家"

那几个看起来不一致的设置，**都不在 server 端，而是浏览器自己的 `localStorage`**。
而 Chromium 的 storage 隔离边界是 `session × profile × origin`，不是只看 origin：

| 来源 | Chromium session | localStorage 物理位置 |
|------|------------------|----------------------|
| Electron BrowserWindow | App 自带 chromium，partition 默认绑定 `app.getPath('userData')` | `~/Library/Application Support/EdgeClaw/Local Storage/...` |
| 系统 Chrome | Chrome 用户 profile | `~/Library/Application Support/Google/Chrome/Default/Local Storage/...` |
| 系统 Safari | Safari 容器沙盒 | `~/Library/Containers/com.apple.Safari/Data/Library/Safari/...` |

origin 相同，**但落到 3 个完全独立的物理目录、互相看不见**。这是浏览器
安全模型本身，不是 bug。Cookie / sessionStorage / IndexedDB 同理。

### 2.3 归因证据（源码引用）

| 设置 | 当前真理之源 | 引用 |
|------|------------|------|
| 语言 | `localStorage['userLanguage']` | `ui/src/i18n/config.js:45,105,112` |
| 主题（深/浅色）| `localStorage['theme']` | `ui/src/contexts/ThemeContext.jsx:17,34,48` |
| 跳过权限提示等 | `localStorage['claude-settings']` | `ui/src/components/chat/utils/chatStorage.ts:3,46-74` |
| 登录态 | `localStorage['auth-token']` | `ui/src/utils/api.js:5,27,145` |

---

## 3. 决策：新开 `preferences.json`，**不要写 `config.yaml`**

### 3.1 关键决策

把第 2.3 节中"应当全局一致"的偏好集中到 server 端的一个新文件
`~/.edgeclaw/preferences.json`，由 ui server 通过 HTTP 暴露读写。
**不复用现有的 `~/.edgeclaw/config.yaml`。**

### 3.2 为什么不复用 `config.yaml`

两类配置的"性格"完全不同，混在一起每一项都打架：

| 维度 | `config.yaml` | UI 偏好 |
|------|--------------|---------|
| 谁写 | 用户手编 + onboarding 一次性写 | UI 高频自动写 |
| 写频率 | 偶发，分钟～天级 | 高频，秒级（每次切主题/语言） |
| 缺失时行为 | **启动失败**（`ensureConfigOrOnboard` 拦截，见 `apps/desktop/src/main.ts:208`） | 必须无声 fallback 默认值，**绝不能阻塞启动** |
| 格式诉求 | YAML（注释、缩进、引号要保留） | JSON 即可，程序 round-trip 安全 |
| schema 演化 | 改 schema = 破坏性升级 | 加字段是日常 |
| 重置语义 | "重置就要重做 onboarding" | "重置 UI 偏好"应该是一键操作，不该牵动模型/凭据 |
| 是否进 git | 用户可能 git 一份做备份/同步 | 不应进 git，纯本地 |

混在一起的具体风险：

- `validateEdgeClawConfigFile` 是启动期硬校验，UI 高频回写很容易在用户
  **手编一半**时覆盖掉它。
- YAML 程序 round-trip 会丢注释；JSON 不会。
- 用户想"重置 UI 偏好但保留模型配置"将变成无解的删字段操作。

### 3.3 类比

行业有先例：VSCode 把 `settings.json`（用户编）和 `state.vscdb`（程序写）
分开；npm 把 `package.json` 和 `package-lock.json` 分开。同一个项目里，
**"人写的配置" vs "程序写的状态"** 永远要分两个文件。

---

## 4. 第一批同步清单（3 个 key）

### 4.1 清单与改动面

| Key | 类型 | 默认值 | 读取处 | 写入处 | 改动复杂度 |
|---|---|---|---|---|---|
| `userLanguage` | `'zh-CN' \| 'en'` | i18next-browser-languagedetector 检测系统 | `ui/src/i18n/config.js:45,105` | `ui/src/i18n/config.js:112` | **小**（1 文件） |
| `theme` | `'dark' \| 'light'` | `prefers-color-scheme` | `ui/src/contexts/ThemeContext.jsx:17,70` | `ui/src/contexts/ThemeContext.jsx:34,48` | **小**（1 文件） |
| `claude-settings`（含 `skipPermissions` / `allowedTools` / `disallowedTools` / `projectSortOrder`）| `ClaudeSettings` JSON | `chatStorage.ts:48-54` 已有完整 fallback | 6 文件，核心 `chatStorage.ts:getClaudeSettings` | 3 文件 | **中** |

### 4.2 关于 `claude-settings` 的技术债收口

`ui/src/components/settings/hooks/useSettingsController.ts:68/98/102` 当前
**直接** `localStorage.getItem('claude-settings')`，绕过了
`getClaudeSettings()/safeLocalStorage` 抽象。`ui/src/components/app-shell/SidebarV2.tsx:54`
同样如此。

**这次顺手收口**：让所有读写都过 `chatStorage.ts` 的 `getClaudeSettings()` /
`setClaudeSettings()`。否则 preferences 实现以后还要在多处改底层。

### 4.3 文件形态

```jsonc
// ~/.edgeclaw/preferences.json
{
  "version": 1,
  "ui": {
    "language": "zh-CN",
    "theme": "dark"
  },
  "claudeSettings": {
    "allowedTools": [],
    "disallowedTools": [],
    "skipPermissions": false,
    "projectSortOrder": "name"
  }
}
```

`version` 字段为未来无痛 schema 升级保留。读取端遇到不认识的版本号不报
错，按"全部缺失 → 全部默认"处理；后续版本如需 migrate，写在 server 端
读取路径里的一次性升级函数即可。

---

## 5. Server 端实现规范

### 5.1 路径与所有权

| 路径 | 写入者 | 读取者 |
|------|-------|--------|
| `~/.edgeclaw/preferences.json` | **唯一** ui server 的 PUT 路由 | 所有 client 通过 GET |
| `~/.edgeclaw/preferences.json.tmp` | 原子写中转文件 | 不应有 |

### 5.2 API

| Method | Path | 行为 | 失败行为 |
|---|---|---|---|
| `GET /api/preferences` | 返回 JSON；文件不存在/损坏 → 返回 `{}`，由前端 fallback | **永不 5xx**，永不阻塞 |
| `PUT /api/preferences` | **整体覆盖**写入（JSON Patch 不值得为 3 个 key 上） | 写失败 → 5xx + 详细错误，前端原地保留旧值 |
| `GET /api/preferences/stream`（可选）| SSE，PUT 成功后 broadcast 新值 | 替代浏览器内 `storage` event |

### 5.3 原子写规范（必须）

```ts
// 任何对 preferences.json 的写都必须走这个路径
const tmpPath = `${prefsPath}.tmp`;
await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
await fs.rename(tmpPath, prefsPath);   // POSIX rename 原子
```

否则 `Ctrl-C` / 断电 / 进程被 OOM kill 一旦发生在 `writeFile` 中段，
文件就会变成半截 JSON、下次 `JSON.parse` 报错。

### 5.4 不阻塞启动原则

- ui server 启动时**不读** `preferences.json`、**不校验**它。
- 只在 GET 请求来时按需读，缺失/损坏一律返回 `{}`。
- 这样无论这个文件出什么问题，server 都能正常启动。

### 5.5 单进程写入，无需文件锁

ui server 是单进程，并发写 PUT 走 Express 的事件循环串行化，天然顺序。
不需要 `proper-lockfile` 之类的库。如果未来支持多 server 实例，再加锁。

---

## 6. 跨窗口/标签实时同步

老链路靠浏览器 `storage` event 在多 tab 间广播 localStorage 变化
（见 `PermissionsSettingsTab.tsx:174` 与 `SidebarV2.tsx:69`）。
搬到 server 后这个机制丢失。两个替代方案：

### 6.1 SSE 广播（推荐）

ui server 已有 ws/SSE 基础设施。新增 `GET /api/preferences/stream`：

```
client A → PUT /api/preferences { ... }
server   → 写文件原子成功
server   → SSE broadcast 'preferences-changed' { newPrefs } 给所有连接
client B → 监听到 → 局部更新 i18n / theme / claudeSettings
```

**用户感知**：在 App 里改语言，同机浏览器 tab 立刻跟着变。

前端封装一个 `usePreferences()` hook 集中订阅 + 派发到三个具体子模块的
更新逻辑（`i18n.changeLanguage`、`setIsDarkMode`、`setClaudeSettings`）。

### 6.2 短轮询（备选）

每个 client 每 5s 拉一次 `GET /api/preferences`，写时本地立即生效
+ 后台 PUT。简单但有最长 5s 不一致窗口，且费请求。

只在 SSE 链路实现成本意外膨胀时退化到这个方案。

---

## 7. 一次性迁移：从 localStorage 到 server

前端首次升级到带 preferences 支持的版本时执行：

```
1. 检查标记位 localStorage['preferences:migrated-v1']
   - 已是 '1' → 跳过迁移
2. fetch GET /api/preferences  → 拿到 server 端值
3. 如果 server 端为空 ({}) 但 localStorage 还有老 key：
     - 把 userLanguage / theme / claude-settings 打包成 PUT 请求送到 server
     - 成功后 localStorage.setItem('preferences:migrated-v1', '1')
     - 老 key 保留 1 个版本不删（兜底，防止迁移后 server 写挂导致用户偏好丢失）
4. 之后所有读写都通过 server，localStorage 不再 touch
```

迁移函数 `migrateLegacyPreferences()` 写在 `usePreferences()` provider 的
初始化处，幂等。

下一个版本（确认无回滚需求后）再清掉残留的老 key。

---

## 8. `auth-token` 单列：不放第一批

### 8.1 为什么不能走 preferences.json

| 问题 | 说明 |
|------|------|
| Chicken-and-egg | `/api/preferences` 本身需要鉴权，"用户没登录前怎么读到 token？" |
| 安全反模式 | 把 JWT 落到 `~/.edgeclaw/` 文件 = 任何能读用户 home 的进程都能拿到 token，攻击面比 chromium 加密 storage 更大 |
| Cookie 也不能解决 | HttpOnly cookie 看似优雅，但 Electron 内置 Chromium 和系统 Chrome 仍是不同 cookie store |

### 8.2 推荐解法：一次性配对码 via URL

由 `apps/desktop/src/main.ts` 在用户点击"在浏览器中打开"时主动 mint 一个
短期、一次性 token 拼到 URL 上：

```
用户点「在浏览器中打开」
  → main 进程通过本机 IPC 让 server 生成一个 short-lived (5 min) one-time-use token
  → main 拼成 http://127.0.0.1:<port>/?auth=<token>
  → shell.openExternal(url)
  → 前端检测 query 中的 auth → 与 server 换成正式 JWT 写入浏览器 localStorage
  → 之后浏览器 session 内有效；URL 中的 token 失效
```

这是单独一个 PR，跟 preferences.json 互不依赖。**优先级排在 preferences
之后**——用户感知度更低（登一次还能接受），且要小心 token 落到 shell
history / 系统剪贴板（应当用一次性、绑定 client IP / fingerprint 的短码）。

---

## 9. 不放第一批的项（按窗口走也合理）

明确不迁，让它们继续按 chromium session 各自存：

| Key | 当前位置 | 为什么不迁 |
|-----|---------|-----------|
| 代码编辑器 `wordWrap` / `fontSize` | `ui/src/components/code-editor/hooks/useCodeEditorSettings.ts` | "我在这个窗口的临时偏好"，跨设备/窗口不一致符合直觉（大屏调大、笔电调小）|
| `github-stars-dismissed` | `ui/src/hooks/useGitHubStars.ts:16` | 信息提示关闭状态，每个窗口独立无影响 |
| `edgeclaw:configView`（form/yaml 切换）| `ui/src/components/settings/view/tabs/EdgeClawConfigTab.tsx:875` | 上下文敏感的临时偏好 |
| `draft_input_*`（聊天草稿）| `chatStorage.ts:14` | 已经按 session 设计 |

后续若有用户反馈，再单独加入第二批。

---

## 10. 工作量与上线节奏

### 10.1 工作量估计

| 任务 | 估时 |
|---|---|
| Server `/api/preferences` GET/PUT + 原子写 + 单测 | 1.5h |
| Server SSE broadcast | 1h |
| 前端 `usePreferences()` hook + provider | 1.5h |
| 接入 i18n（替 detector）+ ThemeContext + chatStorage | 2h |
| 收口 `useSettingsController` / `SidebarV2` 直接读 localStorage 的债 | 0.5h |
| migration 逻辑 + 测试 | 1h |
| 端到端验证（App 内改 → 浏览器 tab 看变；反向） | 1h |
| **合计** | **~8.5h（一天）** |

### 10.2 上线节奏

1. **现在**：本 doc 评审定稿
2. **PR-1**：preferences.json server 路由 + 前端 hook + 三个 key 接入 + migration
3. **PR-2**（独立）：auth-token 一次性配对码方案
4. **观察**：若用户反馈"还有 X 设置不一致"，再决定第二批

### 10.3 验证 checklist

- [ ] 全新机器（无 `preferences.json`、无老 localStorage） → 所有偏好默认值，server 启动正常
- [ ] 老机器升级（无 `preferences.json`、有老 localStorage） → 自动迁移成功，迁移后行为一致
- [ ] 文件被手动删 → server 仍可启动；前端读 GET 拿到 `{}`，按默认值渲染
- [ ] 文件被手动写坏 JSON → server 不 5xx；前端按默认值渲染；下次 PUT 覆盖修复
- [ ] App 改语言 → 同机已开的浏览器 tab 实时切换（SSE）
- [ ] 浏览器改 skipPermissions → App 内同步生效
- [ ] 所有 PUT 在断电/Ctrl-C 中断时不会留下半截 JSON（依赖原子 rename）

---

## 11. 后续考量

- **多用户/多 profile**：当前设计是单用户单机。若未来支持系统级多用户，
  `preferences.json` 路径要按用户身份隔离（已经在 `~/`，自然按 OS user
  分；不需要额外工作）。
- **远程访问场景**：若以后允许通过端口转发让其他设备访问本机 ui，
  preferences 同步会自然覆盖远程 client，符合预期。
- **导入/导出**：preferences.json 是简单 JSON，用户可直接备份/恢复/在
  机器之间拷贝，不需要专门 UI。
- **配额**：JSON 文件大小预计 <2KB，无需 quota；如果未来某个 key 失控
  地写大数据（聊天历史草稿、外观自定义大对象等），应当独立成单独文件
  而不是塞进 preferences。
