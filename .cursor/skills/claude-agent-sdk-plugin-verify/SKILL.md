---
name: claude-agent-sdk-plugin-verify
description: >-
  Systematic method for verifying that a Claude Agent SDK plugin is being
  loaded and behaving correctly inside `claudecodeui` (the Express + WebSocket
  webui that wraps the SDK). Use whenever the user is touching plugin loading
  and needs to know whether the SDK subprocess actually saw the plugin, whether
  hooks are firing the right number of times, or whether a slash command like
  `/turnkey:start` is being recognized end-to-end. Triggers on phrases like
  "plugin 双触发", "double-trigger", "hook 触发了两次", "inbox.jsonl 多了一倍",
  "/turnkey:start 没识别", "Unknown skill", "options.plugins vs --plugin-dir",
  "为什么 SDK 子进程没看到我配的 plugin", "plugin loading verify",
  "Plan C smoke test", "plugin hook regression". Walks through the 4-layer
  verification (startup logs → SDK init commands list → end-to-end WS probe →
  A/B bench across commits), reusable bench/probe script templates checked in
  at `claudecodeui/server/__plan-c-bench.mjs`, the single-file `git checkout`
  trick for fast A/B comparisons without worktrees, and the catalog of pitfalls
  found while shipping Plan C (auth.db path, EdgeClaw.app port conflict,
  `ws` module resolution, capture-vs-budget hook line schema, cursor-ide-browser
  limitations).
---

# Claude Agent SDK Plugin 行为验证 — 系统性方法

针对 `claudecodeui` 中 "我加了一个 Claude Agent SDK plugin / hook / skill，怎么知道它真的生效了" 这一类问题的可复现验证流程。

驱动这套方法的真实案例是 **Plan C: Native Plugin Loading via SDK `options.plugins`**：把 turnkey-cc-plugin 从 "Solution A — webui 进程内桥接 hook" 切换到 "SDK CLI 用 `--plugin-dir` 直接加载"，期间发现两条加载路径**同时存在会导致 hook 双触发**（每个事件的 `~/.turnkey/inbox.jsonl` 多写一行）。这套方法就是为了让任何人都能在 5 分钟内独立验证类似的改动。

完整背景见仓库内：

- `TODO-PluginSlashFix-PlanC.md` — 原始 plan + §6.x smoke test 协议
- `claudecodeui/server/__plan-c-bench.mjs` — bench 脚本（真实可跑）
- `claudecodeui/server/plan-c-smoke.test.js` — 路径解析层 smoke
- `claudecodeui/server/claude-sdk.js` — `sdkOptions.plugins` 注入点
- `packages/turnkey-cc-plugin/hooks/hooks.json` — plugin 侧 hook 注册

---

## 何时启动这套流程

任何 "我对 plugin/hook/skill 做了改动，需要 ground-truth 它在 SDK 子进程里到底什么状态" 的场景：

- 修了 `claude-sdk.js` 的 plugin 加载逻辑（加 / 删 / 换路径）
- 改了 `packages/turnkey-cc-plugin/.claude-plugin/plugin.json` 或 `hooks/hooks.json`
- 加了新的 skill（`skills/<name>/SKILL.md`）想确认 webui 能识别 `/<plugin>:<name>`
- 怀疑 hook 双触发（事件被处理了两次，inbox / 日志 / token budget 计数翻倍）
- PR review 要求 "证明你的改动没回退到旧行为"

> **不适用**：CLI（claude-code-main 单独跑）的 plugin 行为。这套方法专门针对 webui 把 SDK 当子进程跑的场景。

---

## 现实检验 vs 表面检验

绝大多数 plugin 验证错在**只看表面**：

