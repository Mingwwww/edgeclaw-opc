/**
 * Embedded CCR (Claude Code Router) — zero-port mode.
 *
 * Loads the pre-built CCR bundle from the sibling claude-code-main tree,
 * initializes services in-process (no HTTP server, no port), and exposes
 * direct access to CCR services for the Express routes.
 *
 * Router config is built from ~/.edgeclaw/config.yaml. ccr-config.json is
 * generated only as an internal compatibility artifact for router consumers.
 */

import { createRequire } from 'module';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { resolveClaudeCodeMainRoot } from './claude-code-main-path.js';
import { buildCcrConfig, readEdgeClawConfigFile } from './services/edgeclawConfig.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let ccrInstance = null;
let ccrModule = null;
let ccrServices = null;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getLocalConfigPath() {
  return path.join(os.homedir(), '.edgeclaw', 'router', 'ccr-config.generated.json');
}

export function loadCCRConfig(ccrRoot) {
  try {
    const { config } = readEdgeClawConfigFile();
    if (config.router?.enabled) {
      return buildCcrConfig(config);
    }
  } catch {
    return null;
  }
  return null;
}

export function saveCCRConfig(config) {
  const json = JSON.stringify(config, null, 2) + '\n';
  const localPath = getLocalConfigPath();
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, json, 'utf-8');
  console.log(`[CCR] Generated config snapshot → ${localPath}`);
}

// ---------------------------------------------------------------------------
// Auto-build from source
// ---------------------------------------------------------------------------

function newestMtime(dir, ext = '.ts') {
  let newest = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        newest = Math.max(newest, newestMtime(full, ext));
      } else if (entry.name.endsWith(ext)) {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    }
  } catch { /* directory may not exist */ }
  return newest;
}

function tryAutoBuildFromSource(routerDir) {
  const sourceEntry = path.join(routerDir, 'src', 'server.ts');
  const buildScript = path.join(routerDir, 'build.mjs');
  const outputCjs = path.join(routerDir, 'server.cjs');

  if (!fs.existsSync(sourceEntry) || !fs.existsSync(buildScript)) return false;

  const cjsMtime = fs.existsSync(outputCjs) ? fs.statSync(outputCjs).mtimeMs : 0;
  const srcMtime = Math.max(
    newestMtime(path.join(routerDir, 'src')),
    newestMtime(path.join(routerDir, 'shared')),
  );

  if (cjsMtime >= srcMtime && cjsMtime > 0) return false;

  console.log('[CCR] Source newer than bundle — rebuilding...');
  try {
    execSync('node build.mjs', { cwd: routerDir, stdio: 'pipe', timeout: 30000 });
    console.log('[CCR] Rebuild complete');
    return true;
  } catch (err) {
    console.warn(`[CCR] Auto-build failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startEmbeddedCCR(options = {}) {
  const ccrRoot = resolveClaudeCodeMainRoot();
  const config = loadCCRConfig(ccrRoot);
  if (!config) {
    throw new Error('router.enabled is false or ~/.edgeclaw/config.yaml has no router config');
  }

  const routerDir = ccrRoot ? path.join(ccrRoot, 'src', 'router') : null;
  if (routerDir) tryAutoBuildFromSource(routerDir);

  const serverCjsPath = routerDir
    ? path.join(routerDir, 'server.cjs')
    : null;
  if (!serverCjsPath || !fs.existsSync(serverCjsPath)) {
    throw new Error(`server.cjs not found${routerDir ? ' at ' + serverCjsPath : ''}`);
  }

  ccrModule = require(serverCjsPath);
  const Server = ccrModule.default;

  ccrInstance = new Server({
    initialConfig: {
      providers: config.Providers,
      Router: config.Router,
      tokenStats: config.tokenStats,
      API_TIMEOUT_MS: config.API_TIMEOUT_MS || 120000,
      HOST: '127.0.0.1',
      PORT: 0,
      LOG: config.LOG ?? true,
    },
    logger: config.LOG !== false,
  });

  // init() only — no listen(), no port
  await ccrInstance.init();

  ccrServices = {
    configService: ccrInstance.configService,
    providerService: ccrInstance.providerService,
    transformerService: ccrInstance.transformerService,
    tokenizerService: ccrInstance.tokenizerService,
    logger: {
      info: () => {},
      warn: (...a) => console.warn('[CCR]', ...a),
      error: (...a) => console.error('[CCR]', ...a),
      debug: () => {},
    },
  };

  // Do NOT override ANTHROPIC_BASE_URL to ccr.local here.
  // edgeclawConfig.js already sets it to http://127.0.0.1:<proxyPort>,
  // and all traffic must go through the proxy so that the routing
  // dashboard can collect stats.  Overriding to ccr.local bypasses the
  // proxy and causes dashboard counters to stay at zero.

  return { port: null, baseUrl: null, reused: false, zeroPorts: true };
}

export function getCCRBaseUrl() {
  // Return the proxy URL that edgeclawConfig already configured,
  // rather than the ccr.local sentinel that bypasses stats collection.
  const proxyPort = process.env.PROXY_PORT || process.env.EDGECLAW_PROXY_PORT || '18080';
  return ccrServices ? `http://127.0.0.1:${proxyPort}` : null;
}

export function getCCRPort() {
  return null;
}

export function getCCRModule() {
  return ccrModule;
}

export function getCCRServices() {
  return ccrServices;
}

export function getCCRInstance() {
  return ccrInstance;
}

export async function restartCCR() {
  await shutdownCCR();
  return startEmbeddedCCR();
}

export async function shutdownCCR() {
  if (ccrModule) {
    try {
      const { getGlobalStatsCollector } = ccrModule;
      const collector = getGlobalStatsCollector?.();
      if (collector) {
        collector.stopAutoFlush();
        await collector.flush();
      }
    } catch { /* best effort */ }
  }

  ccrInstance = null;
  ccrServices = null;
}
