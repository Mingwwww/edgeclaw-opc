#!/usr/bin/env node
/**
 * Plan C double-trigger regression bench (§6.4 of TODO-PluginSlashFix-PlanC.md).
 *
 * 单 prompt 跑通整个 webui WS 协议，同时统计 ~/.turnkey/inbox.jsonl 增量。
 *
 * 真正能看出双触发的指标是 **每个 hook event 来自 turnkey-capture.js 的
 * 行数**，而不是裸的 wc -l。原因：hooks.json 给 PostToolUse/Stop 都注册了
 * capture + budget 多条 command，每个 event 的 inbox 行数 = N(commands)，
 * 跟双触发是正交的。区分方式：
 *   - capture 行 schema 有 "payload" 键
 *   - budget  行 schema 有 "added_tokens" 键
 *
 * 期望：
 *   - 5c5740e (pre-C1, 只有 Solution A)         → capture/event = 1 (单触发)
 *   - 25f7ee7 (C1, Solution A + --plugin-dir)   → capture/event = 2 (双触发)
 *   - fae9f2c+ (C2/C3, 只有 --plugin-dir)        → capture/event = 1 (单触发)
 *
 * 用法：
 *   1. 起源码 server (npm run server)；要求 DISABLE_LOCAL_AUTH 默认 true
 *      且 ~/.cloudcli/auth.db 至少有 1 个 user (该脚本 bypass 不传 token)。
 *   2. node claudecodeui/server/__plan-c-bench.mjs
 *
 * 该脚本 by design 是 PR artifact，不是正式 test。它读真实 ~/.turnkey/，
 * 真实调用模型 (要消耗 token)。请在用户许可下运行。
 *
 * 来源契约：
 *   - claudecodeui/server/index.js:1689      claude-command 路由
 *   - claudecodeui/server/index.js:1739-1750 claude-permission-response
 *   - claudecodeui/server/claude-sdk.js:842  permission_request 形状
 *   - packages/turnkey-cc-plugin/hooks/hooks.json
 *       UserPromptSubmit + Stop + PostToolUse 都会 inbox.append 1 行
 *   - packages/turnkey-cc-plugin/hooks/turnkey-capture.js:99
 *       inbox 行 schema: payload/generation_id/workspace_roots
 *   - packages/turnkey-cc-plugin/hooks/turnkey-budget.js:123
 *       inbox 行 schema: added_tokens/current_estimate/level/stage
 */

import WebSocket from 'ws';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SERVER_URL = process.env.PLAN_C_SERVER_URL || 'ws://localhost:3001/ws';
const PROJECT_PATH = process.env.PLAN_C_PROJECT_PATH || process.cwd();
const INBOX = path.join(os.homedir(), '.turnkey', 'inbox.jsonl');
const TIMEOUT_MS = Number(process.env.PLAN_C_TIMEOUT_MS) || 90_000;
const COMMIT = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
})();

