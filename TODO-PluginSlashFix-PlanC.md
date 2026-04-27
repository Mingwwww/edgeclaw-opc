# Plan C: Native Plugin Loading via SDK `options.plugins`

> **Self-contained 实施文档**。读者不需要先看 [`TODO-PluginSlashFix.md`](./TODO-PluginSlashFix.md) 也能动手。
> 上下文背景（为什么要做、还有哪些备选）在主 TODO，本文聚焦 Plan C 的实施。

## 1. TL;DR

| 问 | 答 |
| ---- | ---- |
| 要做什么？ | 在 `claudecodeui` 启动 Claude Agent SDK 时传 `options.plugins`，让 SDK 子进程原生加载 `turnkey-cc-plugin`，自动获得 commands、skills、hooks，**同时拆掉 Solution A 的 `sdkOptions.hooks` 注入**。 |
| 为什么？ | `/turnkey:start` 当前在 webui 不可识别，因为 SDK 子进程从未被告知 turnkey plugin 存在。Solution A 只接通了 hooks，没接通 commands/skills 路由。 |
| 风险？ | **如果不同时拆 Solution A，hook 会双触发**（见 §2.3）。SDK plugin API 还在 0.x，未来版本可能改字段。 |
| 工作量？ | `claude-sdk.js` 净增 ~5 行、净删 ~25 行。一个 PR 拆 2-3 个 commit。 |

## 2. 必读前置

### 2.1 Turnkey 插件现状

```
packages/turnkey-cc-plugin/
├── .claude-plugin/plugin.json          # name: "turnkey", version: 0.1.0-cc, 无 hooks 字段
├── hooks/
│   ├── hooks.json                      # UserPromptSubmit / Stop / PostToolUse 三类 command-type hook
│   ├── turnkey-capture.js              # 写 ~/.turnkey/inbox.jsonl
│   ├── turnkey-budget.js               # 维护 ~/.turnkey/budget.json
│   └── turnkey-bootstrap.js            # 由 SKILL.md Phase 0 调用，初始化 ~/.turnkey/runlog.json
└── skills/
    ├── start/SKILL.md                  # 主 orchestrator skill → command 名 "turnkey:start"
    ├── onboard/SKILL.md                # → "turnkey:onboard"
    ├── clarify/SKILL.md, design, tdd, develop, test, review, ship/SKILL.md  # 共 9-10 条 funnel skill
```

### 2.2 SDK 0.2.59 已经原生支持 plugin（事实）

```1606:1620:claudecodeui/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
export declare type SdkPluginConfig = {
    /**
     * Plugin type. Currently only 'local' is supported
     */
    type: 'local';
    /**
     * Absolute or relative path to the plugin directory
     */
    path: string;
};
```

`Options.plugins?: SdkPluginConfig[]`（`sdk.d.ts:812`）。

`sdk.mjs` 启动 CLI 子进程时把它翻译成 `--plugin-dir`（精确逻辑）：

```js
if (P1 && P1.length > 0)
  for (let b0 of P1)
    if (b0.type === "local") u.push("--plugin-dir", b0.path);
    else throw Error(`Unsupported plugin type: ${b0.type}`);
```

CLI 端接住 `--plugin-dir` 后调 `setInlinePlugins(pluginDir)`（`claude-code-main/src/main.tsx:1009-1012`），把它注册成 session-only plugin：

- `loadAllPluginsCacheOnly()` → `loadSessionOnlyPlugins(...)` → 自动读 `<plugin>/hooks/hooks.json`、`commands/`、`skills/`
- 不走 marketplace，不写任何用户 settings，session 结束即清
- **bare 模式不阻挡**：`getPluginCommands` / `getAgents` 的 gate 是 `isBareMode() && getInlinePlugins().length === 0`（`loadPluginCommands.ts:419, 843`），传了 `--plugin-dir` 就直接绕过

### 2.3 Solution A 跟 Plan C 不能共存（关键）

CLI 端 `initialize` control_request 把 SDK 注入的 hooks 注册到内部 registry 时用的是 **append**：

```js
// cli.js, function zA6
function zA6(A) {
  if (!x1.registeredHooks) x1.registeredHooks = {};
  for (let [q, K] of Object.entries(A)) {
    let Y = q;
    if (!x1.registeredHooks[Y]) x1.registeredHooks[Y] = [];
    x1.registeredHooks[Y].push(...K);   // <- 追加，不去重，不识别 source
  }
}
```

