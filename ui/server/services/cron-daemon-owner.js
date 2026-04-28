import crypto from 'crypto';
import { promises as fs } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

export const CRON_DAEMON_OWNER_KIND = 'claudecodeui-server';
export const CRON_DAEMON_OWNER_KIND_ENV = 'CLOUDCLI_CRON_DAEMON_OWNER_KIND';
export const CRON_DAEMON_OWNER_TOKEN_ENV = 'CLOUDCLI_CRON_DAEMON_OWNER_TOKEN';
export const CRON_DAEMON_OWNER_PROCESS_PID_ENV = 'CLOUDCLI_CRON_DAEMON_OWNER_PROCESS_PID';

function getClaudeConfigHomeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function getCronDaemonOwnerPath() {
  return path.join(getClaudeConfigHomeDir(), 'cron-daemon', 'owner.json');
}

function getCronDaemonSocketPath() {
  return path.join(getClaudeConfigHomeDir(), 'cron-daemon.sock');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function initializeCronDaemonOwnerEnv() {
  if (!process.env[CRON_DAEMON_OWNER_TOKEN_ENV]) {
    process.env[CRON_DAEMON_OWNER_TOKEN_ENV] = crypto.randomUUID();
  }
  process.env[CRON_DAEMON_OWNER_KIND_ENV] = CRON_DAEMON_OWNER_KIND;
  process.env[CRON_DAEMON_OWNER_PROCESS_PID_ENV] = String(process.pid);
  return process.env[CRON_DAEMON_OWNER_TOKEN_ENV];
}

export async function persistCurrentCronDaemonOwner() {
  const kind = process.env[CRON_DAEMON_OWNER_KIND_ENV];
  const token = process.env[CRON_DAEMON_OWNER_TOKEN_ENV];
  if (!kind || !token) {
    throw new Error('Cron daemon owner environment is not initialized');
  }

  const ownerPath = getCronDaemonOwnerPath();
  await fs.mkdir(path.dirname(ownerPath), { recursive: true });
  await fs.writeFile(
    ownerPath,
    JSON.stringify({
      kind,
      token,
      processId: process.pid,
      createdAt: Date.now()
    }, null, 2) + '\n',
    'utf-8'
  );
}

async function readCronDaemonOwner() {
  try {
    const raw = await fs.readFile(getCronDaemonOwnerPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.kind !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function isCurrentProcessCronDaemonOwner(owner) {
  return Boolean(
    owner &&
    owner.kind === process.env[CRON_DAEMON_OWNER_KIND_ENV] &&
    owner.token === process.env[CRON_DAEMON_OWNER_TOKEN_ENV]
  );
}

function sendCronDaemonRequest(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getCronDaemonSocketPath());
    let settled = false;
    let buffer = '';
    let timeout = null;

    const finalize = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      socket.destroy();
      callback(value);
    };

    timeout = setTimeout(() => {
      finalize(reject, new Error('Timed out waiting for Cron daemon response'));
    }, 1000);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      try {
        finalize(resolve, JSON.parse(line));
      } catch (error) {
        finalize(reject, error);
      }
    });

    socket.on('error', (error) => {
      finalize(reject, error);
    });
  });
}

function isCronDaemonUnavailableError(error) {
  return Boolean(
    error instanceof Error &&
    (
      ('code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) ||
      error.message.includes('closed') ||
      error.message.includes('socket hang up')
    )
  );
}

export async function waitForCronDaemonShutdown({
  sendCronDaemonRequestFn = sendCronDaemonRequest,
  sleepFn = sleep,
  timeoutMs = 5000,
  intervalMs = 100
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await sendCronDaemonRequestFn({ type: 'ping' });
    } catch (error) {
      if (isCronDaemonUnavailableError(error)) {
        return true;
      }
    }
    await sleepFn(intervalMs);
  }
  return false;
}

export async function shutdownOwnedCronDaemon() {
  const owner = await readCronDaemonOwner();
  if (!isCurrentProcessCronDaemonOwner(owner)) {
    return false;
  }

  try {
    const response = await sendCronDaemonRequest({ type: 'shutdown' });
    if (!response?.ok) {
      return false;
    }
    return await waitForCronDaemonShutdown();
  } catch {
    return false;
  }
}

export async function _readCronDaemonOwnerForTest() {
  return await readCronDaemonOwner();
}

export {
  sendCronDaemonRequest
};
