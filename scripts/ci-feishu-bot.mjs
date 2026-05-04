#!/usr/bin/env node
/**
 * EdgeClaw CI Feishu Bot
 *
 * 飞书群里 @bot 触发 CI 测试，支持排队、状态查询。
 *
 * 命令:
 *   /test               — 测试当前 release 分支最新 commit
 *   /test <sha>          — 测试指定 commit
 *   /test <branch>       — 测试指定分支
 *   /status              — 查看当前队列状态
 *   /history             — 最近 5 次测试结果
 *   /help                — 显示帮助
 *
 * 环境变量:
 *   FEISHU_APP_ID        — 飞书应用 App ID (必填)
 *   FEISHU_APP_SECRET    — 飞书应用 App Secret (必填)
 *   CI_DEFAULT_BRANCH    — 默认分支 (default: release)
 *   CI_FEISHU_WEBHOOK    — 自定义机器人 webhook (降级通知用)
 *
 * 飞书应用创建步骤:
 *   1. https://open.feishu.cn/app → 创建企业自建应用
 *   2. 添加「机器人」能力
 *   3. 权限: im:message, im:message:send_as_bot, im:chat:readonly
 *   4. 事件订阅: im.message.receive_v1 (SDK 模式无需回调 URL)
 *   5. 发布应用 → 在目标群里添加此机器人
 *   6. 设置 FEISHU_APP_ID / FEISHU_APP_SECRET
 *
 * Usage:
 *   FEISHU_APP_ID=xxx FEISHU_APP_SECRET=yyy node scripts/ci-feishu-bot.mjs
 */

import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = process.env.EDGECLAW_ROOT
  || path.resolve(new URL('.', import.meta.url).pathname, '..');

const require = createRequire(
  path.join(REPO_ROOT, 'claude-code-main', 'node_modules', '_placeholder.js')
);

let Lark;
try {
  Lark = require('@larksuiteoapi/node-sdk');
} catch {
  try {
    Lark = require('@larksuite/node-sdk');
  } catch {
    console.error('Missing @larksuiteoapi/node-sdk. Run: cd claude-code-main && bun install');
    process.exit(1);
  }
}

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const DEFAULT_BRANCH = process.env.CI_DEFAULT_BRANCH || 'release';
const WEBHOOK_URL = process.env.CI_FEISHU_WEBHOOK || '';
const REPORT_DIR = path.join(REPO_ROOT, '.ci-reports');
const FEISHU_DOMAIN = 'https://open.feishu.cn';

if (!APP_ID || !APP_SECRET) {
  console.error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
  console.error('See comments at top of this file for setup steps');
  process.exit(1);
}

fs.mkdirSync(REPORT_DIR, { recursive: true });

// ── State ──
let tenantToken = null;
let tokenExpiresAt = 0;
const jobQueue = [];
let currentJob = null;
let isRunning = false;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}][${tag}] ${msg}`);
}

// ── Feishu Token ──
async function ensureToken() {
  const now = Date.now() / 1000;
  if (tenantToken && tokenExpiresAt > now + 60) return tenantToken;

  const res = await fetch(`${FEISHU_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await res.json();
  if (j.code !== 0 || !j.tenant_access_token) {
    throw new Error(j.msg || 'Failed to get tenant_access_token');
  }
  tenantToken = j.tenant_access_token;
  tokenExpiresAt = now + (j.expire || 7200);
  return tenantToken;
}

// ── Send message to Feishu ──
async function sendMessage(chatId, text) {
  try {
    const token = await ensureToken();
    await fetch(`${FEISHU_DOMAIN}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });
  } catch (e) {
    log('SEND', `Failed: ${e.message}`);
  }
}

async function sendCard(chatId, title, content, color = 'blue') {
  try {
    const token = await ensureToken();
    await fetch(`${FEISHU_DOMAIN}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify({
          header: {
            title: { tag: 'plain_text', content: title },
            template: color,
          },
          elements: [{
            tag: 'markdown',
            content,
          }],
        }),
      }),
    });
  } catch (e) {
    log('SEND', `Card failed: ${e.message}`);
  }
}

// ── Git helpers ──
function gitExec(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000 }).trim();
}

