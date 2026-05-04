#!/usr/bin/env node
/**
 * XHS E2E Test Runner
 *
 * Two modes:
 *   smoke  — 分步 agent 调用 (any model, 默认)
 *   full   — 单条消息 → CCR autoOrchestrate → 主 agent 编排子任务
 *
 * Usage:
 *   node run-test.mjs           # auto-detect: probe Sonnet → full, else smoke
 *   node run-test.mjs smoke     # force smoke
 *   node run-test.mjs full      # force full (requires CCR config)
 */
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import https from 'https';
import http from 'http';


const REPO_ROOT = process.env.EDGECLAW_ROOT
  || path.resolve(new URL('.', import.meta.url).pathname, '../../..');
const uiRequire = createRequire(
  path.join(REPO_ROOT, 'ui', 'node_modules', '_placeholder.js')
);
const { WebSocket } = uiRequire('ws');
const jsYaml = uiRequire('js-yaml');

const UI_PORT = process.env.EDGECLAW_UI_PORT || '3001';
const WS_URL = process.env.EDGECLAW_WS_URL || `ws://127.0.0.1:${UI_PORT}/ws`;
const PROJECT_PATH = REPO_ROOT;
const CONFIG_PATH = process.env.EDGECLAW_CONFIG
  || path.join(process.env.HOME, '.edgeclaw', 'config.yaml');
const ENV_PATH = process.env.EDGECLAW_ENV_PATH
  || path.join(REPO_ROOT, 'claude-code-main', '.env');
const TIMEOUT_MS = 300_000;
const FULL_TIMEOUT_MS = 600_000;

const results = { steps: [], startTime: Date.now(), mode: 'smoke' };

function log(tag, msg) {
  const ts = ((Date.now() - results.startTime) / 1000).toFixed(1);
  console.log(`[${ts}s][${tag}] ${msg}`);
}

// ─── Probe helpers ───

function getOpenRouterKey() {
  try {
    const env = fs.readFileSync(ENV_PATH, 'utf8');
    const m = env.match(/^OPENAI_API_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function probeSonnet(key) {
  return new Promise((resolve) => {
    const data = JSON.stringify({
      model: 'anthropic/claude-sonnet-4',
      messages: [{ role: 'user', content: 'say ok' }],
      max_tokens: 5,
    });
    const req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions',
      method: 'POST', timeout: 20000,
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          resolve(!!d.choices);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

// ─── Config helpers ───

function readConfig() {
  return jsYaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, jsYaml.dump(cfg, { lineWidth: 120 }));
}

function enableCCR(cfg) {
  const snap = {
    routerEnabled: cfg.router.enabled,
    tokenSaverEnabled: cfg.router.tokenSaver.enabled,
    autoOrchestrateEnabled: cfg.router.autoOrchestrate.enabled,
    mainAgentModel: cfg.router.autoOrchestrate.mainAgentModel,
    triggerTiers: [...cfg.router.autoOrchestrate.triggerTiers],
  };

  cfg.router.enabled = true;
  cfg.router.tokenSaver.enabled = true;
  cfg.router.tokenSaver.defaultTier = 'COMPLEX';
  cfg.router.autoOrchestrate.enabled = true;
  cfg.router.autoOrchestrate.triggerTiers = ['COMPLEX', 'REASONING'];
  cfg.router.autoOrchestrate.mainAgentModel = 'default';

  writeConfig(cfg);
  return snap;
}

function restoreConfig(cfg, snap) {
  cfg.router.enabled = snap.routerEnabled;
  cfg.router.tokenSaver.enabled = snap.tokenSaverEnabled;
  cfg.router.autoOrchestrate.enabled = snap.autoOrchestrateEnabled;
  cfg.router.autoOrchestrate.mainAgentModel = snap.mainAgentModel;
  cfg.router.autoOrchestrate.triggerTiers = snap.triggerTiers;
  writeConfig(cfg);
}

// ─── WebSocket ───

function connectWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 10000);
  });
}

function sendAndCollect(ws, command, opts = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let toolUses = [];
    let realSessionId = null;
    let timeoutId;

    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.sessionId && !realSessionId) {
          realSessionId = msg.sessionId;
          log('SESSION', `assigned: ${realSessionId.slice(0,8)}...`);
        }
        const isOurs = !realSessionId || msg.sessionId === realSessionId;
        if (!isOurs) return;

        if (msg.kind === 'stream_delta' && msg.content) chunks.push(msg.content);
        if (msg.kind === 'tool_use') {
          const name = msg.toolName || msg.name || 'unknown';
          toolUses.push(name);
          log('TOOL', name);
        }
        if (msg.kind === 'complete') {
          clearTimeout(timeoutId);
          ws.removeListener('message', handler);
          resolve({ sessionId: realSessionId, text: chunks.join(''), toolUses, exitCode: msg.exitCode });
        }
        if (msg.kind === 'error' || msg.type === 'error') {
          log('ERROR', msg.error || msg.message || JSON.stringify(msg).slice(0, 200));
        }
      } catch (e) { /* ignore */ }
    };

    ws.on('message', handler);

    const payload = {
      type: 'claude-command',
      command,
      options: {
        projectPath: PROJECT_PATH,
        cwd: opts.cwd || PROJECT_PATH,
        permissionMode: 'bypassPermissions',
      },
    };
    if (opts.model) payload.options.model = opts.model;
    ws.send(JSON.stringify(payload));
    log('SEND', `cmd="${command.slice(0,80)}..."`);

    timeoutId = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve({ sessionId: realSessionId, text: chunks.join(''), toolUses, exitCode: -1, timeout: true });
    }, opts.timeout || TIMEOUT_MS);
  });
}

