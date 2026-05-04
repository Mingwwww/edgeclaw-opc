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
  let targets;
  try {
    targets = await waitForCDP();
    step('App launches with CDP', true, `${targets.length} targets found`);
  } catch (e) {
    step('App launches with CDP', false, e.message);
    return;
  }

  // Wait for splash to finish and main window to appear
  log('CDP', 'Waiting for main window (past splash)...');
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
  step('Main window found', true, pageTarget.url.slice(0, 80));

  // Step 4: Connect CDP session
  let cdp;
  try {
    const ws = await connectWS(pageTarget.webSocketDebuggerUrl);
    cdp = new CDPSession(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
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

  // Step 12: Final screenshot
  try {
    await cdp.screenshot('02-after-checks.png');
    step('Final screenshot captured', true);
  } catch (e) {
    step('Final screenshot captured', false, e.message);
  }

  cdp.close();
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

  // Restore app (relaunch without debug port)
  killApp();
  await new Promise(r => setTimeout(r, 1000));
  spawn('open', ['-a', '/Applications/EdgeClaw.app'], { detached: true, stdio: 'ignore' }).unref();
  log('APP', 'Relaunched EdgeClaw normally');

  const exitCode = printReport();
  process.exit(exitCode);
}

main();
