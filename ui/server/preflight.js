/**
 * preflight.js — Environment pre-checks before starting the full server.
 *
 * Phase A: Runtime dependencies (bun, node_modules)
 * Phase B: Conflict detection (ports, stale processes)
 * Phase C: config.yaml four-state evaluation (missing / broken / incomplete / ok)
 *
 * Returns a result object consumed by cli.js to decide whether to enter
 * the setup wizard or boot the full server directly.
 */

/**
 * preflight.js — Environment pre-checks before starting the full server.
 *
 * Phase A: Runtime dependencies (bun, node_modules)
 * Phase B: Conflict detection (ports)
 *
 * Config validation is now handled in-browser via the Onboarding UI.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COLORS = {
  reset: '\x1b[0m', bright: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
const c = {
  ok:   (t) => `${COLORS.green}${t}${COLORS.reset}`,
  warn: (t) => `${COLORS.yellow}${t}${COLORS.reset}`,
  err:  (t) => `${COLORS.red}${t}${COLORS.reset}`,
  dim:  (t) => `${COLORS.dim}${t}${COLORS.reset}`,
  info: (t) => `${COLORS.cyan}${t}${COLORS.reset}`,
};

// ---------------------------------------------------------------------------
// Phase A: Dependencies
// ---------------------------------------------------------------------------

function findBun() {
  const candidates = [
    process.env.BUN_BIN,
    process.env.BUN,
    process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', 'bun') : null,
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    execSync('bun --version', { stdio: 'ignore' });
    return 'bun';
  } catch { return null; }
}

function installBun() {
  console.log(`${c.info('[preflight]')} bun not found, installing...`);
  try {
    execSync('curl -fsSL https://bun.sh/install | bash', {
      stdio: 'inherit',
      env: { ...process.env, SHELL: process.env.SHELL || '/bin/bash' },
    });
    const bunPath = path.join(os.homedir(), '.bun', 'bin');
    process.env.PATH = `${bunPath}:${process.env.PATH}`;
    console.log(`${c.ok('[preflight]')} bun installed.`);
    return path.join(bunPath, 'bun');
  } catch (e) {
    return null;
  }
}

function resolveClaudeCodeMainRoot() {
  if (process.env.CLOUDCLI_USE_BUNDLED_CLAUDE_CODE === '1' ||
      process.env.CLOUDCLI_USE_BUNDLED_CLAUDE_CODE === 'true') {
    return null;
  }
  const fromEnv = process.env.CLAUDE_CODE_MAIN_DIR || process.env.CLOUDCLI_CLAUDE_CODE_MAIN;
  if (fromEnv) {
    const root = path.resolve(fromEnv.trim());
    if (fs.existsSync(path.join(root, 'src', 'entrypoints', 'cli.tsx'))) return root;
    return null;
  }
  const uiRoot = path.resolve(__dirname, '..');
  const sibling = path.resolve(uiRoot, '..', 'claude-code-main');
  if (fs.existsSync(path.join(sibling, 'src', 'entrypoints', 'cli.tsx'))) return sibling;
  return null;
}

async function checkDependencies() {
  const issues = [];

  // bun
  let bunPath = findBun();
  if (!bunPath) {
    bunPath = installBun();
    if (!bunPath) {
      issues.push('Failed to install bun. Install manually: curl -fsSL https://bun.sh/install | bash');
      return { ok: issues.length === 0, issues, bunPath: null };
    }
  } else {
    console.log(`${c.ok('[preflight]')} bun: OK`);
  }

  // claude-code-main
  const ccmRoot = resolveClaudeCodeMainRoot();
  if (ccmRoot) {
    if (!fs.existsSync(path.join(ccmRoot, 'node_modules'))) {
      console.log(`${c.info('[preflight]')} Installing claude-code-main dependencies...`);
      try {
        execSync(`"${bunPath}" install`, { cwd: ccmRoot, stdio: 'inherit' });
        console.log(`${c.ok('[preflight]')} claude-code-main deps installed.`);
      } catch {
        issues.push(`Failed to run bun install in ${ccmRoot}`);
      }
    } else {
      console.log(`${c.ok('[preflight]')} claude-code-main deps: OK`);
    }
  } else {
    console.log(`${c.dim('[preflight]')} claude-code-main not found (optional, skipping)`);
  }

  // ui node_modules
  const uiRoot = path.resolve(__dirname, '..');
  if (!fs.existsSync(path.join(uiRoot, 'node_modules'))) {
    console.log(`${c.info('[preflight]')} Installing UI dependencies...`);
    try {
      execSync('npm install --omit=dev', { cwd: uiRoot, stdio: 'inherit' });
      console.log(`${c.ok('[preflight]')} UI deps installed.`);
    } catch {
      issues.push('Failed to run npm install in ui/');
    }
  }

  return { ok: issues.length === 0, issues, bunPath };
}

// ---------------------------------------------------------------------------
// Phase B: Conflict detection
// ---------------------------------------------------------------------------

function isPortInUse(port) {
  try {
    const result = spawnSync('lsof', ['-i', `:${port}`, '-t'], { encoding: 'utf8', timeout: 3000 });
    const pids = (result.stdout || '').trim();
    return pids ? pids.split('\n').map(Number).filter(Boolean) : [];
  } catch { return []; }
}

function checkConflicts(serverPort) {
  const warnings = [];
  const ports = [
    { port: Number(serverPort) || 3001, label: 'server' },
    { port: 18080, label: 'proxy' },
  ];

  for (const { port, label } of ports) {
    const pids = isPortInUse(port);
    if (pids.length) {
      warnings.push(
        `Port ${port} (${label}) already in use by PID ${pids.join(', ')}. ` +
        `Stop the process or use --port to pick another.`
      );
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runPreflight({ cliRoot, serverPort } = {}) {
  // Phase A: Dependencies
  const deps = await checkDependencies();
  if (!deps.ok) {
    return { ok: false, error: deps.issues.join('; ') };
  }

  // Phase B: Port conflicts
  const conflicts = checkConflicts(serverPort || process.env.SERVER_PORT);
  if (conflicts.length) {
    for (const w of conflicts) {
      console.log(`${c.warn('[CONFLICT]')} ${w}`);
    }
    return { ok: false, error: 'Port conflict detected. Resolve and retry.' };
  }
  console.log(`${c.ok('[preflight]')} No port conflicts.`);

  return { ok: true };
}