所以一旦 Plan C 启用，每个 Turnkey 事件会被注册两份：
1. **Native CLI hook**：CLI 在 plugin 加载阶段读 `hooks/hooks.json` 注册（在子进程内 spawn `turnkey-capture.js`）。
2. **SDK callback**：Solution A 通过 `sdkOptions.hooks` 注册的 callback id（CLI 通过 control_request 远程回调到 Node 主进程，再 spawn `turnkey-capture.js`）。

结果：每个 `UserPromptSubmit` 触发 2 次，`~/.turnkey/inbox.jsonl` 一条事件变两行，`~/.turnkey/budget.json` 计数器双倍前进。

**Plan C 的任何 PR 必须把 Solution A 的 hook 注入同时拆掉。**

### 2.4 当前要改的代码点

`claudecodeui/server/claude-sdk.js` 里 Solution A 的位置：

- `35:38` — import 块（`loadPluginHooksFromDir / mergeHookMaps / resolveTurnkeyPluginRoot`）
- `799:819` — Turnkey plugin hook 加载
- `821` — `sdkOptions.hooks = mergeHookMaps(builtInHookMap, pluginHookMap)`
- `823:834` — `PLUGIN_HOOKS_DEBUG=1` 调试 dump

## 3. 设计

### 3.1 数据流（Plan C 后）

```
webui 输入 /turnkey:start "..."
    │
    ▼
claudecodeui/server/claude-sdk.js
    │   sdkOptions = {
    │     hooks: builtInHookMap,         // 仅保留 webui 自己的 Notification hook
    │     plugins: [{type:'local', path: turnkeyPluginRoot}],
    │     ...
    │   }
    ▼
@anthropic-ai/claude-agent-sdk (sdk.mjs)
    │   spawn claude --plugin-dir <pluginRoot> --output-format stream-json ...
    ▼
claude-code CLI (cli.js, 子进程)
    │   preAction → setInlinePlugins([pluginRoot]) → clearPluginCache(...)
    │   loadAllPluginsCacheOnly → loadSessionOnlyPlugins → 解析 plugin.json + hooks/ + skills/
    │   loadPluginHooks → registerHookCallbacks(<turnkey hooks>)
    │   getPluginSkills → SkillTool 暴露给模型
    │   turnkeySubcommandRouting：/turnkey start ↔ /turnkey:start 自动路由
    ▼
模型识别 /turnkey:start，跑 SKILL.md Phase 0 → Bash node turnkey-bootstrap.js ...
    ▼
turnkey-bootstrap.js 写 ~/.turnkey/runlog.json
    ▼
后续每个事件 → CLI 内部 registry 触发一次 turnkey-capture.js → ~/.turnkey/inbox.jsonl 单行
```

### 3.2 不变量

- `builtInHookMap` 里的 `Notification` hook（webui 自己的弹窗通知）**保留**——它不在 plugin 里，只能走 SDK options。
- `resolveTurnkeyPluginRoot()` 函数**保留**——它的路径解析逻辑被 Plan C 复用。
- `plugin-hooks.js` 文件保留但不再被 import（万一 Plan C 出问题方便 revert）。
- `turnkey-cc-plugin/.claude-plugin/plugin.json` **不需要** 添加 `"hooks": "hooks/hooks.json"`——CLI 会自动加载，反而手动声明会触发 "Duplicate hooks file detected" 错误。

## 4. 改动清单（精确 diff 草稿）

### 4.1 `claudecodeui/server/claude-sdk.js` — 拆 Solution A

**删 imports（行 34-38）：**

```diff
 import {
   registerCronSession
 } from './services/cron-session-bridge.js';
-import {
-  loadPluginHooksFromDir,
-  mergeHookMaps,
-  resolveTurnkeyPluginRoot
-} from './plugin-hooks.js';
+import { resolveTurnkeyPluginRoot } from './plugin-hooks.js';
```

**改 hook 加载（行 799-834）：**

