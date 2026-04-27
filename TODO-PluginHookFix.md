# TODO: Plugin Hooks / Slash Skill Bridge

> 目的：给后续开发者一个起点，继续把 `turnkey-cc-plugin` 在 `claudecodeui` WebUI 中补齐到接近 Claude Code CLI 的体验。
>
> **状态（2026-04 Plan C 落地后）**：event hooks **+** slash commands / skills 都已接通。本文档保留作为历史背景与回退知识。

## 当前结论

`claudecodeui` 里**两条链路已全部接通**：plugin event hooks 和 plugin slash commands / skills 走的是同一条 SDK `options.plugins → --plugin-dir` 路径，都由 CLI 子进程原生加载。

历史上这是分两步做的：

| 阶段 | 范围 | 实现 |
| ---- | ---- | ---- |
| **Solution A**（已废弃，被 Plan C 取代） | 仅 event hooks | `claudecodeui/server/plugin-hooks.js` 把 `hooks.json` 转成 SDK `options.hooks` callback |
| **Plan C**（当前生效） | event hooks + commands + skills | `claude-sdk.js` 传 `sdkOptions.plugins = [{type:'local', path: turnkeyPluginRoot}]`，CLI 子进程通过 `--plugin-dir` 加载 plugin |

迁移文档：[`TODO-PluginSlashFix-PlanC.md`](./TODO-PluginSlashFix-PlanC.md)。

实施 commit（`feat/turnkey-plugin-native-loading` 分支）：

- `25f7ee7` — feat(claudecodeui): Plan C C1 — register turnkey plugin via SDK options.plugins
- `fae9f2c` — refactor(claudecodeui): Plan C C2 — remove Solution A hook injection
- (this commit) — chore: Plan C C3 — deprecate plugin-hooks.js + smoke regression + update TODO

`plugin-hooks.js` 文件保留但加了 `@deprecated` 标记，仅 `resolveTurnkeyPluginRoot` 仍被 `claude-sdk.js` 使用。剩余导出（`buildCommandHookCallback` / `loadPluginHooksFromDir` / `mergeHookMaps` / `buildHookMapFromConfig`）作为 SDK 0.3+ 不兼容时的回退路径保留。

## 历史背景：Solution A（event hooks 桥接）

> 已被 Plan C 取代。下面这一节描述 Solution A 在 Plan C 之前的工作方式，仅作历史 / 回退知识。

这两条链路是两套机制：

- **Event hooks**：生命周期事件触发外部脚本，例如 `UserPromptSubmit`、`PostToolUse`、`Stop`。
- **Slash commands / skills**：用户输入 `/turnkey:start ...` 后，Claude Code 从 plugin command/skill 表中找到对应 `SKILL.md`，把它展开成 prompt，让模型按这个 skill 执行。

Solution A 时代只做了前者，所以：

- WebUI 发消息时，`turnkey-capture.js`、`turnkey-budget.js` 等 hook 能触发。
- `~/.turnkey/inbox.jsonl` 能写入事件。
- `turnkey-bootstrap.js` 一旦被执行，后续 hook 能正确读到新的 `~/.turnkey/runlog.json`，从而归属到新 `ticket_id`。
- 但 `/turnkey:start` 本身还不会被 WebUI 识别为 plugin skill，因为 SDK 子进程没有加载 `turnkey-cc-plugin` 的 `skills/start/SKILL.md` 到 command/skill 表和 system prompt。

Plan C 通过让 CLI 子进程自己加载 plugin 一次性解决了这个 gap。

## 已完成的桥接：event hooks

相关文件：

- `claudecodeui/server/plugin-hooks.js`
- `claudecodeui/server/claude-sdk.js`
- `packages/turnkey-cc-plugin/hooks/hooks.json`

核心流程：

1. `claudecodeui/server/claude-sdk.js` 调用 `resolveTurnkeyPluginRoot()` 找到 `packages/turnkey-cc-plugin`。
2. `loadPluginHooksFromDir()` 读取 `hooks/hooks.json`。
3. `buildHookMapFromConfig()` 把 Claude Code plugin 格式的 command hook 转成 Claude Agent SDK 的 `sdkOptions.hooks` callback。
4. 每个 callback 用 `child_process.spawn()` 执行原 hook command，并把 SDK hook input 以 JSON 写入子进程 stdin。
5. `mergeHookMaps()` 把 WebUI 内置 hook 和 turnkey plugin hook 合并后传给 SDK。