function resolveTarget(target) {
  if (!target || target === 'latest') {
    return { branch: DEFAULT_BRANCH, sha: null };
  }
  // SHA-like (7+ hex chars)
  if (/^[0-9a-f]{7,40}$/.test(target)) {
    return { branch: null, sha: target };
  }
  return { branch: target, sha: null };
}

// ── Job runner ──
async function runJob(job) {
  const { chatId, target, userId } = job;
  const { branch, sha } = resolveTarget(target);

  log('JOB', `Starting: target=${target || 'latest'}, branch=${branch}, sha=${sha}`);
  await sendCard(chatId, '🔄 CI 测试开始', [
    `**目标**: ${sha || branch || DEFAULT_BRANCH}`,
    `**触发者**: ${userId || 'unknown'}`,
    `**队列**: ${jobQueue.length} 个等待中`,
  ].join('\n'), 'blue');

  const startTime = Date.now();

  try {
    // Fetch and checkout
    if (branch) {
      gitExec(`git fetch origin ${branch} --quiet`);
      gitExec(`git checkout ${branch} --quiet`);
      gitExec(`git pull origin ${branch} --quiet`);
    } else if (sha) {
      gitExec('git fetch origin --quiet');
      gitExec(`git checkout ${sha}`);
    }

    const headSha = gitExec('git rev-parse --short HEAD');
    const commitMsg = gitExec('git log -1 --format="%s"');

    // Run test
    const testProc = spawn('bash', [
      path.join(REPO_ROOT, 'scripts', 'ci-e2e.sh'), 'smoke'
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, EDGECLAW_ROOT: REPO_ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    testProc.stdout.on('data', d => output += d.toString());
    testProc.stderr.on('data', d => output += d.toString());

    const exitCode = await new Promise(resolve => {
      testProc.on('close', code => resolve(code || 0));
      setTimeout(() => {
        testProc.kill('SIGTERM');
        resolve(124);
      }, 600_000);
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const passed = exitCode === 0;

    // Extract test step results
    const steps = output.split('\n')
      .filter(l => /^\s*[✅❌]/.test(l))
      .slice(0, 15)
      .join('\n') || '(no step details)';

    // Save to history
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(
      path.join(REPORT_DIR, `report-${timestamp}.txt`),
      output
    );

    const historyLine = `${timestamp} | ${passed ? 'PASS' : 'FAIL'} | ${headSha} | ${commitMsg.slice(0, 60)} | exit=${exitCode} | ${elapsed}s | by:${userId}\n`;
    fs.appendFileSync(path.join(REPORT_DIR, 'history.log'), historyLine);

    // Report
    const emoji = passed ? '✅' : '❌';
    const color = passed ? 'green' : 'red';
    await sendCard(chatId, `${emoji} CI ${passed ? 'PASS' : 'FAIL'}: ${headSha}`, [
      `**提交**: \`${headSha}\` — ${commitMsg}`,
      `**分支**: ${branch || 'detached'}`,
      `**耗时**: ${elapsed}s`,
      `**触发者**: ${userId || 'unknown'}`,
      '',
      '**测试结果**:',
      steps,
    ].join('\n'), color);

    log('JOB', `Done: ${passed ? 'PASS' : 'FAIL'} in ${elapsed}s`);

  } catch (e) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    log('JOB', `Error: ${e.message}`);
    await sendCard(chatId, '💥 CI 执行错误', [
      `**目标**: ${target || DEFAULT_BRANCH}`,
      `**错误**: ${e.message}`,
      `**耗时**: ${elapsed}s`,
    ].join('\n'), 'red');
  }
}

async function processQueue() {
  if (isRunning || jobQueue.length === 0) return;
  isRunning = true;
  currentJob = jobQueue.shift();

  try {
    await runJob(currentJob);
  } catch (e) {
    log('QUEUE', `Unhandled error: ${e.message}`);
  }

  currentJob = null;
  isRunning = false;
  processQueue();
}

// ── Command handlers ──
function handleCommand(text, chatId, userId) {
  const cleaned = text
    .replace(/@\S+/g, '')   // Remove @mentions
    .replace(/\s+/g, ' ')
    .trim();

  const parts = cleaned.split(' ');
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/test' || cmd === 'test') {
    const target = parts[1] || null;
    const position = jobQueue.length + (isRunning ? 1 : 0);

    jobQueue.push({ chatId, target, userId, queuedAt: Date.now() });
    log('CMD', `/test ${target || 'latest'} queued (position ${position})`);

    if (position > 0) {
      sendMessage(chatId,
        `📋 已排队 (位置 #${position + 1})\n` +
        `当前正在测试: ${currentJob?.target || DEFAULT_BRANCH}\n` +
        `你的目标: ${target || DEFAULT_BRANCH}`
      );
    }

    processQueue();
    return;
  }

  if (cmd === '/status' || cmd === 'status') {
    const lines = [`**CI 状态**`];
    if (currentJob) {
      const elapsed = ((Date.now() - (currentJob.startedAt || Date.now())) / 1000).toFixed(0);
      lines.push(`🔄 正在测试: ${currentJob.target || DEFAULT_BRANCH} (${elapsed}s)`);
    } else {
      lines.push('💤 空闲');
    }
    if (jobQueue.length > 0) {
      lines.push(`📋 队列: ${jobQueue.length} 个待测`);
      jobQueue.forEach((j, i) => {
        lines.push(`  ${i + 1}. ${j.target || DEFAULT_BRANCH} (by ${j.userId})`);
      });
    }
    sendCard(chatId, 'CI Status', lines.join('\n'), 'blue');
    return;
  }

  if (cmd === '/history' || cmd === 'history') {
    const histFile = path.join(REPORT_DIR, 'history.log');
    let content = '暂无历史记录';
    try {
      const lines = fs.readFileSync(histFile, 'utf8').trim().split('\n');
      content = lines.slice(-5).reverse().map(l => {
        const [ts, status, sha, msg] = l.split(' | ');
        const emoji = status?.trim() === 'PASS' ? '✅' : '❌';
        return `${emoji} \`${sha?.trim()}\` ${msg?.trim()} (${ts?.trim()})`;
      }).join('\n');
    } catch {}
    sendCard(chatId, '📊 最近测试记录', content, 'blue');
    return;
  }

  if (cmd === '/help' || cmd === 'help') {
    sendCard(chatId, 'EdgeClaw CI Bot', [
      '**可用命令**:',
      '`/test` — 测试 release 分支最新代码',
      '`/test <sha>` — 测试指定 commit',
      '`/test <branch>` — 测试指定分支',
      '`/status` — 查看当前队列状态',
      '`/history` — 最近 5 次测试结果',
      '`/help` — 显示此帮助',
    ].join('\n'), 'blue');
    return;
  }

  // Unknown command — ignore non-command messages
}

// ── Feishu WebSocket connection ──
async function startBot() {
  log('BOT', 'Starting EdgeClaw CI Feishu Bot...');
  log('BOT', `App ID: ${APP_ID.slice(0, 8)}...`);
  log('BOT', `Default branch: ${DEFAULT_BRANCH}`);
  log('BOT', `Report dir: ${REPORT_DIR}`);

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': (data) => {
      setImmediate(() => {
        try {
          const raw = data;
          const msg = raw.message || raw.event?.message;
          const sender = raw.sender || raw.event?.sender;
          if (!msg) return;

          const chatId = String(msg.chat_id || '');
          const msgType = String(msg.message_type || msg.msg_type || 'text');
          const userId = String(
            sender?.sender_id?.open_id ||
            sender?.sender_id?.user_id ||
            ''
          );

          if (msgType !== 'text') return;

          let text = '';
          try {
            const c = JSON.parse(String(msg.content || '{}'));
            text = c.text || '';
          } catch {
            text = String(msg.content || '');
          }

          text = text.trim();
          if (!text) return;

          log('MSG', `from=${userId.slice(0, 12)} chat=${chatId.slice(0, 12)} text="${text.slice(0, 80)}"`);
          handleCommand(text, chatId, userId);
        } catch (e) {
          log('ERR', `Message handler: ${e.message}`);
        }
      });
    },
  });

  const wsClient = new Lark.WSClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    loggerLevel: Lark.LoggerLevel?.info ?? 2,
    domain: Lark.Domain?.Feishu || FEISHU_DOMAIN,
  });

  await wsClient.start({ eventDispatcher });
  log('BOT', '✅ Connected to Feishu via WebSocket');
  log('BOT', 'Waiting for commands...');

  // Keep alive
  setInterval(() => {}, 60_000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('BOT', 'Shutting down...');
    wsClient.stop?.();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    log('BOT', 'Shutting down...');
    wsClient.stop?.();
    process.exit(0);
  });
}

startBot().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