| 表面检验（容易骗自己） | 现实检验（这套方法） |
| ---- | ---- |
| `npm test` 通过 | bench 脚本跑真实 webui WS 协议，端到端看 inbox 行数 |
| `console.log("plugin loaded")` 看到了 | SDK 子进程 debug log（`/Users/da/.claude/debug/sdk-*.txt`）确认 |
| 启动时 server 日志说 plugin 路径 OK | 触发一次 prompt，看 `permission_request` 是不是走的 plugin |
| 看代码"应该会走这条路径" | A/B 两个 commit 对比 inbox.jsonl 增量 |

**核心原则**：plugin / hook / skill 是跨进程契约（webui Node 进程 ↔ SDK 子进程 ↔ plugin hook 子进程），任何一层 silent fail 都会让"看起来像生效了"。**永远去看最终产出**（inbox.jsonl 行数、permission_request 的 toolName、SDK debug 日志的 `Loaded N skills`），不要只看入口。

---

## 4 步流程（按这个顺序做，每步都有独立的失败信号）

### Step 1 — 启动日志：plugin 路径有没有被识别

最便宜的检验。起源码 server，开 SDK debug：

```bash
cd claudecodeui
DEBUG_CLAUDE_AGENT_SDK=1 npm run server > /tmp/plan-c-server.log 2>&1 &
```

在 server 日志里 grep plugin 加载入口：

```bash
grep -E "plugin|--plugin-dir" /tmp/plan-c-server.log
```

期望看到（例子，turnkey 场景）：

```
[plugin] turnkey plugin will be loaded by CLI via --plugin-dir <abs path to packages/turnkey-cc-plugin>
```

如果**没看到**：plugin 路径解析挂了（`resolveTurnkeyPluginRoot` 返回 null / monorepo 结构变了 / 部署没把 plugin 一起打）。先修这个，后面步骤都白做。

如果路径里**含相对路径或 `..`**：SDK 子进程 cwd 跟 webui 进程不同，相对路径常常 silent miss。强制 `path.resolve(...)`。

### Step 2 — SDK init commands list：skill 真的注入到 LLM 了吗

启动日志看到了"我准备加载"，不等于"SDK 真的加载了"。SDK 子进程有自己的 debug 日志文件，路径：

```
/Users/da/.claude/debug/sdk-<timestamp>.txt
```

每次起一个新 session 会写一份新的。触发一次 init（在 webui 里发一个普通 prompt，或者用 §Step 3 的 probe 脚本），然后：

```bash
ls -lt ~/.claude/debug/sdk-*.txt | head -1   # 找最新的
grep -E "Registered .* hooks|Loaded .* skills|plugin" ~/.claude/debug/sdk-*.txt | tail -20
```

期望看到（turnkey 场景）：

```
Loaded 1 session-only plugins from --plugin-dir
Loaded 10 skills from plugin turnkey default directory
Registered 3 hooks from 1 plugin
```

**关键反向信号**：如果看到 `Registered 6 hooks from 2 plugins`（数字翻倍），就是 Plan C 解决的双触发 bug —— plugin 同时被 `installed_plugins.json` + `--plugin-dir` 注册了两次。具体处理方式见 §"已知坑：双重注册"。

### Step 3 — 端到端 WS probe：模型真的看到 slash command 了吗

到这一步前两步都通了，但还有最后一道关：**LLM 在 system prompt 里看没看到 `/<plugin>:<name>` 这个命令**。如果 SDK 注册了 skill 但没暴露给模型，`/turnkey:start "..."` 会得到 "Unknown skill" 这种 hallucination。

最干净的检验是用 `claudecodeui/server/__plan-c-turnkey-probe.mjs`（如果还在；这是个一次性 probe，可能已删）这种**只看第一个 permission_request 形状**的 WS 客户端：

- 发 `/turnkey:start "smoke test"` 这个 prompt
- **拒绝**所有 permission_request（不真跑工具）
- 看 `permission_request.toolName` 是不是 `Bash`，`input.command` 是不是 `node .../packages/turnkey-cc-plugin/hooks/turnkey-bootstrap.js ...`

如果模型回的是普通 text "I don't recognize that command" → skill 没注入，回到 Step 2。
如果模型 request `Bash` 跑 `turnkey-bootstrap.js` → ✅ slash command 端到端通了。

