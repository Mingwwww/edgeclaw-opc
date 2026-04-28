import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCronDaemonSpawnCommand,
  ensureCronDaemonForUiStartup
} from './cron-daemon-startup.js';

function createUnavailableError(code) {
  const error = new Error(`${code} unavailable`);
  error.code = code;
  return error;
}

test('buildCronDaemonSpawnCommand prefers the local Claude Code tree and falls back to the CLI path', () => {
  const localCommand = buildCronDaemonSpawnCommand({
    resolveClaudeCodeMainRootFn: () => '/tmp/claude-code-main'
  });

  assert.equal(localCommand.command, 'bun');
  assert.deepEqual(localCommand.args.slice(0, 3), [
    '--preload',
    '/tmp/claude-code-main/preload.ts',
    '-e'
  ]);
  assert.match(localCommand.args[3], /daemonMain/);
  assert.match(localCommand.args[3], /daemonMain\(\['serve'\]\)/);
  assert.doesNotMatch(localCommand.args.join(' '), /\brun\b/);
  assert.doesNotMatch(localCommand.args.join(' '), /cli\.tsx/);

  const fallbackCommand = buildCronDaemonSpawnCommand({
    resolveClaudeCodeMainRootFn: () => null,
    cliPath: '/opt/bin/claude'
  });

  assert.deepEqual(fallbackCommand, {
    command: '/opt/bin/claude',
    args: ['daemon', 'serve']
  });
});

test('ensureCronDaemonForUiStartup reuses a healthy daemon without spawning a new process', async () => {
  const requests = [];
  let spawnCalled = false;

  const result = await ensureCronDaemonForUiStartup({
    sendCronDaemonRequestFn: async (request) => {
      requests.push(request);
      return { ok: true, data: { type: 'pong', runtimes: [] } };
    },
    spawnFn: () => {
      spawnCalled = true;
      return { unref() {} };
    }
  });

  assert.equal(result.response.data.type, 'pong');
  assert.equal(result.started, false);
  assert.deepEqual(requests, [{ type: 'ping' }]);
  assert.equal(spawnCalled, false);
});

test('ensureCronDaemonForUiStartup starts the daemon when the socket is unavailable', async () => {
  const requests = [];
  const spawnCalls = [];
  let requestCount = 0;

  const result = await ensureCronDaemonForUiStartup({
    sendCronDaemonRequestFn: async (request) => {
      requests.push(request);
      requestCount += 1;
      if (requestCount === 1) {
        throw createUnavailableError('ENOENT');
      }
      return { ok: true, data: { type: 'pong', runtimes: [] } };
    },
    spawnFn: (command, args, options) => {
      const call = { command, args, options, unrefCalled: false };
      spawnCalls.push(call);
      return {
        unref() {
          call.unrefCalled = true;
        }
      };
    },
    buildCronDaemonSpawnCommandFn: () => ({
      command: 'bun',
      args: [
        '--preload',
        '/tmp/claude-code-main/preload.ts',
        '-e',
        `const { daemonMain } = await import(${JSON.stringify('/tmp/claude-code-main/src/daemon/main.ts')}); await daemonMain(['serve'])`
      ]
    }),
    sleepFn: async () => {}
  });

  assert.equal(result.response.data.type, 'pong');
  assert.equal(result.started, true);
  assert.deepEqual(requests, [{ type: 'ping' }, { type: 'ping' }]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'bun');
  assert.deepEqual(spawnCalls[0].args.slice(0, 3), [
    '--preload',
    '/tmp/claude-code-main/preload.ts',
    '-e'
  ]);
  assert.match(spawnCalls[0].args[3], /daemonMain\(\['serve'\]\)/);
  assert.deepEqual(spawnCalls[0].options, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: 'ignore'
  });
  assert.equal(spawnCalls[0].unrefCalled, true);
});

test('ensureCronDaemonForUiStartup fails fast when the daemon never becomes healthy', async () => {
  let requestCount = 0;
  let sleepCount = 0;

  await assert.rejects(
    () => ensureCronDaemonForUiStartup({
      sendCronDaemonRequestFn: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          throw createUnavailableError('ENOENT');
        }
        throw new Error('Timed out waiting for Cron daemon response');
      },
      spawnFn: () => ({ unref() {} }),
      buildCronDaemonSpawnCommandFn: () => ({
        command: 'claude',
        args: ['daemon', 'serve']
      }),
      sleepFn: async () => {
        sleepCount += 1;
      },
      retryAttempts: 3,
      retryDelayMs: 1
    }),
    /Timed out waiting for Cron daemon response/
  );

  assert.equal(requestCount, 4);
  assert.equal(sleepCount, 2);
});
