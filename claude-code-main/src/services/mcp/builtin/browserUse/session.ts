import type { Browser, BrowserContext, Page } from 'playwright-core'
import { ensureGlobalChrome, restartGlobalChrome, isCDPHealthy } from './globalChrome.js'

const CDP_CONNECT_TIMEOUT = 8_000
const MAX_CDP_RETRIES = 1
const CDP_RETRY_DELAY_MS = 250

// Chrome 147+ broke Playwright's connectOverCDP due to a setDownloadBehavior
// protocol change.  We detect the major version from the running Chrome's
// /json/version endpoint and skip CDP entirely when it is >= 147.
const CDP_INCOMPATIBLE_CHROME_MAJOR = 147
let _cachedChromeMajor: number | null = null

async function getChromeMajorVersion(): Promise<number> {
  if (_cachedChromeMajor !== null) return _cachedChromeMajor
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3_000)
    const res = await fetch('http://127.0.0.1:9222/json/version', {
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return 0
    const data = (await res.json()) as { Browser?: string }
    const match = data.Browser?.match(/Chrome\/(\d+)/)
    const major = match ? parseInt(match[1], 10) : 0
    if (major > 0) _cachedChromeMajor = major
    return major
  } catch {
    return 0
  }
}

async function isCDPIncompatible(): Promise<boolean> {
  const major = await getChromeMajorVersion()
  return major >= CDP_INCOMPATIBLE_CHROME_MAJOR
}

export interface BrowserSession {
  browser: Browser
  context: BrowserContext
}

function normalizeCdpUrl(raw: string): string {
  return raw.replace(/\/$/, '')
}

type CachedConnection = {
  browser: Browser
  context: BrowserContext
  onDisconnected?: () => void
}

const CACHE_KEY_LAUNCHED = '__playwright_launched__'
const cachedByCdpUrl = new Map<string, CachedConnection>()
const connectingByCdpUrl = new Map<string, Promise<BrowserSession>>()

function isConnectionAlive(cached: CachedConnection): boolean {
  if (!cached.browser.isConnected()) return false
  try {
    cached.context.pages()
    return true
  } catch {
    return false
  }
}

// Single-flight guard: prevents concurrent callers from each spawning a Chrome.
let _launchingManaged: Promise<BrowserSession> | null = null

function shouldRunHeadless(): boolean {
  if (process.env.BROWSER_HEADLESS === '1') return true
  if (process.platform === 'linux' && !process.env.DISPLAY) return true
  return false
}

/**
 * Fallback: let Playwright manage Chrome directly (no external CDP).
 * Works around Chrome 147+ breaking connectOverCDP's setDownloadBehavior.
 * Uses single-flight to prevent concurrent launches.
 */
function launchManagedBrowser(): Promise<BrowserSession> {
  // Reuse cached connection if still alive
  const cached = cachedByCdpUrl.get(CACHE_KEY_LAUNCHED)
  if (cached && isConnectionAlive(cached)) {
    return Promise.resolve({ browser: cached.browser, context: cached.context })
  }
  if (_launchingManaged) return _launchingManaged
  _launchingManaged = _doLaunchManagedBrowser()
    .finally(() => { _launchingManaged = null })
  return _launchingManaged
}

async function _doLaunchManagedBrowser(): Promise<BrowserSession> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: shouldRunHeadless(),
    timeout: CDP_CONNECT_TIMEOUT,
  })
  const context = browser.contexts()[0] ?? await browser.newContext()

  const onDisconnected = () => {
    const current = cachedByCdpUrl.get(CACHE_KEY_LAUNCHED)
    if (current?.browser === browser) {
      cachedByCdpUrl.delete(CACHE_KEY_LAUNCHED)
    }
  }
  cachedByCdpUrl.set(CACHE_KEY_LAUNCHED, { browser, context, onDisconnected })
  browser.on('disconnected', onDisconnected)

  return { browser, context }
}