```diff
     const builtInHookMap = {
       Notification: [{
         matcher: '',
         hooks: [async (input) => {
           // ... 不变 ...
         }]
       }]
     };

-    let pluginHookMap = {};
+    let turnkeyPluginRoot = null;
     try {
-      const pluginRoot = await resolveTurnkeyPluginRoot(options.cwd || process.cwd());
-      if (pluginRoot) {
-        pluginHookMap = await loadPluginHooksFromDir(pluginRoot);
-        const eventSummary = Object.fromEntries(
-          Object.entries(pluginHookMap).map(([event, matchers]) => [
-            event,
-            matchers.reduce((sum, m) => sum + (m.hooks?.length || 0), 0)
-          ])
-        );
-        if (Object.keys(eventSummary).length > 0) {
-          console.log('[plugin-hooks] turnkey plugin hooks registered', {
-            pluginRoot,
-            counts: eventSummary
-          });
-        }
+      turnkeyPluginRoot = await resolveTurnkeyPluginRoot(options.cwd || process.cwd());
+      if (turnkeyPluginRoot) {
+        console.log('[plugin] turnkey plugin will be loaded by CLI via --plugin-dir', {
+          pluginRoot: turnkeyPluginRoot
+        });
       }
     } catch (pluginErr) {
-      console.warn('[plugin-hooks] failed to load turnkey hooks (non-fatal):', pluginErr?.message || pluginErr);
+      console.warn('[plugin] failed to resolve turnkey plugin root (non-fatal):', pluginErr?.message || pluginErr);
     }

-    sdkOptions.hooks = mergeHookMaps(builtInHookMap, pluginHookMap);
-
-    if (process.env.PLUGIN_HOOKS_DEBUG === '1') {
-      const dump = Object.fromEntries(
-        Object.entries(sdkOptions.hooks).map(([event, matchers]) => [
-          event,
-          matchers.map(m => ({
-            matcher: m.matcher ?? '<none>',
-            hookCount: m.hooks?.length || 0
-          }))
-        ])
-      );
-      console.log('[plugin-hooks] sdkOptions.hooks shape', dump);
+    sdkOptions.hooks = builtInHookMap;
+
+    if (turnkeyPluginRoot) {
+      sdkOptions.plugins = [
+        ...(sdkOptions.plugins || []),
+        { type: 'local', path: turnkeyPluginRoot }
+      ];
     }
```

> **保留 `resolveTurnkeyPluginRoot` 的解析逻辑**：它能从 `claudecodeui` 模块出发往上爬找到 `packages/turnkey-cc-plugin/`，比硬编码路径更稳。这部分不动。

### 4.2 `claudecodeui/server/plugin-hooks.js` — 标记 deprecated

不删文件（保留 revert 能力），但在文件头加注释：

```diff
+/**
+ * @deprecated since Plan C: Plugin hooks are now loaded natively by the
+ * Claude CLI via SDK `options.plugins` → `--plugin-dir`. This module is
+ * kept as a fallback in case the SDK plugin API regresses. The only
+ * function still imported by `claude-sdk.js` is `resolveTurnkeyPluginRoot`.
+ */
 import path from 'node:path';
```

### 4.3 `turnkey-cc-plugin/.claude-plugin/plugin.json` — 不动

经实测：CLI 会自动加载 `hooks/hooks.json`，**手动声明 `"hooks": "hooks/hooks.json"` 反而会触发 CLI 的 "Duplicate hooks file detected" 警告**。保持现状即可。

### 4.4 (条件) 拆方案 B 的 system prompt 注入

如果 Plan B 已经先上了（`plugin-skills.js` + `appendSystemPrompt` 拼接）：**必须删**。CLI 自己 `getPluginSkills()` 已经把 SKILL.md 通过 `SkillTool` 暴露给模型，再注入一份就是 system prompt 翻倍 + 描述漂移。

## 5. Commit 拆分建议

| Commit | 内容 | 可观测的变化 |
| ---- | ---- | ---- |
| **C1**: add SDK plugins option | 仅加 `sdkOptions.plugins`，**保留** Solution A | `/turnkey:start` 已经能识别；同时**故意**保留双触发（用来产出 §6.4 的回归证据）。`inbox.jsonl` 每事件 2 行。 |
| **C2**: remove Solution A hook injection | 按 §4.1 完整拆 import + 加载 + merge + debug dump | `inbox.jsonl` 回到每事件 1 行；`/turnkey:start` 仍可识别。这是干净的删除 commit，方便 revert。 |
| **C3**: cleanup & docs | `plugin-hooks.js` 加 deprecated 注释；更新 `TODO-PluginHookFix.md` 标记 Solution A 已被取代 | 无运行时变化。 |

> 之所以拆成两步而不是一个 PR 干完，是因为 C1 → C2 之间正好能跑一轮"双触发证据 → 单触发"对比，**自带回归测试**。

