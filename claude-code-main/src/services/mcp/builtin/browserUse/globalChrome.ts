import { join } from 'path'
import { homedir } from 'os'
import { createConnection } from 'net'
import type { ChildProcess } from 'child_process'

const CDP_PORT = 9222
const CDP_HOST = '127.0.0.1'
const CDP_HEALTH_TIMEOUT_MS = 15_000
const LOCK_FILE_NAME = 'chrome-cdp.lock'

let chromeProcess: ChildProcess | null = null

function _ts(): string {
  return new Date().toISOString()
}

function _caller(): string {
  const stack = new Error().stack
  const frames = stack?.split('\n').slice(2, 4).map(l => l.trim()).join(' <- ') ?? ''
  return frames
}

function getLockFilePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(configDir, 'browser-use-profile', LOCK_FILE_NAME)
}

function isExternalManagerActive(): boolean {
  const fs = require('fs') as typeof import('fs')
  const lockPath = getLockFilePath()
  try {
    if (!fs.existsSync(lockPath)) return false
    const content = fs.readFileSync(lockPath, 'utf8').trim()
    const { pid, ts } = JSON.parse(content)
    // Stale lock: older than 120s
    if (Date.now() - ts > 120_000) {
      fs.unlinkSync(lockPath)
      return false
    }
    // Check if the owning process is still alive
    try {
      process.kill(pid, 0)
      return true
    } catch {
      fs.unlinkSync(lockPath)
      return false
    }
  } catch {
    return false
  }
}

function acquireLock(): boolean {
  const fs = require('fs') as typeof import('fs')
  const lockPath = getLockFilePath()
  if (isExternalManagerActive()) return false
  try {
    fs.mkdirSync(join(lockPath, '..'), { recursive: true })
    fs.writeFileSync(lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
      { flag: 'wx' })
    return true
  } catch {
    // File already exists — check if stale lock was cleaned by isExternalManagerActive
    if (isExternalManagerActive()) return false
    // Stale lock was removed, retry once with exclusive create
    try {
      fs.writeFileSync(lockPath,
        JSON.stringify({ pid: process.pid, ts: Date.now() }),
        { flag: 'wx' })
      return true
    } catch { return false }
  }
}

function releaseLock(): void {
  const fs = require('fs') as typeof import('fs')
  const lockPath = getLockFilePath()
  try {
    if (!fs.existsSync(lockPath)) return
    const content = fs.readFileSync(lockPath, 'utf8').trim()
    const { pid } = JSON.parse(content)
    if (pid === process.pid) {
      fs.unlinkSync(lockPath)
    }
  } catch { /* ignore */ }
}

function refreshLock(): void {
  const fs = require('fs') as typeof import('fs')
  const lockPath = getLockFilePath()
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }))
  } catch { /* ignore */ }
}

function getUserDataDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(configDir, 'browser-use-profile')
}

function findChromePath(): string | undefined {
  const fs = require('fs') as typeof import('fs')
  const platform = process.platform
  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']

  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return undefined
}

async function isCDPPortOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: CDP_HOST, port: CDP_PORT })
    socket.setTimeout(1500)
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/**
 * HTTP-level health check: GET /json/version must return 200 within timeout.
 * TCP port being open is necessary but not sufficient — Chrome can have the
 * port open but refuse new WebSocket connections when saturated.
 */
export async function isCDPHealthy(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CDP_HEALTH_TIMEOUT_MS)
    const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

function cleanSingletonLocks(dir: string) {
  const fs = require('fs') as typeof import('fs')
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = join(dir, name)
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch { /* ignore */ }
  }
}

function launchChrome(executablePath: string, userDataDir: string): ChildProcess {
  const { spawnSync, spawn } = require('child_process') as typeof import('child_process')

  cleanSingletonLocks(userDataDir)

  const proc = spawn(executablePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ProfilePicker',
  ], {
    stdio: 'ignore',
    detached: true,
  })
  proc.unref()
  proc.on('exit', () => {
    if (chromeProcess === proc) chromeProcess = null
  })
  return proc
}

async function waitForCDP(maxMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await isCDPHealthy()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

const CHROME_STOP_TIMEOUT_MS = 2500
const CHROME_STOP_POLL_MS = 100

/**
 * Gracefully stop whatever is on CDP_PORT.
 * Mirrors OpenClaw's stopOpenClawChrome: SIGTERM first, poll until
 * the port is free, then SIGKILL only as a last resort.
 * Respects the lock file — skips kill if another manager owns the lock.
 */
async function killCDPPort(): Promise<void> {
  if (isExternalManagerActive()) {
    console.warn(`[BROWSER ${_ts()}] killCDPPort: skipped — external manager holds lock`)
    return
  }

  const caller = _caller()
  let pidList: number[] = []
  try {
    const { execSync } = require('child_process') as typeof import('child_process')
    const raw = execSync(`lsof -ti :${CDP_PORT} 2>/dev/null`, { encoding: 'utf8' }).trim()
    if (raw) pidList = raw.split('\n').map(Number).filter(Boolean)
  } catch { /* ignore */ }

  if (pidList.length === 0) {
    chromeProcess = null
    return
  }

  console.warn(`[BROWSER ${_ts()}] killCDPPort: sending SIGTERM to pids=${JSON.stringify(pidList)} | caller: ${caller}`)

  for (const pid of pidList) {
    try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
  }

  const deadline = Date.now() + CHROME_STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!(await isCDPHealthy())) {
      chromeProcess = null
      return
    }
    await new Promise((r) => setTimeout(r, CHROME_STOP_POLL_MS))
  }

  console.warn(`[BROWSER ${_ts()}] killCDPPort: SIGTERM timeout, sending SIGKILL to pids=${JSON.stringify(pidList)}`)
  for (const pid of pidList) {
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 300))
  chromeProcess = null
}

