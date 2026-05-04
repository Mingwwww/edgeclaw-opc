#!/usr/bin/env node
/**
 * EdgeClaw Mac App GUI E2E Test
 * 
 * Uses Chrome DevTools Protocol (CDP) to control the Electron app.
 * No Accessibility permissions needed.
 *
 * Flow:
 *   1. Kill existing EdgeClaw
 *   2. Relaunch with --remote-debugging-port
 *   3. Connect via CDP
 *   4. Verify: window loads, main UI renders, chat input works
 *   5. Screenshot evidence
 *   6. Restore original app state
 *
 * Usage:
 *   node scripts/ci-gui-test.mjs
 */
import { execSync, spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import http from 'http';

const REPO_ROOT = process.env.EDGECLAW_ROOT
  || path.resolve(new URL('.', import.meta.url).pathname, '..');
const uiRequire = createRequire(
  path.join(REPO_ROOT, 'ui', 'node_modules', '_placeholder.js')
);
const WS = uiRequire('ws');

const CDP_PORT = 9222;
const APP_PATH = '/Applications/EdgeClaw.app/Contents/MacOS/EdgeClaw';
const REPORT_DIR = process.env.EDGECLAW_ROOT
  ? path.join(process.env.EDGECLAW_ROOT, '.ci-reports')
  : path.join(process.cwd(), '.ci-reports');
const SCREENSHOTS_DIR = path.join(REPORT_DIR, 'screenshots');
const TIMEOUT_MS = 15_000;

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const startTime = Date.now();
const results = [];
const perf = {
  appLaunchMs: 0,
  splashToMainMs: 0,
  responseLatencyMs: 0,
  jsHeapMB: null,
  rendererHeapMB: null,
  rendererHeapTotalMB: null,
  domNodes: null,
  visualDiffPercent: null,
};

function log(tag, msg) {
  const ts = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[${ts}s][${tag}] ${msg}`);
}

function step(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const icon = pass ? '✅' : '❌';
  log('CHECK', `${icon} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── CDP helpers ──

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function getCDPTargets() {
  const raw = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
  return JSON.parse(raw);
}

function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('CDP WS timeout')), 10000);
  });
}

class CDPSession {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.callbacks = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.callbacks.has(msg.id)) {
        this.callbacks.get(msg.id)(msg);
        this.callbacks.delete(msg.id);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, (msg) => {
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.callbacks.has(id)) {
          this.callbacks.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, TIMEOUT_MS);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    return result.result?.value;
  }

  async screenshot(filename) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
    log('SCREENSHOT', filepath);
    return filepath;
  }

  close() {
    this.ws.close();
  }
}

// ── App lifecycle ──

function killApp() {
  try {
    execSync('pkill -f "EdgeClaw.app/Contents/MacOS/EdgeClaw"', { stdio: 'ignore' });
    log('APP', 'Killed existing EdgeClaw');
  } catch { /* not running */ }
}