function wcL(p) {
  if (!existsSync(p)) return 0;
  return Number(
    execSync(`wc -l < ${JSON.stringify(p)}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
  );
}

/**
 * Read inbox.jsonl, return only the lines AFTER baseline that came from
 * turnkey-capture.js (one row per hook fire), grouped by event.
 *
 * 鉴别方式：capture 行有 "payload" 字段，budget 行没有。这是观察现有数据
 * 得出的最低成本判别（比加 source 字段省事），见文件头注释。
 *
 * 期望 (单触发，single-trigger)：
 *   { UserPromptSubmit: 1, PostToolUse: N, Stop: 1 }
 *   N = 1 prompt 内 Bash 工具调用次数
 * 双触发 (Solution A + --plugin-dir 共存) 期望：每项 × 2。
 */
function readCaptureEventsSince(file, sliceStart) {
  if (!existsSync(file)) return {};
  const all = readFileSync(file, 'utf8').split('\n');
  const slice = all.slice(sliceStart).filter(Boolean);
  const counts = Object.create(null);
  for (const raw of slice) {
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    if (!obj || typeof obj.event !== 'string') continue;
    if (!('payload' in obj)) continue; // budget / aggregator 行没有 payload
    counts[obj.event] = (counts[obj.event] || 0) + 1;
  }
  return counts;
}

const PROMPT_TAG = `plan-c-bench-${COMMIT}-${Date.now()}`;
const PROMPT = [
  `Please use the Bash tool to run exactly this command, and then stop:`,
  ``,
  `  echo "${PROMPT_TAG}"`,
  ``,
  `Don't read any files. Don't explain. Just call Bash once with that exact command.`
].join('\n');

console.log('[bench]', { COMMIT, PROMPT_TAG, PROJECT_PATH, SERVER_URL });
console.log('[bench] inbox baseline:', wcL(INBOX));

const ws = new WebSocket(SERVER_URL);
let sessionId = null;
let approvedCount = 0;
let toolUses = 0;
let stopReason = null;
let timer;

function done(reason) {
  if (stopReason) return;
  stopReason = reason;
  clearTimeout(timer);
  try { ws.close(); } catch {}
  setTimeout(async () => {
    const after = wcL(INBOX);
    const delta = after - baseline;
    const captureByEvent = readCaptureEventsSince(INBOX, baseline);
    const captureSum = Object.values(captureByEvent).reduce((s, n) => s + n, 0);
    const verdict =
      Object.values(captureByEvent).every(n => n === 1)
        ? 'SINGLE_TRIGGER (expected for C2/C3 / pre-C1)'
        : Object.values(captureByEvent).every(n => n === 2)
          ? 'DOUBLE_TRIGGER (expected for C1 only)'
          : 'MIXED — inspect manually';
    console.log('---');
    console.log('[bench] result', {
      commit: COMMIT,
      stopReason: reason,
      sessionId,
      toolUses,
      approvedCount,
      inboxBaseline: baseline,
      inboxAfter: after,
      inboxDelta: delta,
      captureByEvent,
      captureSum,
      verdict
    });
    process.exit(reason === 'complete' ? 0 : 2);
  }, 1500); // give hooks 1.5s to flush
}

const baseline = wcL(INBOX);

ws.on('open', () => {
  console.log('[bench] ws open');
  ws.send(JSON.stringify({
    type: 'claude-command',
    command: PROMPT,
    options: {
      projectPath: PROJECT_PATH,
      cwd: PROJECT_PATH
    }
  }));
  timer = setTimeout(() => done('timeout'), TIMEOUT_MS);
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.kind === 'session_created') {
    sessionId = msg.sessionId;
    console.log('[bench] session_created', sessionId);
    return;
  }

  if (msg.kind === 'permission_request') {
    const reqId = msg.requestId;
    console.log('[bench] permission_request -> allow', { tool: msg.toolName, reqId });
    ws.send(JSON.stringify({
      type: 'claude-permission-response',
      requestId: reqId,
      allow: true,
      updatedInput: msg.input
    }));
    approvedCount += 1;
    return;
  }

  if (msg.kind === 'tool_use' || msg.type === 'assistant' && msg.message?.content?.some?.(c => c.type === 'tool_use')) {
    toolUses += 1;
  }

  if (msg.kind === 'complete') {
    console.log('[bench] complete', { exitCode: msg.exitCode, aborted: msg.aborted });
    done('complete');
    return;
  }

  if (msg.kind === 'error') {
    console.error('[bench] error from server', msg);
    done('server_error');
    return;
  }

  // verbose 路径，看到关键 kind 都打印一行 hint，方便调试
  if (msg.kind && !['status', 'token_budget'].includes(msg.kind)) {
    console.log('[bench] msg.kind =', msg.kind);
  }
});

ws.on('error', (err) => {
  console.error('[bench] ws error', err.message);
  done('ws_error');
});

ws.on('close', (code, reason) => {
  if (!stopReason) {
    console.log('[bench] ws closed unexpectedly', { code, reason: reason?.toString() });
    done('ws_close');
  }
});