/**
 * Ensures a global Chrome instance is running with remote debugging enabled.
 * Returns the CDP HTTP URL if successful, or null on failure.
 *
 * If the existing Chrome is unresponsive (port open but /json/version fails),
 * it is killed and relaunched — unless an external manager holds the lock.
 */
export async function ensureGlobalChrome(): Promise<string | null> {
  if (await isCDPHealthy()) {
    return `http://${CDP_HOST}:${CDP_PORT}`
  }

  // If another manager (e.g. UI server) owns Chrome, just wait for it
  if (isExternalManagerActive()) {
    console.log(`[BROWSER ${_ts()}] ensureGlobalChrome: external manager active, waiting for CDP...`)
    if (await waitForCDP(15_000)) {
      return `http://${CDP_HOST}:${CDP_PORT}`
    }
    console.warn(`[BROWSER ${_ts()}] ensureGlobalChrome: external manager active but CDP never became healthy`)
    return null
  }

  // Port open but unhealthy → kill stale Chrome
  if (await isCDPPortOpen()) {
    console.warn(`[BROWSER ${_ts()}] ensureGlobalChrome: port open but unhealthy, killing stale Chrome`)
    await killCDPPort()
  }

  if (!acquireLock()) {
    console.warn(`[BROWSER ${_ts()}] ensureGlobalChrome: failed to acquire lock, another manager took over`)
    if (await waitForCDP(15_000)) {
      return `http://${CDP_HOST}:${CDP_PORT}`
    }
    return null
  }

  const executablePath = findChromePath()
  if (!executablePath) {
    releaseLock()
    return null
  }

  const userDataDir = getUserDataDir()
  const fs = await import('fs')
  fs.mkdirSync(userDataDir, { recursive: true })

  chromeProcess = launchChrome(executablePath, userDataDir)
  console.log(`[BROWSER ${_ts()}] ensureGlobalChrome: launched Chrome pid=${chromeProcess.pid}`)
  refreshLock()

  if (await waitForCDP()) {
    return `http://${CDP_HOST}:${CDP_PORT}`
  }

  releaseLock()
  return null
}

/**
 * Force-restart Chrome. Use when connectOverCDP fails despite port being open.
 * Respects lock — if another manager owns Chrome, waits instead of killing.
 */
export async function restartGlobalChrome(): Promise<string | null> {
  console.warn(`[BROWSER ${_ts()}] restartGlobalChrome called | caller: ${_caller()}`)

  if (isExternalManagerActive()) {
    console.warn(`[BROWSER ${_ts()}] restartGlobalChrome: external manager active, waiting instead of killing`)
    if (await waitForCDP(15_000)) {
      return `http://${CDP_HOST}:${CDP_PORT}`
    }
    return null
  }

  await killCDPPort()

  if (!acquireLock()) {
    if (await waitForCDP(15_000)) {
      return `http://${CDP_HOST}:${CDP_PORT}`
    }
    return null
  }

  const executablePath = findChromePath()
  if (!executablePath) {
    releaseLock()
    return null
  }

  const userDataDir = getUserDataDir()
  const fs = await import('fs')
  fs.mkdirSync(userDataDir, { recursive: true })

  chromeProcess = launchChrome(executablePath, userDataDir)
  console.log(`[BROWSER ${_ts()}] restartGlobalChrome: launched Chrome pid=${chromeProcess.pid}`)
  refreshLock()

  if (await waitForCDP()) {
    return `http://${CDP_HOST}:${CDP_PORT}`
  }
  releaseLock()
  return null
}

export function getGlobalCDPUrl(): string {
  return `http://${CDP_HOST}:${CDP_PORT}`
}

export function shutdownGlobalChrome(): void {
  console.warn(`[BROWSER ${_ts()}] shutdownGlobalChrome called | caller: ${_caller()}`)
  if (chromeProcess) {
    console.warn(`[BROWSER ${_ts()}] shutdownGlobalChrome: sending SIGTERM to pid=${chromeProcess.pid}`)
    try { chromeProcess.kill('SIGTERM') } catch { /* ignore */ }
    chromeProcess = null
  }
  releaseLock()
}