async function connectWithRetry(cdpUrl: string): Promise<BrowserSession> {
  const { chromium } = await import('playwright-core')
  let lastErr: unknown

  for (let attempt = 0; attempt <= MAX_CDP_RETRIES; attempt++) {
    if (attempt > 0 || !(await isCDPHealthy())) {
      const freshUrl = await restartGlobalChrome()
      if (!freshUrl) {
        throw new Error('[browser-use] Chrome restart failed. Check Chrome installation.')
      }
    }

    try {
      const timeout = CDP_CONNECT_TIMEOUT + attempt * 5000
      const browser = await chromium.connectOverCDP(cdpUrl, { timeout })
      const contexts = browser.contexts()
      const context = contexts[0] ?? await browser.newContext()

      const normalized = normalizeCdpUrl(cdpUrl)
      const onDisconnected = () => {
        const current = cachedByCdpUrl.get(normalized)
        if (current?.browser === browser) {
          cachedByCdpUrl.delete(normalized)
        }
      }
      const cached: CachedConnection = { browser, context, onDisconnected }
      cachedByCdpUrl.set(normalized, cached)
      browser.on('disconnected', onDisconnected)

      return { browser, context }
    } catch (err) {
      lastErr = err
      const delay = CDP_RETRY_DELAY_MS + attempt * CDP_RETRY_DELAY_MS
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new Error(`[browser-use] Chrome CDP unavailable after ${MAX_CDP_RETRIES + 1} attempts: ${msg}`)
}

/**
 * Get or create a Playwright browser session.
 *
 * Strategy (in order):
 * 1. Reuse cached connection
 * 2. connectOverCDP to external Chrome (CDP_URL or globalChrome)
 * 3. Fallback: chromium.launch({ channel: 'chrome' }) — Playwright-managed
 */
export async function getOrCreateSession(): Promise<BrowserSession> {
  // Check launched-mode cache first
  const launchedCached = cachedByCdpUrl.get(CACHE_KEY_LAUNCHED)
  if (launchedCached && isConnectionAlive(launchedCached)) {
    return { browser: launchedCached.browser, context: launchedCached.context }
  }

  const rawCdpUrl = process.env.CDP_URL ?? await ensureGlobalChrome()
  if (!rawCdpUrl) {
    return launchManagedBrowser()
  }

  // Chrome 147+ breaks Playwright's connectOverCDP — skip directly to
  // Playwright-managed launch to avoid a multi-retry 60s+ hang.
  if (await isCDPIncompatible()) {
    return launchManagedBrowser()
  }

  const cdpUrl = normalizeCdpUrl(rawCdpUrl)

  const cached = cachedByCdpUrl.get(cdpUrl)
  if (cached && isConnectionAlive(cached)) {
    return { browser: cached.browser, context: cached.context }
  }

  if (cached) {
    cachedByCdpUrl.delete(cdpUrl)
  }

  const inflight = connectingByCdpUrl.get(cdpUrl)
  if (inflight) return inflight

  const pending = connectWithRetry(cdpUrl)
    .catch(() => {
      // connectOverCDP failed — fall back to Playwright-managed Chrome
      return launchManagedBrowser()
    })
    .finally(() => {
      connectingByCdpUrl.delete(cdpUrl)
    })
  connectingByCdpUrl.set(cdpUrl, pending)
  return pending
}

export async function getActivePage(): Promise<Page> {
  const { context } = await getOrCreateSession()
  const pages = context.pages()
  return pages[pages.length - 1] ?? await context.newPage()
}

export async function getPageByTargetId(targetId: string): Promise<Page | null> {
  const { context } = await getOrCreateSession()
  for (const page of context.pages()) {
    const cdpSession = await context.newCDPSession(page)
    try {
      const info = await cdpSession.send('Target.getTargetInfo')
      if (info.targetInfo.targetId === targetId) {
        return page
      }
    } catch {
      // skip
    } finally {
      await cdpSession.detach().catch(() => {})
    }
  }
  return null
}

/**
 * Close the Playwright CDP connection (not the Chrome process).
 * For CDP-connected browsers, uses disconnect() to avoid killing the browser.
 * For Playwright-managed browsers (launched via chromium.launch), uses close().
 */
export async function closeSession(opts?: { cdpUrl?: string }): Promise<void> {
  const normalized = opts?.cdpUrl ? normalizeCdpUrl(opts.cdpUrl) : null

  if (normalized) {
    const cur = cachedByCdpUrl.get(normalized)
    cachedByCdpUrl.delete(normalized)
    connectingByCdpUrl.delete(normalized)
    if (cur) {
      if (cur.onDisconnected && typeof cur.browser.off === 'function') {
        cur.browser.off('disconnected', cur.onDisconnected)
      }
      // CDP connections: disconnect only, don't kill the browser process
      if (normalized !== CACHE_KEY_LAUNCHED) {
        await disconnectSafely(cur.browser)
      } else {
        await cur.browser.close().catch(() => {})
      }
    }
    return
  }

  const connections = Array.from(cachedByCdpUrl.entries())
  cachedByCdpUrl.clear()
  connectingByCdpUrl.clear()
  for (const [key, cur] of connections) {
    if (cur.onDisconnected && typeof cur.browser.off === 'function') {
      cur.browser.off('disconnected', cur.onDisconnected)
    }
    // Only fully close Playwright-managed browsers; disconnect CDP connections
    if (key === CACHE_KEY_LAUNCHED) {
      await cur.browser.close().catch(() => {})
    } else {
      await disconnectSafely(cur.browser)
    }
  }
}

async function disconnectSafely(browser: Browser): Promise<void> {
  try {
    // Playwright's Browser object from connectOverCDP supports disconnect
    // which drops the WebSocket without sending Browser.close CDP command
    if (typeof (browser as any).disconnect === 'function') {
      await (browser as any).disconnect()
    } else {
      await browser.close()
    }
  } catch { /* ignore */ }
}