function verifyFile(filepath, label) {
  try {
    const stat = fs.statSync(filepath);
    log('VERIFY', `✅ ${label}: ${filepath} (${stat.size} bytes)`);
    return true;
  } catch {
    log('VERIFY', `❌ ${label}: ${filepath} not found`);
    return false;
  }
}

// ─── Smoke mode (step-by-step) ───

async function runSmoke(ws) {
  results.mode = 'smoke';

  // Step A
  log('STEP-A', '素材抓取 (WebSearch)...');
  const stepA = await sendAndCollect(ws, [
    '执行以下任务：',
    '1. 用 Bash 执行: mkdir -p /tmp/work/assets',
    '2. 用 WebSearch 搜索 "Claude AI 2026 latest features capabilities"，取前 3 条结果的关键信息',
    '3. 将搜索到的信息整理写入 /tmp/work/tweets.md 文件（格式：## 信息 N / 内容: ... / 来源: ...）',
    '4. 可选: 用 Bash 截图 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=/tmp/work/assets/source.png --window-size=1000,800 --disable-gpu "https://www.anthropic.com"',
    '',
    '最后必须用 Bash 执行: ls -la /tmp/work/tweets.md /tmp/work/assets/',
  ].join('\n'));
  const aOK = verifyFile('/tmp/work/tweets.md', 'Step A: tweets.md');
  results.steps.push({ name: 'A: 素材抓取', pass: aOK, tools: stepA.toolUses.length, timeout: !!stepA.timeout });

  // Step B
  log('STEP-B', '头图生成 (xhs-header-cc skill)...');
  const stepB = await sendAndCollect(ws, [
    `先用 Read 读取 ${PROJECT_PATH}/.claude/skills/xhs-header-cc/SKILL.md，按其中的流程执行。`,
    '', '输入素材在 /tmp/work/tweets.md 和 /tmp/work/assets/。',
    '话题: AI 技术动态', '风格偏好: 黑底大字 + 散落标签（Recipe 1）',
    '', '输出: /tmp/work/output.png（1242x1660）',
    '', '完成后执行: ls -la /tmp/work/output.png',
  ].join('\n'));
  const bOK = verifyFile('/tmp/work/output.png', 'Step B: output.png');
  results.steps.push({ name: 'B: 头图生成', pass: bOK, tools: stepB.toolUses.length, timeout: !!stepB.timeout });

  // Step C
  log('STEP-C', '文案撰写...');
  const hasTweets = fs.existsSync('/tmp/work/tweets.md');
  const stepC = await sendAndCollect(ws, [
    hasTweets
      ? '先用 Read 读取 /tmp/work/tweets.md 的内容作为素材。然后基于这些素材，为小红书撰写图文笔记。'
      : '以"2026年 AI 技术最新动态"为主题，为小红书撰写一篇图文笔记。',
    '', '要求：',
    '标题（2 个备选，每个 ≤20 字）:', '- A: 争议/好奇型', '- B: 干货/信息型',
    '', '正文（200-500 字）:',
    '- 开头钩子', '- 亮点列表（3-5 条，emoji 编号）', '- 观点总结', '- 互动提问', '- 末尾 5-8 个 #话题标签',
    '', '用 Write 工具将完整结果写入 /tmp/work/copy.md。',
    '写完后用 Bash 执行: ls -la /tmp/work/copy.md && head -5 /tmp/work/copy.md',
  ].join('\n'));
  const cOK = verifyFile('/tmp/work/copy.md', 'Step C: copy.md');
  results.steps.push({ name: 'C: 文案撰写', pass: cOK, tools: stepC.toolUses.length, timeout: !!stepC.timeout });
}

// ─── Full mode (single message → CCR autoOrchestrate) ───

