import type { Browser, BrowserContext, Page } from 'playwright-core'
import { ensureGlobalChrome, restartGlobalChrome, isCDPHealthy } from './globalChrome.js'

const CDP_CONNECT_TIMEOUT = 15_000
const MAX_CDP_RETRIES = 2
const CDP_RETRY_DELAY_MS = 250

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

/**
 * Fallback: let Playwright manage Chrome directly (no external CDP).
 * Works around Chrome 147+ breaking connectOverCDP's setDownloadBehavior.
 */
async function launchManagedBrowser(): Promise<BrowserSession> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
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
    // No external Chrome available — fall back to Playwright-managed launch
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
      // connectOverCDP failed (e.g. Chrome 147 setDownloadBehavior issue)
      // Fall back to Playwright-managed Chrome
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
 * Mirrors OpenClaw's closePlaywrightBrowserConnection.
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
      await cur.browser.close().catch(() => {})
    }
    return
  }

  const connections = Array.from(cachedByCdpUrl.values())
  cachedByCdpUrl.clear()
  connectingByCdpUrl.clear()
  for (const cur of connections) {
    if (cur.onDisconnected && typeof cur.browser.off === 'function') {
      cur.browser.off('disconnected', cur.onDisconnected)
    }
    await cur.browser.close().catch(() => {})
  }
}