## 6. Smoke Test

### 6.1 启动日志手动检查

```bash
cd claudecodeui
DEBUG_CLAUDE_AGENT_SDK=1 npm run dev
```

进程启动后期望看到（webui 发起任意会话时）：

```
Spawning Claude Code: <node|bun> <cli.js path> ... --plugin-dir /Users/.../packages/turnkey-cc-plugin ...
```

如果 `--plugin-dir` 没出现，说明 `sdkOptions.plugins` 没传到 SDK；或 `resolveTurnkeyPluginRoot` 没找到路径。

### 6.2 init system message 的 commands 列表

在 `claude-sdk.js` 的 SDK 消息处理里加一行临时日志（PR 合入前删）：

```js
// 在收到 type === 'system' && subtype === 'init' 的消息时
console.log('[plan-c smoke] init commands:',
  msg.commands?.map(c => c.name).filter(n => n.startsWith('turnkey'))
);
```

期望输出：

```
[plan-c smoke] init commands: [ 'turnkey:start', 'turnkey:onboard', 'turnkey:clarify',
                                 'turnkey:design', 'turnkey:tdd', 'turnkey:develop',
                                 'turnkey:test', 'turnkey:review', 'turnkey:ship' ]
```

### 6.3 端到端 `/turnkey:start`

| 步骤 | 期望 |
| ---- | ---- |
| webui 输入 `/turnkey:start "smoke C ticket"` | 模型直接识别，不再回 "Unknown skill" |
| 模型按 SKILL.md Phase 0 请求 Bash | 调用 `node /.../turnkey-bootstrap.js "smoke C ticket"` |
| 批准 Bash | `~/.turnkey/runlog.json.ticket_id === sha256("smoke C ticket").slice(0,12)` |
| 旧 runlog 归档 | `~/.turnkey/runlog.<old_id>.json` 存在 |
| artifact dir | `~/.turnkey/artifacts/<new_id>/` 已创建 |

同时测试空格写法：

| 步骤 | 期望 |
| ---- | ---- |
| webui 输入 `/turnkey start "smoke C ticket 2"` | CLI `turnkeySubcommandRouting` 自动重写为 `/turnkey:start ...`，模型按 Phase 0 处理 |

### 6.4 双触发回归脚本（C1 → C2 验证）

> 这一节有可复现脚本：`claudecodeui/server/__plan-c-bench.mjs`。它跑通完整 webui WS 协议（1 prompt → 自动批准 Bash → 等 Stop），同时统计 `~/.turnkey/inbox.jsonl` 的两个指标：
>
> - **inboxDelta**：裸 `wc -l` 增量（受 hooks.json 中每事件多 command 影响，不能直接判双触发）。
> - **captureByEvent**：只数 `turnkey-capture.js` 写出的行（schema 含 `payload` 键，与 budget 行区分），按 `event` 名分桶。**这是真正能区分单/双触发的指标。**
>
> 用法：
>
> ```bash
> # 1) 起源码 server (DISABLE_LOCAL_AUTH 默认 true 即可)
> cd claudecodeui && DEBUG_CLAUDE_AGENT_SDK=1 npm run server &
>
> # 2) 跑 bench
> node claudecodeui/server/__plan-c-bench.mjs
> ```

#### 实测结果（2026-04-27, branch `feat/turnkey-plugin-native-loading`）

| Commit | sha | captureByEvent | inboxDelta | verdict |
| ---- | ---- | ---- | ---- | ---- |
| C1 (`Solution A` + `--plugin-dir` 同时存在) | `25f7ee7` | `{ UserPromptSubmit: 2, PostToolUse: 2, Stop: 2 }` | 10 | DOUBLE_TRIGGER |
| C3 (`Solution A` 已拆，仅 `--plugin-dir`) | `ae06fc4` | `{ UserPromptSubmit: 1, PostToolUse: 1, Stop: 1 }` | 5 | SINGLE_TRIGGER |

> 比例正好 2:1，与 §2.3 推断一致。`inboxDelta=5`（C3 单触发基线）= 1 × UserPromptSubmit + 2 × PostToolUse + 2 × Stop —— 因为 `hooks.json` 给 `PostToolUse` 和 `Stop` 各注册了多条 command，单事件会触发 capture+budget 多个 hook 脚本，这在两侧都会发生，不影响双触发判定。