`hooks.json` 中当前注册：

- `UserPromptSubmit`
  - `node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-capture.js --event UserPromptSubmit`
- `PostToolUse`
  - `node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-capture.js --event PostToolUse`
  - `node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-budget.js --event PostToolUse`
- `Stop`
  - `node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-capture.js --event Stop`
  - `node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-budget.js --event Stop`
  - `node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-substep-aggregator.js`

## 已验证的端到端现象

WebUI 中直接让模型执行：

```bash
node /Users/da/ws/edgeclaw-test-0422/packages/turnkey-cc-plugin/hooks/turnkey-bootstrap.js "为 claudecodeui/server/plugin-hooks.js 加调用计数器：每个 hook event 触发次数 + 最后触发时间，最小实现"
```

验证结果：

- 生成新 `ticket_id`: `abeb5ea2cbbe`
- 创建目录：`~/.turnkey/artifacts/abeb5ea2cbbe/`
- 当前 `~/.turnkey/runlog.json` 被写成新 ticket：
  - `ticket_id = abeb5ea2cbbe`
  - `current_stage = onboard`
- 旧 runlog 被归档为类似：
  - `~/.turnkey/runlog.aa9bc577a94d.json`
- 后续 `PostToolUse` / `Stop` hook 写入 `~/.turnkey/inbox.jsonl` 时，能读到新的 `ticket_id = abeb5ea2cbbe`。

关键点：hook 脚本之间没有直接通信，靠 `~/.turnkey/runlog.json` 作为当前 ticket 的共享状态。`turnkey-bootstrap.js` 写 runlog，`turnkey-capture.js` / `turnkey-budget.js` 每次事件触发时现读 runlog。

## 当前缺口：slash / skill routing

相关文件：

- `packages/turnkey-cc-plugin/.claude-plugin/plugin.json`
- `packages/turnkey-cc-plugin/skills/start/SKILL.md`
- `claude-code-main/src/utils/plugins/loadPluginCommands.ts`
- `claude-code-main/src/utils/turnkeySubcommandRouting.ts`

Claude Code CLI 中的命名规则：

- `plugin.json` 里 `"name": "turnkey"`
- `skills/start/SKILL.md`
- 组合成 command name：`turnkey:start`

所以 `/turnkey:start "..."` 本质上是一个 plugin skill command。

CLI 能识别它的前提是：

1. plugin loader 启用了 `turnkey-cc-plugin`。
2. `getPluginSkills()` 扫到 `skills/start/SKILL.md`。
3. command 表里出现 `turnkey:start`。
4. slash parser 能从 `/turnkey:start ...` 找到这个 command。
5. skill 内容被展开成 prompt，注入给模型。

WebUI 当前没有完成这条链。WebUI 只是把 `/turnkey:start ...` 当普通用户 prompt 交给 SDK；SDK 子进程没有加载 turnkey plugin skills，因此模型不知道 `turnkey:start` 是什么。

## 推荐后续方案

### 方案 B：先做轻量 skill 注入

目标：快速恢复 WebUI 中 `/turnkey:start` 和自然语言触发 turnkey 的体验。

做法：

1. 在 `claudecodeui/server/claude-sdk.js` 中，复用已经解析出的 `pluginRoot`。
2. 读取 `packages/turnkey-cc-plugin/skills/start/SKILL.md`。
3. 将其作为 "available skill: turnkey" 追加进 SDK system prompt 或 equivalent prompt prepend 位置。
4. 在 prompt 中明确：
   - 用户输入 `/turnkey:start "<ticket>"` 时，先执行 Phase 0 bootstrap。
   - bootstrap 必须是单一 Bash 调用：
     `node ${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-bootstrap.js "<ticket text>"`
   - bootstrap 成功后按 `SKILL.md` 的阶段继续。

优点：

- 改动小。
- 不依赖 SDK plugin API 是否稳定。
- 能立刻让模型知道 turnkey skill 的存在。

限制：

- 不是真正的 command registry。
- slash autocomplete / `/help` / `hasCommandByName()` 仍不会知道 `turnkey:start`。
- 多 plugin、多 skill 扩展性较弱。

验收标准：

