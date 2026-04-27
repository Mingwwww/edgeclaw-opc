import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildHookMapFromConfig,
  loadPluginHooksFromDir,
  mergeHookMaps,
  resolveTurnkeyPluginRoot,
  __testing__,
} from './plugin-hooks.js';

const { substitutePluginRoot } = __testing__;

// -- substitutePluginRoot ----------------------------------------------------

test('substitutePluginRoot replaces every occurrence', () => {
  const result = substitutePluginRoot(
    'node ${CLAUDE_PLUGIN_ROOT}/a.js && node ${CLAUDE_PLUGIN_ROOT}/b.js',
    '/plugin/root'
  );
  assert.equal(result, 'node /plugin/root/a.js && node /plugin/root/b.js');
});

test('substitutePluginRoot is safe with $ in pluginRoot path', () => {
  const result = substitutePluginRoot('${CLAUDE_PLUGIN_ROOT}/x', '/foo$1bar');
  assert.equal(result, '/foo$1bar/x');
});

// -- buildHookMapFromConfig --------------------------------------------------

test('buildHookMapFromConfig produces SDK shape for command hooks', () => {
  const map = buildHookMapFromConfig('/plugin', {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/a.js' }] }
      ],
      PostToolUse: [
        {
          matcher: '.*',
          hooks: [
            { type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/b.js' },
            { type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/c.js' }
          ]
        }
      ]
    }
  });

  assert.deepEqual(Object.keys(map).sort(), ['PostToolUse', 'UserPromptSubmit']);
  assert.equal(map.UserPromptSubmit.length, 1);
  assert.equal(map.UserPromptSubmit[0].hooks.length, 1);
  assert.equal(typeof map.UserPromptSubmit[0].hooks[0], 'function');

  assert.equal(map.PostToolUse.length, 1);
  assert.equal(map.PostToolUse[0].matcher, '.*');
  assert.equal(map.PostToolUse[0].hooks.length, 2);
});

test('buildHookMapFromConfig drops non-command hook types', () => {
  const map = buildHookMapFromConfig('/plugin', {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'prompt', prompt: 'Should be skipped' },
            { type: 'command', command: 'echo ok' }
          ]
        }
      ]
    }
  });
  assert.equal(map.Stop.length, 1);
  assert.equal(map.Stop[0].hooks.length, 1);
});

test('buildHookMapFromConfig returns {} for empty/invalid config', () => {
  assert.deepEqual(buildHookMapFromConfig('/plugin', {}), {});
  assert.deepEqual(buildHookMapFromConfig('/plugin', null), {});
  assert.deepEqual(buildHookMapFromConfig('/plugin', { hooks: 'oops' }), {});
});

// -- mergeHookMaps -----------------------------------------------------------

test('mergeHookMaps concatenates per-event matcher arrays', () => {
  const a = { Stop: [{ hooks: [() => ({})] }] };
  const b = { Stop: [{ hooks: [() => ({})] }], PostToolUse: [{ hooks: [() => ({})] }] };
  const merged = mergeHookMaps(a, b);
  assert.equal(merged.Stop.length, 2);
  assert.equal(merged.PostToolUse.length, 1);
});

test('mergeHookMaps tolerates undefined / empty inputs', () => {
  assert.deepEqual(mergeHookMaps(undefined, null, {}, { Stop: [] }), {});
});

// -- spawn integration -------------------------------------------------------