把这张表 + bench 输出原文附在 PR description 里即可。

### 6.5 自动化（可选，建议加）

在 `claudecodeui/server/__tests__/plan-c-smoke.test.js`：

```js
import { resolveTurnkeyPluginRoot } from '../plugin-hooks.js';

test('turnkey plugin root resolves and contains hooks/hooks.json', async () => {
  const root = await resolveTurnkeyPluginRoot(process.cwd());
  expect(root).toBeTruthy();
  expect(existsSync(path.join(root, 'hooks/hooks.json'))).toBe(true);
  expect(existsSync(path.join(root, 'skills/start/SKILL.md'))).toBe(true);
});
```

不测 SDK 实际启动（那要跑真实 CLI），但路径解析回归能挡住"plugin 移位"类的事故。

## 7. 回滚

### 7.1 单 commit revert

```bash
git revert <C2 commit sha>
```

恢复到 C1 状态：`sdkOptions.plugins` 仍传，但 Solution A 的 hook 注入也回来了——回到双触发，但 `/turnkey:start` 仍可识别。如果 SDK plugin API 整个炸了，进一步 revert C1。

### 7.2 SDK 升级出问题

如果将来 SDK 0.3+ 把 `SdkPluginConfig` 的字段改了/删了：

1. 短期：SDK 锁版本到 0.2.59（`package.json` 加固定版本）。
2. 中期：把 `sdkOptions.plugins = ...` 整段包在 try/catch + `process.env.SDK_PLUGINS_DISABLED` gate 里，遇到不支持就回退到 Solution A 路径。
3. 长期：跟随 SDK 新 API 重写 §4.1。

### 7.3 `plugin-hooks.js` 留作保险

§4.2 之所以只标 deprecated 不删文件，就是为了 7.2 中期回退路径还能直接 import 回来用。不删保留约 200 行代码，成本可接受。

## 8. 残留 TODO（C 落地后才动）

- **Slash autocomplete UI**：webui 输入 `/turnkey:` 时弹 commands 列表。需要 client 端配合，单独 issue。SDK init message 的 `commands` 字段已经能直接喂给 UI。
- **多 plugin 并存**：`sdkOptions.plugins` 是数组，原生支持多个；但 `resolveTurnkeyPluginRoot` 是单 plugin 的硬编码解析器，需要换成"发现 `packages/*-cc-plugin/`"的扫描器。
- **Plugin enable/disable 管理面板**：让用户在 webui 里勾选启用哪些 plugin。这要把 plugin 列表暴露给前端，跟 §1 不冲突但是更大范围的 feature。

## 9. 参考代码 anchors

源码版（仅读取，不改）：

- SDK 类型 + runtime：`claudecodeui/node_modules/@anthropic-ai/claude-agent-sdk/{sdk.d.ts, sdk.mjs, cli.js}`
- CLI 入参：`claude-code-main/src/main.tsx:1001-1013, 1066-1070`
- Session-only plugin loader：`claude-code-main/src/utils/plugins/pluginLoader.ts:2918-2989`
- Bare gate：`claude-code-main/src/utils/plugins/loadPluginCommands.ts:414-421, 840-846`
- Plugin hooks 注册：`claude-code-main/src/utils/plugins/loadPluginHooks.ts:91-157`
- Subcommand routing：`claude-code-main/src/utils/turnkeySubcommandRouting.ts:15-42`

要改的代码：

- `claudecodeui/server/claude-sdk.js:34-38, 799-834`
- `claudecodeui/server/plugin-hooks.js`（仅加 deprecated 注释）

Turnkey plugin 内部（仅读取，不改）：

- `packages/turnkey-cc-plugin/.claude-plugin/plugin.json`
- `packages/turnkey-cc-plugin/hooks/{hooks.json, turnkey-capture.js, turnkey-budget.js, turnkey-bootstrap.js}`
- `packages/turnkey-cc-plugin/skills/*/SKILL.md`

最近一次方案 A 成功的样本（用作 §6 对照基线）：

- `~/.turnkey/runlog.json` (`ticket_id: abeb5ea2cbbe`)
- `~/.turnkey/artifacts/abeb5ea2cbbe/`
- `~/.turnkey/inbox.jsonl` 中带 `abeb5ea2cbbe` 的 cursor_hook + budget_tick 行

---

**起手：直接做 Commit C1**（§5）。10 分钟内能产出第一份 §6.1 启动日志证据。
