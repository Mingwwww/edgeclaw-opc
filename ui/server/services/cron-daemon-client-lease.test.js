import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  _resetCronDaemonClientLeaseForTest,
  startCronDaemonClientLease,
  stopCronDaemonClientLease
} from './cron-daemon-client-lease.js';

afterEach(() => {
  _resetCronDaemonClientLeaseForTest();
});

test('startCronDaemonClientLease registers and heartbeats a web-ui client', async () => {
  const requests = [];
  let intervalCallback = null;

  const clientId = await startCronDaemonClientLease({
    sendCronDaemonRequestFn: async (request) => {
      requests.push(request);
      return {
        ok: true,
        data: {
          type: request.type,
          registered: true,
          leaseExpiresAt: Date.now() + 30_000
        }
      };
    },
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return { unref() {} };
    }
  });

  assert.match(clientId, /^web-ui:/);
  assert.equal(requests[0].type, 'register_client');
  assert.equal(requests[0].clientType, 'web-ui');

  intervalCallback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1].type, 'heartbeat_client');
  assert.equal(requests[1].clientId, clientId);
});

test('stopCronDaemonClientLease unregisters the web-ui client', async () => {
  const requests = [];

  await startCronDaemonClientLease({
    sendCronDaemonRequestFn: async (request) => {
      requests.push(request);
      return {
        ok: true,
        data: {
          type: request.type,
          registered: true,
          leaseExpiresAt: Date.now() + 30_000
        }
      };
    },
    setIntervalFn: () => ({ unref() {} })
  });

  assert.equal(await stopCronDaemonClientLease({
    sendCronDaemonRequestFn: async (request) => {
      requests.push(request);
      return {
        ok: true,
        data: {
          type: 'unregister_client',
          remainingClients: 0
        }
      };
    },
    clearIntervalFn: () => {}
  }), true);

  assert.equal(requests.at(-1).type, 'unregister_client');
});
