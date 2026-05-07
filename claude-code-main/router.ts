/**
 * Embedded CCR (Claude Code Router) — replaces proxy.ts
 *
 * Self-contained: CCR core is bundled under ./src/router/server.cjs (no external repo needed).
 *
 * Capabilities:
 *   - Multi-provider routing (OpenRouter, OpenAI, Gemini, etc.)
 *   - TokenSaver (4-tier LLM judge classification)
 *   - Auto-Orchestrate (prompt injection + tool stripping)
 *   - Session state (model stickiness)
 *   - Token stats collection
 *   - 22 built-in request/response transformers
 *   - Fallback chains
 *
 * Configuration: ccr-config.json
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { DEFAULT_ROUTER_CONFIG } from './ccr-defaults'

const DIR = dirname(new URL(import.meta.url).pathname)

// ── Auto-build: rebuild server.cjs when TS source is newer ──

function newestMtime(dir: string, ext = '.ts'): number {
  let newest = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full, ext))
      else if (entry.name.endsWith(ext)) newest = Math.max(newest, statSync(full).mtimeMs)
    }
  } catch {}
  return newest
}

const routerDir = resolve(DIR, 'src/router')
const cjsPath = resolve(routerDir, 'server.cjs')
const buildScript = resolve(routerDir, 'build.mjs')

if (existsSync(resolve(routerDir, 'src/server.ts')) && existsSync(buildScript)) {
  const cjsMtime = existsSync(cjsPath) ? statSync(cjsPath).mtimeMs : 0
  const srcMtime = Math.max(
    newestMtime(resolve(routerDir, 'src')),
    newestMtime(resolve(routerDir, 'shared')),
  )
  if (srcMtime > cjsMtime || cjsMtime === 0) {
    console.log('[router] Source newer than bundle — rebuilding...')
    execSync('node build.mjs', { cwd: routerDir, stdio: 'inherit' })
    console.log('[router] Rebuild complete')
  }
}

const CCR = require(cjsPath)
const Server = CCR.default

const configPath = resolve(DIR, 'ccr-config.json')
let config: any
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'))
} catch (err) {
  console.error(`[router] Failed to load ${configPath}:`, err)
  process.exit(1)
}

const mergedRouter = config.Router
  ? { ...DEFAULT_ROUTER_CONFIG, ...config.Router,
      tokenSaver: { ...DEFAULT_ROUTER_CONFIG.tokenSaver, ...config.Router.tokenSaver },
      autoOrchestrate: { ...DEFAULT_ROUTER_CONFIG.autoOrchestrate, ...config.Router.autoOrchestrate },
    }
  : { ...DEFAULT_ROUTER_CONFIG }

const server = new Server({
  initialConfig: {
    providers: config.Providers,
    Router: mergedRouter,
    tokenStats: config.tokenStats,
    API_TIMEOUT_MS: config.API_TIMEOUT_MS,
    HOST: config.HOST || '127.0.0.1',
    PORT: config.PORT || 19080,
    LOG: config.LOG ?? true,
  },
  logger: config.LOG !== false,
})

await server.start()

const shutdown = async (signal: string) => {
  console.log(`[router] Received ${signal}, shutting down...`)
  try {
    const { getGlobalStatsCollector } = CCR
    const collector = getGlobalStatsCollector?.()
    if (collector) {
      collector.stopAutoFlush()
      await collector.flush()
    }
  } catch {}
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
