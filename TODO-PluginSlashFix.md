# TODO: Plugin Slash / Skill Bridge for claudecodeui

> 后续工作的导航文档，专注于把 plugin slash commands / skills 接进 `claudecodeui`。
>
> 上游背景（hook 桥接、整体机制对照、为什么 slash 这条链当前不通）已在
> [`TODO-PluginHookFix.md`](./TODO-PluginHookFix.md) 中讲清楚了。本文不重复那部分，只覆盖：
> 1. CLI 端是怎么做的（精确到代码位置，方便后续开发者快速建立上下文）。
> 2. 方案 B 的具体改动草稿（轻量 skill 注入，作为快速首发选项）。
> 3. 方案 C 的要点 + 跳转（完整 self-contained 文档：[`TODO-PluginSlashFix-PlanC.md`](./TODO-PluginSlashFix-PlanC.md)）。
> 4. 验证矩阵 / 防回归清单。

## 1. 一句话定位

`claudecodeui` 当前只接通了 SDK 的 `options.hooks` (Solution A)。它**没有**：

- 注册 plugin command 表（`turnkey:start`、`turnkey:onboard` …）。
- 把 `SKILL.md` 内容注入 SDK 子进程的 system prompt。
- 实现 `/turnkey start <ticket>` → `/turnkey:start <ticket>` 的两段式路由。

所以模型不知道 `turnkey:start` 是什么，自然语言也召不出 turnkey skill。这份 TODO 给出补全这三条链的具体动手计划。

## 2. 上游 CLI 是怎么做的（必读 line refs）

### 2.1 命名规则：`pluginName:fileBaseName`

```60:97:claude-code-main/src/utils/plugins/loadPluginCommands.ts
function getCommandNameFromFile(
  filePath: string,
  baseDir: string,
  pluginName: string,
): string {
  const isSkill = isSkillFile(filePath)

  if (isSkill) {
    // For skills, use the parent directory name
    const skillDirectory = dirname(filePath)
    const parentOfSkillDir = dirname(skillDirectory)
    const commandBaseName = basename(skillDirectory)
```

把这套规则套到 turnkey：

- `packages/turnkey-cc-plugin/.claude-plugin/plugin.json` → `"name": "turnkey"`
- `packages/turnkey-cc-plugin/skills/start/SKILL.md` → skill 短名 `start`
- 合成 command 名：`turnkey:start`

### 2.2 Skill 加载主链路

```840:946:claude-code-main/src/utils/plugins/loadPluginCommands.ts
export const getPluginSkills = memoize(async (): Promise<Command[]> => {
```

`getPluginSkills()` 遍历每个 enabled plugin 的 `skillsPath`，对每个 `<dir>/SKILL.md` 调用 `loadSkillsFromDirectory()` → `createPluginCommand(..., isSkill=true)`，最终拿到一组 `Command`。

> 注意：turnkey-cc-plugin **没有** `commands/` 目录。它的 9 个 stage（`start`、`onboard`、`clarify`、`design`、`spec`、`tdd`、`develop`、`test`、`review`、`ship`）全部走 skills 路径。

### 2.3 两段式 slash 语法糖

```15:42:claude-code-main/src/utils/turnkeySubcommandRouting.ts
export function routeTurnkeySubcommand(
  commandName: string,
  args: string,
  hasCommandByName: (name: string) => boolean,
): RoutedSlashCommand {
  if (commandName.toLowerCase() !== 'turnkey') {
    return { commandName, args, routed: false }
  }
```

允许用户写 `/turnkey start "<ticket>"`（空格而不是冒号），但**前提**是 `hasCommandByName('turnkey:start') === true`。在 webui 里这个表是空的，所以 routing 也兜不住。

### 2.4 SKILL.md 怎么变成模型看见的 prompt

`createPluginCommand()` 返回的 `Command` 在 `getPromptForCommand()` 中把 `SKILL.md` body 展开为 prompt（替换 `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` / 参数等），最终通过 `SkillTool` 暴露给模型。

```326:401:claude-code-main/src/utils/plugins/loadPluginCommands.ts
      async getPromptForCommand(args, context) {
        // For skills from skills/ directory, include base directory
        let finalContent = config.isSkillMode
          ? `Base directory for this skill: ${dirname(file.filePath)}\n\n${content}`
          : content
```

