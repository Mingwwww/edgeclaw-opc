/**
 * Plugin hooks loader for the Claude Agent SDK.
 *
 * Bridges Claude Code plugin `hooks.json` (the same format consumed by the
 * standalone CLI) into the Agent SDK's `options.hooks` callback API. This
 * lets `claudecodeui` reproduce side effects (`turnkey-capture.js`,
 * `turnkey-budget.js`, ...) that would otherwise only run when prompts are
 * dispatched through the CLI/TUI.
 *
 * Design contract (matches `claude-code-main/src/utils/hooks.ts`):
 *   - The script receives a JSON-serialised hook input on stdin (single
 *     line, terminated by "\n").
 *   - `${CLAUDE_PLUGIN_ROOT}` in the command string is substituted with the
 *     plugin root before spawn. The script also gets `CLAUDE_PLUGIN_ROOT`
 *     and `CLAUDE_PROJECT_DIR` env vars.
 *   - stdout MAY contain a JSON object matching the SDK's
 *     `SyncHookJSONOutput` shape. Empty stdout / parse errors are treated
 *     as `{}` (no-op, hook proceeds).
 *   - All errors are non-blocking: we log a warning and resolve `{}` so a
 *     misbehaving observer never stalls the agent.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_TIMEOUT_MS = 30_000;
const STDIN_BYTES_LIMIT = 1 * 1024 * 1024; // mirror turnkey-capture.js cap

function defaultLogger(level, message, meta) {
  const fn = level === 'error' ? console.error : console.warn;
  if (meta) fn(`[plugin-hooks] ${message}`, meta);
  else fn(`[plugin-hooks] ${message}`);
}

function substitutePluginRoot(command, pluginRoot) {
  // Match the CLI: function-form replace so $-patterns in pluginRoot are
  // not interpreted (`$$` etc.). PLUGIN_DATA is left untouched — we have no
  // equivalent storage path in the webui surface.
  return command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => pluginRoot);
}

/**
 * Build a single async hook callback that spawns one shell command.
 *
 * @param {object} args
 * @param {string} args.command Already-substituted shell command.
 * @param {string} args.pluginRoot Used for env + log context.
 * @param {string} args.event Hook event name (for logging).
 * @param {number} [args.timeoutMs]
 * @param {(level: 'warn'|'error', message: string, meta?: any) => void} [args.logger]
 * @param {(opts: any) => any} [args.spawnImpl] Override for tests.
 * @returns {(input: any, toolUseID: string|undefined, options: any) => Promise<any>}
 */
function buildCommandHookCallback({
  command,
  pluginRoot,
  event,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = defaultLogger,
  spawnImpl = spawn,
}) {
  return async function pluginCommandHook(input /* , toolUseID, options */) {
    if (process.env.PLUGIN_HOOKS_DEBUG === '1') {
      logger('warn', `firing ${event} hook`, { command, cwd: input?.cwd });
    }
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PROJECT_DIR: input?.cwd || process.cwd(),
    };

    const cwd = input?.cwd && typeof input.cwd === 'string' ? input.cwd : process.cwd();

    let child;
    try {
      child = spawnImpl(command, [], {
        cwd,
        env,
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      logger('warn', `spawn failed for ${event} hook: ${err?.message || err}`, {
        command,
        pluginRoot,
      });
      return {};
    }

    let payload;
    try {
      payload = JSON.stringify(input ?? {});
    } catch (err) {
      logger('warn', `failed to serialize ${event} hook input: ${err?.message || err}`);
      try { child.kill(); } catch (_) {}
      return {};
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes <= STDIN_BYTES_LIMIT) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    // Write the payload, swallow EPIPE if the child exits before reading.
    child.stdin.on('error', () => { /* swallow EPIPE etc. */ });
    try {
      child.stdin.write(payload + '\n', 'utf8');
      child.stdin.end();
    } catch (err) {
      logger('warn', `stdin write failed for ${event} hook: ${err?.message || err}`);
      try { child.kill(); } catch (_) {}
      return {};
    }

    const completion = new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch (_) {}
        logger('warn', `timeout (${timeoutMs}ms) running ${event} hook`, { command });
        settle({});
      }, timeoutMs);

      child.on('error', (err) => {
        logger('warn', `child error in ${event} hook: ${err?.message || err}`, { command });
        settle({});
      });

      child.on('close', (code) => {
        if (code !== 0) {
          logger('warn', `${event} hook exited with code ${code}`, {
            command,
            stderr: stderr.slice(0, 500),
          });
        }
        const trimmed = stdout.trim();
        if (!trimmed) return settle({});
        // Hook scripts MAY output a JSON object on the first line. Anything
        // unparseable falls back to {} so we never feed garbage back to the
        // SDK control schema.
        try {
          const parsed = JSON.parse(trimmed.split('\n')[0]);
          if (parsed && typeof parsed === 'object') return settle(parsed);
          return settle({});
        } catch (_) {
          return settle({});
        }
      });
    });

    return completion;
  };
}

/**
 * Convert a parsed hooks.json object into the SDK hook map.
 *
 * @param {string} pluginRoot
 * @param {object} hooksJson Parsed contents of hooks.json.
 * @param {object} [opts]
 * @returns {Partial<Record<string, Array<{matcher?: string, hooks: Function[]}>>>}
 */