> 用 `cursor-ide-browser` MCP 想"在浏览器里手动点" 这条**不可行** —— 那个 MCP 不能 spawn 新 view，必须用 WS probe 或者人工开浏览器。这个坑在 §"已知坑" 里。

### Step 4 — A/B bench：行为差异定量化

前 3 步是 "存在性检验"，到这步是 "行为定量"。典型问题：

- 我改了 plugin 加载方式，hook 触发次数有没有变？
- 我修了双触发，每事件 inbox 行数从 2 降到 1 了吗？
- 我加了新 hook，old hook 还正常 fire 吗？

模板脚本：`claudecodeui/server/__plan-c-bench.mjs`（已 check in，可以直接拷贝去改）。它做这几件事：

1. 跑通完整 webui WS 协议：发 prompt → 自动批准 Bash → 等 Stop。
2. 抓 `~/.turnkey/inbox.jsonl` baseline（`wc -l`）。
3. 跑完 prompt 后再 `wc -l`，得 `inboxDelta`。
4. **关键**：只数其中 `turnkey-capture.js` 写的行（schema 含 `payload` 键，与 budget 行的 `added_tokens` 区分），按 `event` 字段分桶。这才是真双触发指标。

举例（Plan C 实测，2026-04-27）：

| Commit | sha | captureByEvent | inboxDelta | verdict |
| ---- | ---- | ---- | ---- | ---- |
| C1（Solution A + `--plugin-dir` 同时存在）| `25f7ee7` | `{ UserPromptSubmit: 2, PostToolUse: 2, Stop: 2 }` | 10 | DOUBLE_TRIGGER |
| C3（Solution A 已拆，仅 `--plugin-dir`）| `ae06fc4` | `{ UserPromptSubmit: 1, PostToolUse: 1, Stop: 1 }` | 5 | SINGLE_TRIGGER |

**`inboxDelta` 单独看会被 hooks.json 的 multi-command 注册迷惑**（一个事件触发多个 hook 脚本，每个脚本都 append 一行，跟双触发正交）。一定要按"每个 event 来自 capture.js 的行数"分桶看。

---

## 模板：Bench Script 核心结构

完整脚本在 `claudecodeui/server/__plan-c-bench.mjs`。最小可复用版（伪代码）：

```javascript
import WebSocket from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const INBOX = `${process.env.HOME}/.turnkey/inbox.jsonl`;
const baseline = wcL(INBOX);

const ws = new WebSocket('ws://localhost:3001/ws');
ws.on('open', () => ws.send(JSON.stringify({
  type: 'claude-command',
  command: 'Use Bash to run: echo "smoke", then stop',
  options: { projectPath: process.cwd(), cwd: process.cwd() }
})));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.kind === 'permission_request') {
    ws.send(JSON.stringify({
      type: 'claude-permission-response',
      requestId: msg.requestId,
      allow: true,
      updatedInput: msg.input
    }));
  }
  if (msg.kind === 'complete') finish();
});

function finish() {
  const captureByEvent = {};
  const lines = readFileSync(INBOX, 'utf8').split('\n').slice(baseline).filter(Boolean);
  for (const raw of lines) {
    const obj = JSON.parse(raw);
    if (!('payload' in obj)) continue;     // skip budget/aggregator rows
    captureByEvent[obj.event] = (captureByEvent[obj.event] || 0) + 1;
  }
  const verdict =
    Object.values(captureByEvent).every(n => n === 1) ? 'SINGLE' :
    Object.values(captureByEvent).every(n => n === 2) ? 'DOUBLE' : 'MIXED';
  console.log({ captureByEvent, verdict });
}
```

**关键设计点**：