async function runFull(ws) {
  results.mode = 'full';

  const cfg = readConfig();
  const snap = enableCCR(cfg);
  log('CCR', 'Enabled CCR + tokenSaver + autoOrchestrate (will restore after test)');

  // Give config watcher time to pick up changes
  await new Promise(r => setTimeout(r, 3000));

  try {
    log('FULL', '发送单条 XHS 全链路编排任务...');
    const fullResult = await sendAndCollect(ws, [
      '帮我做一个关于"2026年AI技术最新进展"的小红书图文笔记。',
      '',
      '请按照以下流程执行：',
      '1. 用 WebSearch 搜索最新 AI 资讯，整理素材写入 /tmp/work/tweets.md',
      `2. 读取 ${PROJECT_PATH}/.claude/skills/xhs-header-cc/SKILL.md，按流程生成头图 /tmp/work/output.png (1242x1660)`,
      '3. 撰写小红书文案（标题≤20字 + 正文200-500字 + 话题标签），写入 /tmp/work/copy.md',
      '',
      '每步完成后验证文件存在。全部完成后输出汇总。',
    ].join('\n'), { timeout: FULL_TIMEOUT_MS });

    // Verify outputs
    const aOK = verifyFile('/tmp/work/tweets.md', 'Full-A: tweets.md');
    const bOK = verifyFile('/tmp/work/output.png', 'Full-B: output.png');
    const cOK = verifyFile('/tmp/work/copy.md', 'Full-C: copy.md');

    const hasAgent = fullResult.toolUses.includes('Agent');
    const hasSubagent = fullResult.toolUses.filter(t => t === 'Agent').length;

    results.steps.push({ name: 'Full: 素材抓取', pass: aOK, tools: '-', timeout: !!fullResult.timeout });
    results.steps.push({ name: 'Full: 头图生成', pass: bOK, tools: '-', timeout: !!fullResult.timeout });
    results.steps.push({ name: 'Full: 文案撰写', pass: cOK, tools: '-', timeout: !!fullResult.timeout });
    results.steps.push({
      name: 'Full: CCR 编排',
      pass: hasAgent,
      tools: fullResult.toolUses.length,
      timeout: !!fullResult.timeout,
      extra: `Agent() calls: ${hasSubagent}, total tools: ${fullResult.toolUses.length}`,
    });

    log('FULL', `Total tools: ${fullResult.toolUses.length}, Agent() spawns: ${hasSubagent}`);
    log('FULL', `Tools used: ${[...new Set(fullResult.toolUses)].join(', ')}`);

  } finally {
    const cfgNow = readConfig();
    restoreConfig(cfgNow, snap);
    log('CCR', 'Config restored to original values');
  }
}

// ─── Report ───

function printReport() {
  const elapsed = ((Date.now() - results.startTime) / 1000).toFixed(0);
  console.log('\n');
  console.log('═══════════════════════════════════════');
  console.log(`  XHS E2E 测试报告 (${results.mode} mode)`);
  console.log('═══════════════════════════════════════');
  console.log('');
  let pass = 0, total = results.steps.length;
  for (const s of results.steps) {
    const icon = s.pass ? '✅' : (s.timeout ? '⏱️' : '❌');
    const extra = s.extra ? `  [${s.extra}]` : '';
    console.log(`  ${icon} ${s.name}  (tools: ${s.tools}${s.timeout ? ', TIMEOUT' : ''})${extra}`);
    if (s.pass) pass++;
  }
  console.log('');
  console.log(`  通过: ${pass}/${total}   耗时: ${elapsed}s   模式: ${results.mode}`);
  console.log('═══════════════════════════════════════');
  return pass === total ? 0 : 1;
}

// ─── Main ───

async function main() {
  let requestedMode = process.argv[2] || 'auto';

  // Auto-detect mode
  if (requestedMode === 'auto') {
    log('PROBE', 'Auto-detecting mode...');
    const key = getOpenRouterKey();
    if (key) {
      log('PROBE', `OpenRouter key: ${key.slice(0,12)}...`);
      const ok = await probeSonnet(key);
      if (ok) {
        log('PROBE', '✅ Sonnet reachable → full mode');
        requestedMode = 'full';
      } else {
        log('PROBE', '⚠️ Sonnet unreachable → smoke mode');
        requestedMode = 'smoke';
      }
    } else {
      log('PROBE', '⚠️ No OpenRouter key → smoke mode');
      requestedMode = 'smoke';
    }
  }

  log('INIT', `Mode: ${requestedMode}`);
  log('INIT', `Connecting to ${WS_URL}...`);

  // Check server health
  try {
    const res = await fetch(`http://127.0.0.1:${UI_PORT}/health`);
    if (!res.ok) throw new Error(`health ${res.status}`);
    log('INIT', '✅ UI server healthy');
  } catch (e) {
    log('ERROR', `UI server not healthy: ${e.message}. Start it: cd ui && npm run dev`);
    process.exit(1);
  }

  let ws;
  try {
    ws = await connectWS();
  } catch (e) {
    log('ERROR', `Cannot connect WS: ${e.message}`);
    process.exit(1);
  }
  log('INIT', '✅ WebSocket connected');

  // Clean workspace
  fs.rmSync('/tmp/work', { recursive: true, force: true });
  fs.mkdirSync('/tmp/work/assets', { recursive: true });
  log('INIT', 'Workspace /tmp/work cleaned');

  if (requestedMode === 'full') {
    await runFull(ws);
  } else {
    await runSmoke(ws);
  }

  const exitCode = printReport();
  ws.close();
  process.exit(exitCode);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