export function buildHookMapFromConfig(pluginRoot, hooksJson, opts = {}) {
  const out = {};
  const events = hooksJson?.hooks;
  if (!events || typeof events !== 'object') return out;

  for (const [eventName, matcherList] of Object.entries(events)) {
    if (!Array.isArray(matcherList)) continue;

    const builtMatchers = [];
    for (const matcherEntry of matcherList) {
      if (!matcherEntry || !Array.isArray(matcherEntry.hooks)) continue;

      const callbacks = [];
      for (const hookDef of matcherEntry.hooks) {
        if (!hookDef || hookDef.type !== 'command' || typeof hookDef.command !== 'string') {
          // Only `command` hooks are bridgeable from a plain JSON config.
          // Prompt/agent/http variants need full SDK context — skip them.
          continue;
        }
        const finalCommand = substitutePluginRoot(hookDef.command, pluginRoot);
        callbacks.push(buildCommandHookCallback({
          command: finalCommand,
          pluginRoot,
          event: eventName,
          timeoutMs: typeof hookDef.timeout === 'number'
            ? hookDef.timeout * 1000
            : opts.timeoutMs,
          logger: opts.logger,
          spawnImpl: opts.spawnImpl,
        }));
      }

      if (callbacks.length === 0) continue;

      const built = { hooks: callbacks };
      if (typeof matcherEntry.matcher === 'string' && matcherEntry.matcher.length > 0) {
        built.matcher = matcherEntry.matcher;
      }
      builtMatchers.push(built);
    }

    if (builtMatchers.length > 0) {
      out[eventName] = builtMatchers;
    }
  }

  return out;
}

/**
 * Read `<pluginRoot>/hooks/hooks.json` and return its SDK hook map.
 * Returns `{}` if the file is missing or unreadable; never throws.
 *
 * @param {string} pluginRoot
 * @param {object} [opts]
 */
export async function loadPluginHooksFromDir(pluginRoot, opts = {}) {
  const logger = opts.logger || defaultLogger;
  const configPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    logger('warn', `failed to read ${configPath}: ${err?.message || err}`);
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger('warn', `failed to parse ${configPath}: ${err?.message || err}`);
    return {};
  }

  return buildHookMapFromConfig(pluginRoot, parsed, opts);
}

/**
 * Merge multiple SDK hook maps. Per-event matcher arrays are concatenated
 * in the order maps are passed (later wins for nothing — they coexist).
 *
 * @param {...Partial<Record<string, Array<{matcher?: string, hooks: Function[]}>>>} maps
 */
export function mergeHookMaps(...maps) {
  const out = {};
  for (const map of maps) {
    if (!map || typeof map !== 'object') continue;
    for (const [event, matchers] of Object.entries(map)) {
      if (!Array.isArray(matchers) || matchers.length === 0) continue;
      if (!out[event]) out[event] = [];
      out[event].push(...matchers);
    }
  }
  return out;
}

/**
 * Walk `start` and its ancestors looking for `packages/turnkey-cc-plugin/hooks/hooks.json`.
 * Returns the matching plugin root or null. Stops at filesystem root.
 *
 * @param {string} start
 * @param {number} [maxDepth=8]
 */
async function findPluginRootByWalk(start, maxDepth = 8) {
  let dir = path.resolve(start);
  for (let i = 0; i < maxDepth; i += 1) {
    const candidate = path.join(dir, 'packages', 'turnkey-cc-plugin');
    try {
      const stat = await fs.stat(path.join(candidate, 'hooks', 'hooks.json'));
      if (stat.isFile()) return candidate;
    } catch (_) {
      // not here, walk up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the turnkey plugin root, in priority order:
 *   1. process.env.TURNKEY_PLUGIN_ROOT (must contain hooks/hooks.json)
 *   2. Walk up from `cwd` looking for `packages/turnkey-cc-plugin/hooks/hooks.json`
 *   3. Walk up from this module's directory (claudecodeui/server) — needed
 *      when the SDK is invoked with a project cwd outside the monorepo.
 *
 * Returns `null` if no candidate exists on disk.
 *
 * @param {string|{cwd?: string, fallbackToModuleDir?: boolean}} [cwdOrOpts]
 */
export async function resolveTurnkeyPluginRoot(cwdOrOpts) {
  const opts = (cwdOrOpts && typeof cwdOrOpts === 'object')
    ? cwdOrOpts
    : { cwd: cwdOrOpts };
  const cwd = opts.cwd || process.cwd();
  const fallbackToModuleDir = opts.fallbackToModuleDir !== false;

  if (process.env.TURNKEY_PLUGIN_ROOT) {
    const envRoot = process.env.TURNKEY_PLUGIN_ROOT;
    try {
      const stat = await fs.stat(path.join(envRoot, 'hooks', 'hooks.json'));
      if (stat.isFile()) return envRoot;
    } catch (_) { /* fall through to walks */ }
  }

  const fromCwd = await findPluginRootByWalk(cwd);
  if (fromCwd) return fromCwd;

  if (fallbackToModuleDir) {
    const fromModule = await findPluginRootByWalk(__dirname);
    if (fromModule) return fromModule;
  }

  return null;
}

// Exported for tests
export const __testing__ = {
  buildCommandHookCallback,
  substitutePluginRoot,
};