- 跑 server **从源码** (`npm run server`)，不要跑打包好的 `EdgeClaw.app`（那个会用打包时点的 plugin 路径，A/B 时换 commit 没用）。
- `DISABLE_LOCAL_AUTH` 默认 true，并且要求 `~/.cloudcli/auth.db` 里至少有 1 个 user，bench 脚本就能 bypass token。
- 自动批准所有 `permission_request`，否则 prompt 永远 stuck。
- 等 `kind === 'complete'` 之后再加 1.5s 让 hook 落盘 —— hook 是异步 spawn 的子进程。

---

## 模板：单文件 git checkout 做 A/B（不动 worktree）

需要在 commit A 和 commit B 之间反复切换跑 bench，但不想 stash / worktree？只 checkout **行为差异所在的单个文件**：

```bash
git status   # 必须 clean

# 跑 baseline (HEAD)
node claudecodeui/server/__plan-c-bench.mjs

# 切到 C1 状态（只换 claude-sdk.js）
git checkout 25f7ee7 -- claudecodeui/server/claude-sdk.js
# 重启 server（kill + npm run server）
node claudecodeui/server/__plan-c-bench.mjs

# 还原
git restore --staged claudecodeui/server/claude-sdk.js
git checkout -- claudecodeui/server/claude-sdk.js
```

**前提**：要对比的差异只在少数文件里（Plan C 的 C1→C3 差异主要在 `claude-sdk.js`）。如果差异跨多个文件（hooks.json 改了 + claude-sdk.js 改了 + plugin-hooks.js 改了），用 `git worktree add ../proj-c1 25f7ee7` 反而更稳。

**陷阱**：换完文件后**必须 kill 旧 server 重起**。webui 是 require-cache 的，源文件改了进程里的 module 不重载。

---

## 已知坑（踩过的，按出现频率排序）

### 坑 1: EdgeClaw.app 跟源码 server 抢 3001

如果背景里在跑打包好的 `EdgeClaw.app`，它会占住 3001 端口，源码 server 起不来。bench 脚本接到的是 packaged app 的 server，A/B 切 commit 完全无效。

```bash
# 优雅退出
osascript -e 'tell application "EdgeClaw" to quit'
# 兜底
pkill -f 'EdgeClaw' ; pkill -f 'claudecodeui/server/index.js'
lsof -ti:3001 | xargs -r kill -9
```

### 坑 2: auth.db 路径不一致

打包后的 `EdgeClaw.app` 用 `/Applications/EdgeClaw.app/Contents/Resources/claudecodeui/server/database/auth.db`，源码 server 用 `~/.cloudcli/auth.db`。如果 bench 时报 `no such table: users`，多半是连错了 db。

源码 server 看 `~/.cloudcli/auth.db`：里面要至少 1 个 user，bench 脚本里 `DISABLE_LOCAL_AUTH` 才有意义。

```bash
sqlite3 ~/.cloudcli/auth.db 'select count(*) from users;'   # 应 ≥ 1
```

### 坑 3: bench 脚本 `Cannot find package 'ws'`

如果脚本放在 `/tmp/foo.mjs` 跑，找不到 `ws` 因为不在 `node_modules` 解析路径上。**永远把 bench 脚本放在 `claudecodeui/server/` 下**（命名 `__plan-c-bench.mjs` 这种 `__` 前缀，明确是 dev artifact）。

### 坑 4: 双重注册（Plan C 的核心 bug）

SDK 加载 plugin 的来源有 3 条：

1. 全局 `~/.claude/installed_plugins.json`（之前安装过就一直在）
2. `--plugin-dir <path>`（session-only，CLI 参数）
3. `options.plugins[]`（SDK API，少用）

**坑**：1 和 2 同时存在时，同一个 plugin 会被 `mergePluginSources` 注册两次。每个 hook event 对应的命令也跑两次。
**信号**：SDK debug log 里 `Registered 6 hooks from 2 plugins`（实际只 1 个 plugin）+ inbox 行数翻倍。
**修复**：要么从 `installed_plugins.json` 卸了，要么去掉 `--plugin-dir`。Plan C 选后者（保留 `--plugin-dir`，因为它跟着源码版本走，更可控）。