- WebUI 输入 `/turnkey:start "测试 ticket"` 时，模型不再回复 "unknown skill"。
- 模型会请求 Bash 执行 `turnkey-bootstrap.js`。
- 批准 Bash 后，`~/.turnkey/runlog.json` 出现新 `ticket_id`。
- 后续 `PostToolUse` 和 `Stop` 事件写入 `~/.turnkey/inbox.jsonl`，并带新 `ticket_id`。

### 方案 C：完整接入 plugin commands / skills

目标：让 WebUI SDK 模式接近 Claude Code CLI 的 plugin 行为。

做法方向：

1. 调研 `@anthropic-ai/claude-agent-sdk` 当前版本是否支持 plugin 配置，例如 plugin dirs / inline plugins / enabled plugins。
2. 在 `claudecodeui/server/claude-sdk.js` 构造 SDK options 时传入 turnkey plugin 路径。
3. 让 SDK 子进程自己跑 Claude Code 的 plugin loader。
4. 让 `getPluginCommands()` / `getPluginSkills()` 正常加载 `turnkey:start`、`turnkey:onboard`、`turnkey:clarify` 等 command。

优点：

- 和 CLI 行为一致。
- slash routing、skill registry、自然语言 skill 触发都走原生路径。
- 适合长期维护。

风险 / 注意点：

- SDK plugin API 可能不稳定。
- 要确认 SDK 子进程的 cwd / project context / bare mode 是否会影响 plugin loading。
- 需要避免和现有 Solution A 的 hook 注入重复注册同一批 hooks。

验收标准：

- WebUI 输入 `/turnkey:start "测试 ticket"` 命中真实 `turnkey:start` command。
- WebUI 输入 `/turnkey start "测试 ticket"` 可被路由成 `/turnkey:start`。
- WebUI 输入自然语言"用 turnkey 帮我启动一个 ticket..."时，模型能识别 turnkey skill。
- `~/.turnkey/inbox.jsonl` 不出现重复 hook 事件。

## 需要特别防止的回归

- Hook 脚本失败不能阻塞 agent。当前 `plugin-hooks.js` 遵循非阻塞原则：spawn 失败、stdout 解析失败、timeout 都 resolve `{}`。
- `${CLAUDE_PLUGIN_ROOT}` 必须在 command string 和 env 中都正确设置。
- `CLAUDE_PROJECT_DIR` 应该使用 hook input 的 `cwd`，没有时退回 `process.cwd()`。
- `turnkey-bootstrap.js` 必须保持单一 Bash 调用，不要拆成多个并行 tool use。
- `runlog.json` 是当前 ticket 的单点状态。任何缓存 `ticket_id` 的优化都会破坏"bootstrap 后续 hook 自动归属新 ticket"。
- 如果方案 C 启用 SDK 原生 plugin hooks，需要检查是否还需要 Solution A，避免同一 event 被注册两次。

## 建议的下一步实现顺序

> 历史路径，已按 Plan C 直接跳到 §4 完成，无需再做。

1. ~~先实现方案 B~~（跳过：直接做 Plan C 收益更高）
2. ~~补 WebUI smoke test~~ → 已在 `claudecodeui/server/plan-c-smoke.test.js` 中加了路径解析回归
3. ~~调研方案 C~~ → 已落地（详见 [`TODO-PluginSlashFix-PlanC.md`](./TODO-PluginSlashFix-PlanC.md)）
4. ~~删除或 gate 掉 Solution A~~ → 已删 (commit `fae9f2c`)

## 残留 TODO（Plan C 之后）

- **§6.4 双触发 vs 单触发实测**：跑真实 webui，清空 `~/.turnkey/inbox.jsonl`，发起 1 次 prompt，确认 `wc -l` 等于实际事件数 N（不是 2N）。这一步要本地跑 claudecodeui，按 PlanC §6.4 操作。
- **Slash autocomplete UI**：webui 输入 `/turnkey:` 时弹 commands 列表。SDK init message 的 `commands` 字段已经能直接喂给 UI，需要 client 端配合。
- **多 plugin 并存**：`sdkOptions.plugins` 是数组，原生支持多个；但 `resolveTurnkeyPluginRoot` 是单 plugin 的硬编码解析器，需要换成"发现 `packages/*-cc-plugin/`"的扫描器。
- **Plugin enable/disable 管理面板**：让用户在 webui 里勾选启用哪些 plugin。