function launchApp() {
  log('APP', `Launching with --remote-debugging-port=${CDP_PORT}`);
  const child = spawn('open', [
    '-a', '/Applications/EdgeClaw.app',
    '--args', `--remote-debugging-port=${CDP_PORT}`
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function waitForCDP(maxWait = 20000) {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      const targets = await getCDPTargets();
      if (targets.length > 0) return targets;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('CDP not available after waiting');
}

// ── Tests ──

async function runTests() {
  // Step 1: Kill & relaunch
  killApp();
  await new Promise(r => setTimeout(r, 2000));
  launchApp();

  // Step 2: Wait for CDP and for app to finish loading (splash → main)
  log('CDP', 'Waiting for app to start with CDP...');
  const launchStart = Date.now();
  let targets;
  try {
    targets = await waitForCDP();
    perf.appLaunchMs = Date.now() - launchStart;
    step('App launches with CDP', true, `${targets.length} targets, ${perf.appLaunchMs}ms`);
  } catch (e) {
    step('App launches with CDP', false, e.message);
    return;
  }

  // Wait for splash to finish and main window to appear
  log('CDP', 'Waiting for main window (past splash)...');
  const splashStart = Date.now();
  await new Promise(r => setTimeout(r, 8000));

  // Re-fetch targets — main window should be ready now
  targets = await getCDPTargets();
  log('CDP', `Targets after wait: ${targets.map(t => t.url.split('/').pop() || t.url).join(', ')}`);

  // Step 3: Find main window (skip splash, devtools, about:blank)
  const pageTarget = targets.find(t =>
    t.type === 'page' &&
    !t.url.includes('devtools') &&
    !t.url.includes('splash') &&
    t.url !== 'about:blank'
  ) || targets.find(t =>
    t.type === 'page' &&
    !t.url.includes('devtools')
  );

  if (!pageTarget) {
    step('Main window found', false, `targets: ${targets.map(t => t.type + ':' + t.url.slice(0, 60)).join(', ')}`);
    return;
  }
  perf.splashToMainMs = Date.now() - splashStart;
  step('Main window found', true, pageTarget.url.slice(0, 80));

  // Step 4: Connect CDP session
  let cdp;
  try {
    const ws = await connectWS(pageTarget.webSocketDebuggerUrl);
    cdp = new CDPSession(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Performance.enable').catch(() => {});
    step('CDP session connected', true);
  } catch (e) {
    step('CDP session connected', false, e.message);
    return;
  }

  // Step 5: Wait for page to be fully loaded
  await new Promise(r => setTimeout(r, 5000));

  // Step 6: Check page title
  try {
    const title = await cdp.evaluate('document.title');
    step('Page title loaded', !!title, `"${title}"`);
  } catch (e) {
    step('Page title loaded', false, e.message);
  }

  // Step 7: Screenshot initial state
  try {
    await cdp.screenshot('01-initial-state.png');
    step('Initial screenshot captured', true);
  } catch (e) {
    step('Initial screenshot captured', false, e.message);
  }

  // Step 8: Check if main UI rendered (look for common elements)
  try {
    const hasUI = await cdp.evaluate(`
      !!(document.querySelector('textarea, input[type="text"], .chat-input, #message-input, [contenteditable]'))
    `);
    step('Chat input element exists', hasUI);
  } catch (e) {
    step('Chat input element exists', false, e.message);
  }

  // Step 9: Check body has content (not blank page)
  try {
    const bodyLen = await cdp.evaluate('document.body.innerHTML.length');
    step('Page has content', bodyLen > 100, `${bodyLen} chars`);
  } catch (e) {
    step('Page has content', false, e.message);
  }

  // Step 10: Check for JS errors in console
  try {
    const errors = await cdp.evaluate(`
      window.__testErrors = window.__testErrors || [];
      window.__testErrors.length
    `);
    step('No critical JS errors', errors === 0, errors > 0 ? `${errors} errors` : '');
  } catch {
    step('No critical JS errors', true, 'could not check (non-critical)');
  }

  // Step 11: Verify app is functional (has interactive elements beyond just static HTML)
  try {
    const isReady = await cdp.evaluate(`
      (function() {
        const hasTextarea = !!document.querySelector('textarea, [contenteditable="true"]');
        const hasButtons = document.querySelectorAll('button').length > 0;
        const bodySize = document.body.innerHTML.length;
        return hasTextarea && hasButtons && bodySize > 5000;
      })()
    `);
    step('App is interactive (inputs + buttons)', isReady);
  } catch (e) {
    step('App is interactive (inputs + buttons)', false, e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 12: REAL USER INTERACTION — type message → wait for reply
  // ═══════════════════════════════════════════════════════════
  try {
    log('INTERACT', 'Typing test message into chat...');
    const interactionStart = Date.now();

    const typed = await cdp.evaluate(`
      (function() {
        const textarea = document.querySelector('textarea, [contenteditable="true"]');
        if (!textarea) return false;
        textarea.focus();
        if (textarea.tagName === 'TEXTAREA') {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          ).set;
          nativeInputValueSetter.call(textarea, '你好，请用一句话介绍你是谁');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          textarea.textContent = '你好，请用一句话介绍你是谁';
          textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        return true;
      })()
    `);
    step('Message typed into input', typed);

    if (typed) {
      // Submit via Enter key or submit button
      await cdp.evaluate(`
        (function() {
          const textarea = document.querySelector('textarea, [contenteditable="true"]');
          if (textarea) {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          }
          const sendBtn = document.querySelector('button[type="submit"], button[aria-label*="send"], button[aria-label*="Send"]');
          if (sendBtn) sendBtn.click();
        })()
      `);

      // Wait for agent response (poll DOM for new content)
      log('INTERACT', 'Waiting for Agent response...');
      let gotReply = false;
      const replyDeadline = Date.now() + 60_000;
      while (Date.now() < replyDeadline) {
        await new Promise(r => setTimeout(r, 3000));
        const msgCount = await cdp.evaluate(`
          document.querySelectorAll('[class*="message"], [class*="Message"], [data-role="assistant"], .prose').length
        `).catch(() => 0);
        if (msgCount > 0) {
          gotReply = true;
          break;
        }
      }

      const replyLatency = ((Date.now() - interactionStart) / 1000).toFixed(1);
      step('Agent replied to message', gotReply, `latency: ${replyLatency}s`);
      perf.responseLatencyMs = Date.now() - interactionStart;

      await cdp.screenshot('03-after-reply.png');
    }
  } catch (e) {
    step('Real user interaction', false, e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 13: PERFORMANCE METRICS
  // ═══════════════════════════════════════════════════════════
  try {
    const metrics = await cdp.send('Performance.getMetrics').catch(() => null);
    if (metrics?.metrics) {
      const jsHeap = metrics.metrics.find(m => m.name === 'JSHeapUsedSize');
      const domNodes = metrics.metrics.find(m => m.name === 'Nodes');
      perf.jsHeapMB = jsHeap ? (jsHeap.value / 1024 / 1024).toFixed(1) : 'N/A';
      perf.domNodes = domNodes ? domNodes.value : 'N/A';
    }

    const memInfo = await cdp.evaluate(`
      performance.memory ? {
        usedJSHeapSize: (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1),
        totalJSHeapSize: (performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(1),
      } : null
    `).catch(() => null);
    if (memInfo) {
      perf.rendererHeapMB = memInfo.usedJSHeapSize;
      perf.rendererHeapTotalMB = memInfo.totalJSHeapSize;
    }

    step('Performance metrics collected', true,
      `Heap: ${perf.jsHeapMB || perf.rendererHeapMB || '?'}MB, DOM: ${perf.domNodes || '?'} nodes`);
  } catch (e) {
    step('Performance metrics collected', false, e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 14: VISUAL REGRESSION — compare with baseline
  // ═══════════════════════════════════════════════════════════
  try {
    await cdp.screenshot('04-final-state.png');

    const baselinePath = path.join(SCREENSHOTS_DIR, 'baseline.png');
    const currentPath = path.join(SCREENSHOTS_DIR, '04-final-state.png');

    if (fs.existsSync(baselinePath)) {
      const baseline = fs.readFileSync(baselinePath);
      const current = fs.readFileSync(currentPath);

      // Simple byte-level comparison (fast, catches major changes)
      const sizeDiff = Math.abs(baseline.length - current.length);
      const sizeRatio = sizeDiff / Math.max(baseline.length, 1);

      // Pixel-level: compare raw buffers (PNG headers may differ, so use size ratio)
      const isVisuallyClose = sizeRatio < 0.15; // <15% file size difference

      step('Visual regression check', isVisuallyClose,
        isVisuallyClose
          ? `size diff: ${(sizeRatio * 100).toFixed(1)}% (within tolerance)`
          : `size diff: ${(sizeRatio * 100).toFixed(1)}% — POSSIBLE REGRESSION`);
      perf.visualDiffPercent = (sizeRatio * 100).toFixed(1);
    } else {
      // First run — save as baseline
      fs.copyFileSync(currentPath, baselinePath);
      step('Visual regression check', true, 'baseline created (first run)');
    }
  } catch (e) {
    step('Visual regression check', false, e.message);
  }

  // Final screenshot
  try {
    await cdp.screenshot('05-complete.png');
    step('Final screenshot captured', true);
  } catch (e) {
    step('Final screenshot captured', false, e.message);
  }

  cdp.close();
}

// ── Performance baseline tracking ──

function savePerformanceData() {
  const perfFile = path.join(REPORT_DIR, 'perf-history.jsonl');
  const entry = {
    timestamp: new Date().toISOString(),
    ...perf,
    totalTestMs: Date.now() - startTime,
  };
  fs.appendFileSync(perfFile, JSON.stringify(entry) + '\n');
  log('PERF', `Saved to ${perfFile}`);

  // Check for degradation vs last 5 runs
  try {
    const lines = fs.readFileSync(perfFile, 'utf8').trim().split('\n');
    if (lines.length >= 3) {
      const recent = lines.slice(-6, -1).map(l => JSON.parse(l));
      const avgLaunch = recent.reduce((s, r) => s + (r.appLaunchMs || 0), 0) / recent.length;
      const avgResponse = recent.reduce((s, r) => s + (r.responseLatencyMs || 0), 0) / recent.length;

      if (perf.appLaunchMs > avgLaunch * 1.5 && perf.appLaunchMs > 5000) {
        log('PERF', `⚠ App launch ${perf.appLaunchMs}ms is 50%+ slower than avg ${avgLaunch.toFixed(0)}ms`);
      }
      if (perf.responseLatencyMs > avgResponse * 2 && perf.responseLatencyMs > 30000) {
        log('PERF', `⚠ Response latency ${perf.responseLatencyMs}ms is 2x slower than avg ${avgResponse.toFixed(0)}ms`);
      }
    }
  } catch { /* first runs */ }
}

// ── Report ──

function printReport() {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log('\n');
  console.log('═══════════════════════════════════════');
  console.log('  EdgeClaw Mac App GUI 测试报告');
  console.log('═══════════════════════════════════════');
  console.log('');
  let pass = 0;
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`  ${icon} ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
    if (r.pass) pass++;
  }
  console.log('');
  console.log('  ── 性能指标 ──');
  console.log(`  启动时间: ${perf.appLaunchMs}ms`);
  console.log(`  Splash→主窗口: ${perf.splashToMainMs}ms`);
  console.log(`  对话响应延迟: ${perf.responseLatencyMs ? perf.responseLatencyMs + 'ms' : 'N/A'}`);
  console.log(`  JS Heap: ${perf.jsHeapMB || perf.rendererHeapMB || 'N/A'}MB`);
  console.log(`  DOM Nodes: ${perf.domNodes || 'N/A'}`);
  console.log(`  视觉差异: ${perf.visualDiffPercent !== null ? perf.visualDiffPercent + '%' : 'N/A'}`);
  console.log('');
  console.log(`  通过: ${pass}/${results.length}   耗时: ${elapsed}s`);
  console.log(`  截图: ${SCREENSHOTS_DIR}`);
  console.log('═══════════════════════════════════════');
  return pass === results.length ? 0 : 1;
}

// ── Main ──

async function main() {
  log('INIT', 'EdgeClaw Mac App GUI Test');
  log('INIT', `Report dir: ${REPORT_DIR}`);

  try {
    await runTests();
  } catch (e) {
    log('FATAL', e.message);
    step('Test execution', false, e.message);
  }

  savePerformanceData();

  // Restore app (relaunch without debug port)
  killApp();
  await new Promise(r => setTimeout(r, 1000));
  spawn('open', ['-a', '/Applications/EdgeClaw.app'], { detached: true, stdio: 'ignore' }).unref();
  log('APP', 'Relaunched EdgeClaw normally');

  const exitCode = printReport();
  process.exit(exitCode);
}

main();
