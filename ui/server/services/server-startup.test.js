import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runServerStartupBeforeListen,
  startServerAfterStartup
} from './server-startup.js';

test('runServerStartupBeforeListen initializes the daemon before the rest of startup', async () => {
  const steps = [];

  await runServerStartupBeforeListen({
    initializeCronDaemonOwnerEnvFn: () => {
      steps.push('owner');
    },
    ensureCronDaemonForUiStartupFn: async () => {
      steps.push('daemon');
    },
    startCronDaemonClientLeaseFn: async () => {
      steps.push('lease');
    },
    initializeDatabaseFn: async () => {
      steps.push('database');
    },
    ensureLocalUserWhenAuthDisabledFn: async () => {
      steps.push('local-user');
    },
    configureWebPushFn: () => {
      steps.push('web-push');
    }
  });

  assert.deepEqual(steps, ['owner', 'daemon', 'lease', 'database', 'local-user', 'web-push']);
});

test('runServerStartupBeforeListen persists owner only for daemons it starts', async () => {
  const steps = [];

  await runServerStartupBeforeListen({
    initializeCronDaemonOwnerEnvFn: () => {
      steps.push('owner');
    },
    ensureCronDaemonForUiStartupFn: async () => {
      steps.push('daemon');
      return { started: true, response: { ok: true, data: { type: 'pong' } } };
    },
    persistCurrentCronDaemonOwnerFn: async () => {
      steps.push('persist-owner');
    },
    startCronDaemonClientLeaseFn: async () => {
      steps.push('lease');
    },
    initializeDatabaseFn: async () => {
      steps.push('database');
    },
    ensureLocalUserWhenAuthDisabledFn: async () => {
      steps.push('local-user');
    },
    configureWebPushFn: () => {
      steps.push('web-push');
    }
  });

  assert.deepEqual(steps, ['owner', 'daemon', 'persist-owner', 'lease', 'database', 'local-user', 'web-push']);
});

test('startServerAfterStartup does not continue into listen when startup fails', async () => {
  let listenCalled = false;

  await assert.rejects(
    () => startServerAfterStartup({
      startupFn: async () => {
        throw new Error('daemon bootstrap failed');
      },
      listenFn: async () => {
        listenCalled = true;
      }
    }),
    /daemon bootstrap failed/
  );

  assert.equal(listenCalled, false);
});