> 这是方案 B 的关键灵感：我们不需要复刻整套 `Command` 注册，**只需要把 `SKILL.md` 的内容（含变量替换）加进 system prompt**，模型就能识别 turnkey skill。

## 3. 方案 B：轻量 skill 注入（首发，2-3 小时工作量）

### 3.1 目标

让 webui 输入 `/turnkey:start "<ticket>"` 或自然语言 "用 turnkey 启动一个 ticket" 时，模型知道：

1. turnkey 是什么、什么时候用。
2. Phase 0 必须跑 `turnkey-bootstrap.js`。
3. 后续走 8-stage funnel（onboard / clarify / design / …）。

### 3.2 改动文件清单

| 文件 | 改动 |
| ---- | ---- |
| `claudecodeui/server/plugin-skills.js` (**新增**) | 实现 `loadPluginSkillsAsSystemPrompt(pluginRoot)`：扫 `skills/*/SKILL.md`，做 `${CLAUDE_PLUGIN_ROOT}` 替换，拼成一段可注入的 system prompt 片段。 |
| `claudecodeui/server/claude-sdk.js` | 复用已有的 `pluginRoot` 解析；调用 `loadPluginSkillsAsSystemPrompt`；把结果追加进 `sdkOptions.appendSystemPrompt` 或等价字段。 |
| `claudecodeui/server/plugin-skills.test.js` (**新增**) | 单测：mock 一个含 SKILL.md 的临时目录，断言变量替换 + 多 skill 串接 + 缺失目录返回空字符串。 |
| `TODO-PluginHookFix.md` | 完成方案 B 后，把"已完成的桥接"一节的范围扩展到 skill 注入。 |

### 3.3 改动草稿（伪代码）

`plugin-skills.js`：

```js
import { promises as fs } from 'node:fs';
import path from 'node:path';

const VAR_PLUGIN_ROOT = /\$\{CLAUDE_PLUGIN_ROOT\}/g;
const VAR_SKILL_DIR   = /\$\{CLAUDE_SKILL_DIR\}/g;

async function loadOneSkill(pluginRoot, skillDir) {
  const skillFile = path.join(skillDir, 'SKILL.md');
  let raw;
  try { raw = await fs.readFile(skillFile, 'utf8'); }
  catch (e) { return null; }

  // 不做完整 frontmatter 解析，简单按首尾 --- 切；description 留全文给模型读。
  const content = raw
    .replace(VAR_PLUGIN_ROOT, () => pluginRoot)
    .replace(VAR_SKILL_DIR, () => skillDir);

  return { name: path.basename(skillDir), content };
}

export async function loadPluginSkillsAsSystemPrompt(pluginRoot, opts = {}) {
  const skillsRoot = path.join(pluginRoot, 'skills');
  let entries;
  try { entries = await fs.readdir(skillsRoot, { withFileTypes: true }); }
  catch (_) { return ''; }

  const skills = [];
  for (const ent of entries) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const loaded = await loadOneSkill(pluginRoot, path.join(skillsRoot, ent.name));
    if (loaded) skills.push(loaded);
  }
  if (skills.length === 0) return '';

  const pluginName = await readPluginName(pluginRoot); // 读 .claude-plugin/plugin.json
  return [
    `# Available plugin: ${pluginName}`,
    `These skills can be invoked by the user with \`/${pluginName}:<skill>\` or referenced naturally.`,
    `When a skill matches, follow its SKILL.md exactly (Phase 0 first, then phases in order).`,
    '',
    ...skills.map(s => `## /${pluginName}:${s.name}\n\n${s.content}`),
  ].join('\n\n');
}
```

`claude-sdk.js` 接入位置（参考已有 hook 注入紧邻它放）：

```js
// 紧跟 sdkOptions.hooks = mergeHookMaps(...) 之后
let pluginSkillPrompt = '';
try {
  if (pluginRoot) {
    pluginSkillPrompt = await loadPluginSkillsAsSystemPrompt(pluginRoot);
  }
} catch (e) {
  console.warn('[plugin-skills] failed to load (non-fatal):', e?.message || e);
}
if (pluginSkillPrompt) {
  // appendSystemPrompt 在 SDK 0.2.x 是合并到 system prompt 末尾的字段；如果当前
  // 版本字段名不一致，看 sdk.d.ts 取实际名称（systemPromptAppend / appendSystemPrompt）。
  sdkOptions.appendSystemPrompt = (sdkOptions.appendSystemPrompt || '') + '\n\n' + pluginSkillPrompt;
}
```

> ⚠️ 实际字段名要去 `claudecodeui/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 里确认（参考 hook 接入时核对 `HookCallbackMatcher` 的方式）。

