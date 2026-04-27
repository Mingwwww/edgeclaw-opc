/**
 * Plan C smoke regression: 验证 turnkey 插件路径解析 + 关键资源齐全。
 *
 * 不测真实 SDK 启动（那要跑 CLI 子进程），但能挡住"plugin 移位 / 关键文件
 * 缺失"类的事故。来源：TODO-PluginSlashFix-PlanC.md §6.5。
 *
 * 设计原则：
 *   - 仅用 node:test + node:assert，跟仓库其它 *.test.js 风格一致。
 *   - 路径解析复用 claude-sdk.js 实际调用的同一个 resolveTurnkeyPluginRoot。
 *   - 对路径解析失败（plugin 不在 monorepo 里）gracefully skip，避免在
 *     非 monorepo 部署中误报。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { resolveTurnkeyPluginRoot } from './plugin-hooks.js';

test('Plan C: turnkey plugin root resolves from claudecodeui cwd', async (t) => {
  const root = await resolveTurnkeyPluginRoot(process.cwd());
  if (!root) {
    t.skip('turnkey-cc-plugin 不在当前 monorepo（部署环境正常情况）');
    return;
  }
  assert.ok(typeof root === 'string', 'root 应是字符串');
  assert.ok(path.isAbsolute(root), 'root 应是绝对路径');
});

test('Plan C: plugin root 包含 CLI 加载所需的关键文件', async (t) => {
  const root = await resolveTurnkeyPluginRoot(process.cwd());
  if (!root) {
    t.skip('turnkey-cc-plugin 不在当前 monorepo（部署环境正常情况）');
    return;
  }

  assert.ok(
    existsSync(path.join(root, '.claude-plugin', 'plugin.json')),
    'CLI loader 入口 .claude-plugin/plugin.json 必须存在'
  );
  assert.ok(
    existsSync(path.join(root, 'hooks', 'hooks.json')),
    'event hooks 配置 hooks/hooks.json 必须存在'
  );
  assert.ok(
    existsSync(path.join(root, 'skills', 'start', 'SKILL.md')),
    '/turnkey:start 命令对应的 skills/start/SKILL.md 必须存在'
  );
});