### 坑 5: 多 hook command 注册让 inboxDelta 失真

`hooks.json` 给 `PostToolUse` 注册了 capture + budget 两个 command；`Stop` 注册了 capture + budget + aggregator 三个。**单触发**情况下，1 个 prompt 用 1 次 Bash，inbox 增量是 1 + 2 + 2 = 5 行，看 `wc -l` 会以为不对。

判别方式（核心）：

```bash
# 只数 capture 行（有 payload 字段）
jq -c 'select(.payload != null) | .event' ~/.turnkey/inbox.jsonl | tail -10
```

或者像 bench 脚本那样 group by event 后看每桶是不是 1。

### 坑 6: `cursor-ide-browser` MCP 不能 spawn 新 view

想用 MCP 模拟"在浏览器里手动点 send"做 Step 3 验证 —— 不行。`browser_navigate` / `browser_tabs.create` 都返回 `Browser view not found`。MCP 假定已有 view 在跑，不会主动开。**所以 Step 3 必须用 WS probe 脚本，不要浪费时间在 browser MCP 上**。

### 坑 7: probe / bench 超时

LLM 响应 prompt 通常要 10-30s，permission_request 到达可以再延后 5-10s。bench 默认 90s 够用，**probe 默认 25s 经常不够**，建议至少 60s：

```javascript
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 60_000;
```

如果 probe 拿到 `AMBIGUOUS` verdict（既没 permission_request 也没 first text），先把 timeout 拉到 90s 重跑，再下结论。

---

## 真实例子：Plan C 验证报告（2026-04-27）

为了让"这套方法是真的能用的"有 ground truth，附 Plan C 跑出来的实测：

**Step 1 (启动日志)** — `/tmp/plan-c-c3-server-v2.log`：

```
[plugin] turnkey plugin will be loaded by CLI via --plugin-dir
  /Users/da/ws/edgeclaw-test-0422/packages/turnkey-cc-plugin
```

**Step 2 (SDK debug)** — `~/.claude/debug/sdk-...txt`：

```
Loaded 1 session-only plugins from --plugin-dir
Loaded 10 skills from plugin turnkey default directory
Registered 3 hooks from 1 plugin
```

总 11 skills（10 turnkey + 1 skill-creator），符合预期。

**Step 3 (probe)** — `/turnkey:start "smoke C ticket plan-c-probe"` 拿到 `permission_request`，`toolName=Bash`，`input.command=node .../packages/turnkey-cc-plugin/hooks/turnkey-bootstrap.js "smoke C ticket plan-c-probe"`。✅ 命令端到端识别。

**Step 4 (A/B bench)**：

| Commit | captureByEvent | verdict |
| ---- | ---- | ---- |
| C1 (`25f7ee7`) | UserPromptSubmit:2, PostToolUse:2, Stop:2 | DOUBLE |
| C3 (`ae06fc4`) | UserPromptSubmit:1, PostToolUse:1, Stop:1 | SINGLE |

完美 2:1，验证 Plan C 拆 Solution A 后 hook 不再双触发。

---

## 把这套方法用到下一个 plugin 上的 checklist

复制下面这块到 PR description：

```
## Plugin Behavior Verification

Followed `.cursor/skills/claude-agent-sdk-plugin-verify/SKILL.md`:

- [ ] Step 1 — server log 包含 plugin 加载入口（贴 grep 结果）
- [ ] Step 2 — SDK debug log 包含 `Loaded N skills` / `Registered M hooks from K plugins`，K 是预期值
- [ ] Step 3 — WS probe 拿到正确的 first permission_request（贴 toolName + input.command）
- [ ] Step 4 — bench 脚本对比 main vs PR HEAD：captureByEvent 一致或符合预期变化（贴表格）
- [ ] 已确认无 §坑 4 双重注册（log 里 `K plugins` = 实际 plugin 数）
```

每条都附 evidence（log 片段、bench 输出）。reviewer 能 5 分钟把同一套跑一遍，PR 就过关。