### 3.4 验收标准

依次跑下面 4 步，全过即视为方案 B 完成：

1. **冷启动**
   - `cd claudecodeui && PLUGIN_HOOKS_DEBUG=1 npm run dev`
   - 启动日志能看到：
     - `[plugin-hooks] turnkey plugin hooks registered`
     - `[plugin-skills] turnkey plugin skills injected (10 skills)`（或类似日志）

2. **Slash 调用**
   - webui 输入 `/turnkey:start "smoke ticket B"`。
   - 模型响应中明确提到 Phase 0 / bootstrap。
   - 模型请求 Bash 执行 `node .../turnkey-bootstrap.js "smoke ticket B"`。

3. **Bootstrap 落地**
   - 批准 Bash 后：
     - `~/.turnkey/runlog.json` 的 `ticket_id` 是 `sha256("smoke ticket B").slice(0,12)`。
     - 旧 runlog 被归档为 `~/.turnkey/runlog.<old_id>.json`。
     - `~/.turnkey/artifacts/<new_id>/` 已创建。

4. **Hook 归属**
   - 紧接着的 `PostToolUse` 和 `Stop` 事件在 `~/.turnkey/inbox.jsonl` 中带上**新的** `ticket_id`。

### 3.5 Smoke test 自动化（可选，建议同步加）

在 `claudecodeui/server/__tests__/turnkey-smoke.test.js` 加一个 e2e：

- 设置 `TURNKEY_HOME=$(mktemp -d)`。
- 用 `loadPluginSkillsAsSystemPrompt` 读取 plugin。
- 断言返回字符串里包含：
  - `## /turnkey:start`
  - `Phase 0`
  - `${CLAUDE_PLUGIN_ROOT}` **不应**出现（说明替换发生了）。

## 4. 方案 C：完整接入 plugin loading（长期方向）

> **完整实施文档已迁出**：[`TODO-PluginSlashFix-PlanC.md`](./TODO-PluginSlashFix-PlanC.md)（self-contained，可独立动手）。
>
> 本节只保留要点，避免在主 TODO 里重复一份长文档。

### 4.1 一句话结论

`@anthropic-ai/claude-agent-sdk@0.2.59` **已经原生支持** `options.plugins: SdkPluginConfig[]`，SDK 内部把它翻译成 CLI 的 `--plugin-dir`，CLI 自动加载 `hooks/hooks.json` + `skills/*/SKILL.md` + `commands/`，bare 模式不阻挡。`/turnkey:start` 即可被识别，`/turnkey start ...` 的两段式 routing 也免费跟进。

### 4.2 关键风险（不能忽略）

启用方案 C 必须**同步拆掉** Solution A 在 `claude-sdk.js` 里的 `sdkOptions.hooks` 注入，否则 CLI 内部 hook registry（`zA6` 函数用 `push` 不去重）会让每个 event 触发 **2 次** `turnkey-capture.js`，污染 `inbox.jsonl` / `budget.json`。

如果先上了方案 B，方案 C 上线时也要把 system prompt 注入拆掉（CLI 的 `getPluginSkills()` 会自动经 `SkillTool` 暴露 SKILL.md，重复注入会让 system prompt 翻倍）。

### 4.3 跳转

实施细节、精确 diff 草稿、commit 拆分、smoke test、回滚路径全部在：

- [`TODO-PluginSlashFix-PlanC.md`](./TODO-PluginSlashFix-PlanC.md)

调研依据（line refs 已 grep 验证）：

