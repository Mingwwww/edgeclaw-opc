import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startCronDaemonClientLease } from './cron-daemon-client-lease.js';

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('startCronDaemonClientLease registers and unregisters a web UI client', async () => {
  const requests = [];
  let ensureCount = 0;

  const lease = startCronDaemonClientLease({
    clientId: 'webui-1',
    intervalMs: 60_000,
    ensureCronDaemonFn: async () => {
      ensureCount += 1;
    },
    sendCronDaemonRequestFn: async (request) => {
      requests.push(request);
      return {
        ok: true,
        data: {
          type: request.type,
          activeClients: request.type === 'unregister_client' ? 0 : 1
        }
      };
    }
  });

  await tick();
  await lease.stop();

  assert.equal(ensureCount, 1);
  assert.deepEqual(requests, [
    {
      type: 'register_client',
      clientId: 'webui-1',
      clientKind: 'webui',
      processId: process.pid,
      projectRoots: []
    },
    {
      type: 'unregister_client',
      clientId: 'webui-1'
    }
  ]);
});

test('startCronDaemonClientLease includes current project roots in heartbeats', async () => {
  const requests = [];
  let projectRoots = ['/workspace/a'];

  const lease = startCronDaemonClientLease({
    clientId: 'webui-roots',
    intervalMs: 10,
    getProjectRoots: () => projectRoots,
    ensureCronDaemonFn: async () => {},
    sendCronDaemonRequestFn: async (request) => {
      requests.push(request);
      return {
        ok: true,
        data: {
          type: request.type,
          activeClients: request.type === 'unregister_client' ? 0 : 1
        }
      };
    }
  });

  await tick();
  projectRoots = ['/workspace/a', '/workspace/b'];
  await new Promise((resolve) => setTimeout(resolve, 25));
  await lease.stop();

  assert.deepEqual(requests[0], {
    type: 'register_client',
    clientId: 'webui-roots',
    clientKind: 'webui',
    processId: process.pid,
    projectRoots: ['/workspace/a']
  });
  assert.ok(requests.some((request) =>
    request.type === 'client_heartbeat' &&
    request.clientId === 'webui-roots' &&
    request.projectRoots.includes('/workspace/b')
  ));
});
