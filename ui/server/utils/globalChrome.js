import { join } from 'path';
import { homedir } from 'os';
import { createConnection } from 'net';
import { spawn, execSync } from 'child_process';
import fs from 'fs';

const CDP_PORT = 9222;
const CDP_HOST = '127.0.0.1';

let chromeProcess = null;

function getUserDataDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(configDir, 'browser-use-profile');
}

function findChromePath() {
  const platform = process.platform;
  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function isCDPPortOpen() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: CDP_HOST, port: CDP_PORT });
    socket.setTimeout(1500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function isCDPHealthy() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function cleanSingletonLocks(dir) {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = join(dir, name);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* ignore */ }
  }
}

function launchChrome(executablePath, userDataDir) {
  cleanSingletonLocks(userDataDir);
  const proc = spawn(executablePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ProfilePicker',
  ], {
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();
  proc.on('exit', () => {
    if (chromeProcess === proc) chromeProcess = null;
  });
  return proc;
}

async function waitForCDP(maxMs = 10_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await isCDPHealthy()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const CHROME_STOP_TIMEOUT_MS = 2500;
const CHROME_STOP_POLL_MS = 100;

async function killCDPPort() {
  let pidList = [];
  try {
    const raw = execSync(`lsof -ti :${CDP_PORT} 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (raw) pidList = raw.split('\n').map(Number).filter(Boolean);
  } catch { /* ignore */ }

  if (pidList.length === 0) {
    chromeProcess = null;
    return;
  }

  for (const pid of pidList) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }

  const deadline = Date.now() + CHROME_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isCDPHealthy())) {
      chromeProcess = null;
      return;
    }
    await new Promise((r) => setTimeout(r, CHROME_STOP_POLL_MS));
  }

  for (const pid of pidList) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 300));
  chromeProcess = null;
}

export async function ensureGlobalChrome() {
  if (await isCDPHealthy()) {
    return `http://${CDP_HOST}:${CDP_PORT}`;
  }

  if (await isCDPPortOpen()) {
    await killCDPPort();
  }

  const executablePath = findChromePath();
  if (!executablePath) return null;

  const userDataDir = getUserDataDir();
  fs.mkdirSync(userDataDir, { recursive: true });

  chromeProcess = launchChrome(executablePath, userDataDir);

  if (await waitForCDP()) {
    return `http://${CDP_HOST}:${CDP_PORT}`;
  }
  return null;
}

export async function restartGlobalChrome() {
  await killCDPPort();

  const executablePath = findChromePath();
  if (!executablePath) return null;

  const userDataDir = getUserDataDir();
  fs.mkdirSync(userDataDir, { recursive: true });

  chromeProcess = launchChrome(executablePath, userDataDir);

  if (await waitForCDP()) {
    return `http://${CDP_HOST}:${CDP_PORT}`;
  }
  return null;
}

let healthCheckTimer = null;

export function startChromeHealthCheck(intervalMs = 30_000) {
  stopChromeHealthCheck();
  healthCheckTimer = setInterval(async () => {
    if (!(await isCDPHealthy())) {
      console.warn('[BROWSER] Chrome CDP unhealthy, restarting...');
      const url = await restartGlobalChrome();
      if (url) {
        process.env.CDP_URL = url;
        console.log(`[BROWSER] Chrome restarted at ${url}`);
      } else {
        console.error('[BROWSER] Chrome restart failed');
      }
    }
  }, intervalMs);
  healthCheckTimer.unref();
}

export function stopChromeHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

export function shutdownGlobalChrome() {
  stopChromeHealthCheck();
  if (chromeProcess) {
    try { chromeProcess.kill('SIGTERM'); } catch { /* ignore */ }
    chromeProcess = null;
  }
}

let _cdpInitPromise = null;

/**
 * Lazy CDP initializer — starts Chrome only on first call, then caches the URL.
 * Subsequent calls return immediately if Chrome is already healthy.
 * Serializes concurrent callers so Chrome is launched at most once.
 */
export async function ensureCDPUrl() {
  if (process.env.CDP_URL && await isCDPHealthy()) {
    return process.env.CDP_URL;
  }

  if (_cdpInitPromise) return _cdpInitPromise;

  _cdpInitPromise = (async () => {
    try {
      const cdpUrl = await ensureGlobalChrome();
      if (cdpUrl) {
        process.env.CDP_URL = cdpUrl;
        startChromeHealthCheck(30_000);
        console.log(`[BROWSER] Global Chrome ready (lazy) at ${cdpUrl}`);
        return cdpUrl;
      }
      return null;
    } finally {
      _cdpInitPromise = null;
    }
  })();

  return _cdpInitPromise;
}