- SDK 类型：`claudecodeui/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:812, 1606-1620`
- SDK → CLI 翻译：`sdk.mjs`（minified，详细分析见 PlanC §2.2）
- CLI 入参：`claude-code-main/src/main.tsx:1001-1013, 1066-1070`
- Session-only plugin loader：`pluginLoader.ts:2920-2989`
- Bare gate：`loadPluginCommands.ts:414-421, 843`
- Plugin hooks 注册：`loadPluginHooks.ts:120-148`
- Subcommand routing：`turnkeySubcommandRouting.ts:15-42`

## 5. 防回归清单（所有方案都适用）

- [ ] Hook 失败必须非阻塞（已在 `plugin-hooks.js` 中实现，新增 skill 注入也要遵守）。
- [ ] `turnkey-bootstrap.js` 必须保持单一 Bash 调用，不要拆并行。原因见 SKILL.md 的 Phase 0 段：某些 proxy 链路对 multi-tool streaming 处理脆弱。
- [ ] `~/.turnkey/runlog.json` 是当前 ticket 的单点状态，禁止在 webui 侧缓存 `ticket_id`。
- [ ] `${CLAUDE_PLUGIN_ROOT}` 必须替换成绝对路径，且 `CLAUDE_PROJECT_DIR` 用 hook input 的 `cwd`（已有，保留）。
- [ ] 方案 B 拼系统提示时，长度上限要监控：turnkey 9 个 SKILL.md 拼起来约 30-50KB，模型 context 还撑得住，但要避免无脑加更多 plugin 时炸 context。可以在第二阶段加一个 `description-only` 模式（只注入 frontmatter description，不注入 body），等模型决定要用某个 skill 时再读全文。
- [ ] **方案 C 上线 PR 必须同时移除 Solution A 的 `sdkOptions.hooks` 注入**：CLI 端 hook 注册函数 `zA6` 是 `push`（不是 replace），同时保留两条会让每个 event 触发两遍 `turnkey-capture.js`，污染 inbox.jsonl / budget.json。
- [ ] **方案 C 上线 PR 必须同时移除方案 B 的 system prompt 注入**（如果先上了 B）：CLI 自己 `getPluginSkills()` 已经把 SKILL.md 通过 `SkillTool` 暴露给模型，再注入一份就是 system prompt 翻倍。

## 6. 明确的 out-of-scope

这次工作不处理：

- 多 plugin 并存（marketplace、user plugins）。Turnkey 是唯一目标。
- Slash autocomplete UI（webui 输入 `/turnkey:` 时弹补全菜单）。这需要 client 端配合，单独再开 issue。
- Plugin install / enable / disable 的运行时管理面板。

## 7. 参考代码 anchors

留给后续开发者快速跳转：

- 已通的 hook 桥（看格式怎么照搬到 skill）：
  - `claudecodeui/server/plugin-hooks.js`
  - `claudecodeui/server/claude-sdk.js` (`resolveTurnkeyPluginRoot` / `mergeHookMaps` 调用点 ~L800)
- CLI 端 plugin command / skill 加载（实现参考）：
  - `claude-code-main/src/utils/plugins/loadPluginCommands.ts`
  - `claude-code-main/src/utils/turnkeySubcommandRouting.ts`
- Turnkey plugin 内部结构：
  - `packages/turnkey-cc-plugin/.claude-plugin/plugin.json`
  - `packages/turnkey-cc-plugin/skills/*/SKILL.md`
  - `packages/turnkey-cc-plugin/hooks/*.js`
- 真实样本（最近一次成功 bootstrap 的产物）：
  - `~/.turnkey/runlog.json` (`ticket_id: abeb5ea2cbbe`)
  - `~/.turnkey/artifacts/abeb5ea2cbbe/`
  - `~/.turnkey/inbox.jsonl` (~16 行带新 `ticket_id` 的 cursor_hook + budget_tick)

---

**建议起手顺序**（更新于 2026-04-26，调研已完成）：

- **快路径**：直接进 [`TODO-PluginSlashFix-PlanC.md`](./TODO-PluginSlashFix-PlanC.md) §5 Commit C1。SDK plugin API 调研已完成，验证步骤清晰，10 分钟内可见首份证据。
- **保守路径**：先做方案 B（本文 §3）作为不依赖 SDK plugin API 的兜底；上线方案 C 时再拆 B + Solution A。
- 方案 B 与方案 C 的代码层重叠在 `claude-sdk.js`，建议任选其一不要并行落地。