test('command hook spawns the script, supplies stdin + env, and resolves', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-test-'));
  try {
    const scriptPath = path.join(tmp, 'echo-hook.js');
    const outPath = path.join(tmp, 'received.json');
    await fs.writeFile(
      scriptPath,
      `
        const fs = require('fs');
        let data = '';
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => {
          fs.writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({
            stdin: data,
            env: {
              CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
              CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
            }
          }));
          process.exit(0);
        });
      `
    );

    const map = buildHookMapFromConfig(tmp, {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: `node ${scriptPath}` }] }
        ]
      }
    });

    const callback = map.UserPromptSubmit[0].hooks[0];
    const fakeInput = {
      session_id: 'sess-1',
      hook_event_name: 'UserPromptSubmit',
      cwd: tmp,
      transcript_path: '/tmp/transcript',
      prompt: 'hello world',
    };

    const result = await callback(fakeInput, undefined, {});
    assert.deepEqual(result, {});

    const recorded = JSON.parse(await fs.readFile(outPath, 'utf8'));
    assert.equal(recorded.env.CLAUDE_PLUGIN_ROOT, tmp);
    assert.equal(recorded.env.CLAUDE_PROJECT_DIR, tmp);
    assert.ok(recorded.stdin.endsWith('\n'), 'stdin payload should be newline-terminated');
    const parsedStdin = JSON.parse(recorded.stdin.trim());
    assert.equal(parsedStdin.prompt, 'hello world');
    assert.equal(parsedStdin.hook_event_name, 'UserPromptSubmit');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('command hook returns {} on non-zero exit (non-blocking)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-test-'));
  try {
    const scriptPath = path.join(tmp, 'crash.js');
    await fs.writeFile(scriptPath, `process.exit(1);`);

    const map = buildHookMapFromConfig(tmp, {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: `node ${scriptPath}` }] }]
      }
    }, { logger: () => {} });

    const callback = map.Stop[0].hooks[0];
    const result = await callback({ cwd: tmp, hook_event_name: 'Stop' }, undefined, {});
    assert.deepEqual(result, {});
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('command hook parses JSON stdout into HookJSONOutput', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-test-'));
  try {
    const scriptPath = path.join(tmp, 'json-out.js');
    await fs.writeFile(
      scriptPath,
      `process.stdout.write(JSON.stringify({ continue: false, stopReason: 'manual' }) + '\\n'); process.exit(0);`
    );

    const map = buildHookMapFromConfig(tmp, {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: `node ${scriptPath}` }] }]
      }
    });

    const callback = map.Stop[0].hooks[0];
    const result = await callback({ cwd: tmp, hook_event_name: 'Stop' }, undefined, {});
    assert.deepEqual(result, { continue: false, stopReason: 'manual' });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('command hook honours timeoutMs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-test-'));
  try {
    const scriptPath = path.join(tmp, 'sleep.js');
    await fs.writeFile(scriptPath, `setTimeout(() => process.exit(0), 5000);`);

    const map = buildHookMapFromConfig(tmp, {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: `node ${scriptPath}` }] }]
      }
    }, { timeoutMs: 200, logger: () => {} });

    const callback = map.Stop[0].hooks[0];
    const start = Date.now();
    const result = await callback({ cwd: tmp, hook_event_name: 'Stop' }, undefined, {});
    const elapsed = Date.now() - start;
    assert.deepEqual(result, {});
    assert.ok(elapsed < 2000, `expected timeout to fire fast, took ${elapsed}ms`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// -- loadPluginHooksFromDir + resolveTurnkeyPluginRoot ----------------------

test('loadPluginHooksFromDir reads hooks.json from disk', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-test-'));
  try {
    const hooksDir = path.join(tmp, 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'echo hi' }] }
          ]
        }
      })
    );

    const map = await loadPluginHooksFromDir(tmp);
    assert.equal(map.UserPromptSubmit.length, 1);
    assert.equal(typeof map.UserPromptSubmit[0].hooks[0], 'function');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('loadPluginHooksFromDir returns {} when hooks.json missing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-test-'));
  try {
    const map = await loadPluginHooksFromDir(tmp);
    assert.deepEqual(map, {});
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveTurnkeyPluginRoot prefers env var, then cwd lookups', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-test-'));
  try {
    const envRoot = path.join(tmp, 'envroot');
    await fs.mkdir(path.join(envRoot, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(envRoot, 'hooks', 'hooks.json'), '{}');

    const previous = process.env.TURNKEY_PLUGIN_ROOT;
    process.env.TURNKEY_PLUGIN_ROOT = envRoot;
    try {
      assert.equal(await resolveTurnkeyPluginRoot(tmp), envRoot);
    } finally {
      if (previous === undefined) delete process.env.TURNKEY_PLUGIN_ROOT;
      else process.env.TURNKEY_PLUGIN_ROOT = previous;
    }

    // Without env var: should fall back to <cwd>/packages/turnkey-cc-plugin
    const cwdCandidate = path.join(tmp, 'packages', 'turnkey-cc-plugin');
    await fs.mkdir(path.join(cwdCandidate, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(cwdCandidate, 'hooks', 'hooks.json'), '{}');
    const previousAgain = process.env.TURNKEY_PLUGIN_ROOT;
    delete process.env.TURNKEY_PLUGIN_ROOT;
    try {
      assert.equal(await resolveTurnkeyPluginRoot(tmp), cwdCandidate);
    } finally {
      if (previousAgain !== undefined) process.env.TURNKEY_PLUGIN_ROOT = previousAgain;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveTurnkeyPluginRoot returns null when nothing matches', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-test-'));
  try {
    const previous = process.env.TURNKEY_PLUGIN_ROOT;
    delete process.env.TURNKEY_PLUGIN_ROOT;
    try {
      // fallbackToModuleDir disabled because the module lives inside the
      // edgeclaw-opc monorepo where the real plugin exists — the walk would
      // otherwise find the real plugin and the test would lose its meaning.
      assert.equal(
        await resolveTurnkeyPluginRoot({ cwd: tmp, fallbackToModuleDir: false }),
        null
      );
    } finally {
      if (previous !== undefined) process.env.TURNKEY_PLUGIN_ROOT = previous;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveTurnkeyPluginRoot falls back to module-dir walk when cwd is unrelated', async () => {
  // This is the critical case for the webui: claude-sdk.js is invoked with
  // the user's project cwd (e.g. ~/.claude-gateway/general) which has no
  // relationship to the monorepo. The resolver MUST still find the plugin
  // by walking up from claudecodeui/server itself.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-test-'));
  try {
    const previous = process.env.TURNKEY_PLUGIN_ROOT;
    delete process.env.TURNKEY_PLUGIN_ROOT;
    try {
      const root = await resolveTurnkeyPluginRoot(tmp);
      assert.ok(root, 'expected module-dir fallback to find the real plugin');
      // sanity: the resolved path actually contains hooks.json
      const stat = await fs.stat(path.join(root, 'hooks', 'hooks.json'));
      assert.ok(stat.isFile());
    } finally {
      if (previous !== undefined) process.env.TURNKEY_PLUGIN_ROOT = previous;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// -- end-to-end against real turnkey plugin ----------------------------------

test('integration: real turnkey-capture.js writes to inbox.jsonl', async () => {
  const repoRoot = path.resolve(process.cwd(), '..');
  const realPluginRoot = path.join(repoRoot, 'packages', 'turnkey-cc-plugin');
  try {
    await fs.access(path.join(realPluginRoot, 'hooks', 'hooks.json'));
  } catch (_) {
    return; // skip when running outside the monorepo layout
  }

  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'turnkey-home-'));
  const previousHome = process.env.TURNKEY_HOME;
  process.env.TURNKEY_HOME = tmpHome;
  try {
    const map = await loadPluginHooksFromDir(realPluginRoot);
    const callback = map.UserPromptSubmit?.[0]?.hooks?.[0];
    assert.equal(typeof callback, 'function', 'expected UserPromptSubmit hook to be loaded');

    const result = await callback({
      session_id: 'integration-test',
      hook_event_name: 'UserPromptSubmit',
      cwd: process.cwd(),
      transcript_path: '/tmp/integration-transcript',
      prompt: '/turnkey:start integration-test',
    }, undefined, {});
    assert.deepEqual(result, {});

    const inbox = await fs.readFile(path.join(tmpHome, 'inbox.jsonl'), 'utf8');
    const lines = inbox.trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, 'expected at least one inbox line');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.event, 'UserPromptSubmit');
    assert.equal(last.payload?.prompt, '/turnkey:start integration-test');
  } finally {
    if (previousHome === undefined) delete process.env.TURNKEY_HOME;
    else process.env.TURNKEY_HOME = previousHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
