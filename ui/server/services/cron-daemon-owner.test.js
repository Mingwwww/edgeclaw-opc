import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  _readCronDaemonOwnerForTest,
  CRON_DAEMON_OWNER_KIND,
  CRON_DAEMON_OWNER_KIND_ENV,
  CRON_DAEMON_OWNER_PROCESS_PID_ENV,
  CRON_DAEMON_OWNER_TOKEN_ENV,
  initializeCronDaemonOwnerEnv,
  persistCurrentCronDaemonOwner,
  shutdownOwnedCronDaemon
} from './cron-daemon-owner.js';

async function writeOwnerFile(rootDir, owner) {
  const dir = path.join(rootDir, 'cron-daemon');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify(owner), 'utf-8');
}

afterEach(async () => {
  if (process.env.CLAUDE_CONFIG_DIR) {
    await fs.rm(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  }
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env[CRON_DAEMON_OWNER_KIND_ENV];
  delete process.env[CRON_DAEMON_OWNER_TOKEN_ENV];
  delete process.env[CRON_DAEMON_OWNER_PROCESS_PID_ENV];
});

test('initializeCronDaemonOwnerEnv populates ownership env vars', async () => {
  const token = initializeCronDaemonOwnerEnv();

  assert.equal(process.env[CRON_DAEMON_OWNER_KIND_ENV], CRON_DAEMON_OWNER_KIND);
  assert.equal(process.env[CRON_DAEMON_OWNER_TOKEN_ENV], token);
  assert.equal(process.env[CRON_DAEMON_OWNER_PROCESS_PID_ENV], String(process.pid));
});

test('persistCurrentCronDaemonOwner writes current owner metadata', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-daemon-owner-'));
  process.env.CLAUDE_CONFIG_DIR = rootDir;
  const token = initializeCronDaemonOwnerEnv();

  await persistCurrentCronDaemonOwner();

  const owner = await _readCronDaemonOwnerForTest();
  assert.equal(owner?.kind, CRON_DAEMON_OWNER_KIND);
  assert.equal(owner?.token, token);
  assert.equal(owner?.processId, process.pid);
});

test('shutdownOwnedCronDaemon only sends shutdown when owner token matches', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-daemon-owner-'));
  process.env.CLAUDE_CONFIG_DIR = rootDir;
  process.env[CRON_DAEMON_OWNER_KIND_ENV] = CRON_DAEMON_OWNER_KIND;
  process.env[CRON_DAEMON_OWNER_TOKEN_ENV] = 'matching-token';
  process.env[CRON_DAEMON_OWNER_PROCESS_PID_ENV] = String(process.pid);

  await writeOwnerFile(rootDir, {
    kind: CRON_DAEMON_OWNER_KIND,
    token: 'matching-token',
    processId: process.pid,
    createdAt: Date.now()
  });

  const requests = [];
  const socketPath = path.join(rootDir, 'cron-daemon.sock');
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const request = JSON.parse(buffer.slice(0, newlineIndex));
      requests.push(request);
      socket.end(JSON.stringify({ ok: true, data: { type: request.type } }) + '\n', () => {
        if (request.type === 'shutdown') {
          server.close();
        }
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    const owner = await _readCronDaemonOwnerForTest();
    assert.equal(owner?.token, 'matching-token');
    assert.equal(await shutdownOwnedCronDaemon(), true);
    assert.deepEqual(requests[0], { type: 'shutdown' });
  } finally {
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('shutdownOwnedCronDaemon skips shutdown when owner token mismatches', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-daemon-owner-'));
  process.env.CLAUDE_CONFIG_DIR = rootDir;
  process.env[CRON_DAEMON_OWNER_KIND_ENV] = CRON_DAEMON_OWNER_KIND;
  process.env[CRON_DAEMON_OWNER_TOKEN_ENV] = 'current-token';

  await writeOwnerFile(rootDir, {
    kind: CRON_DAEMON_OWNER_KIND,
    token: 'different-token',
    createdAt: Date.now()
  });

  assert.equal(await shutdownOwnedCronDaemon(), false);
});
