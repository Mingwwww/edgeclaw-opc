import crypto from 'crypto';
import { sendCronDaemonRequest } from './cron-daemon-owner.js';

const CLIENT_LEASE_TTL_MS = 30_000;
const CLIENT_LEASE_HEARTBEAT_MS = 5_000;

let clientId = null;
let heartbeatTimer = null;
let registered = false;

function getClientId() {
  if (!clientId) {
    clientId = `web-ui:${process.pid}:${crypto.randomUUID()}`;
  }
  return clientId;
}

export async function startCronDaemonClientLease({
  sendCronDaemonRequestFn = sendCronDaemonRequest,
  setIntervalFn = setInterval,
  ttlMs = CLIENT_LEASE_TTL_MS,
  heartbeatMs = CLIENT_LEASE_HEARTBEAT_MS
} = {}) {
  if (registered) {
    return clientId;
  }

  const id = getClientId();
  const response = await sendCronDaemonRequestFn({
    type: 'register_client',
    clientId: id,
    clientType: 'web-ui',
    processId: process.pid,
    ttlMs
  });
  if (!response?.ok || response.data?.type !== 'register_client') {
    throw new Error(response?.error || 'Cron daemon client registration failed');
  }

  registered = true;
  heartbeatTimer = setIntervalFn(() => {
    void sendCronDaemonRequestFn({
      type: 'heartbeat_client',
      clientId: id,
      ttlMs
    }).catch(() => {});
  }, heartbeatMs);
  heartbeatTimer?.unref?.();
  return id;
}

export async function stopCronDaemonClientLease({
  sendCronDaemonRequestFn = sendCronDaemonRequest,
  clearIntervalFn = clearInterval
} = {}) {
  if (heartbeatTimer) {
    clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (!registered || !clientId) {
    return false;
  }

  const id = clientId;
  registered = false;
  clientId = null;
  try {
    await sendCronDaemonRequestFn({
      type: 'unregister_client',
      clientId: id
    });
    return true;
  } catch {
    return false;
  }
}

export function _resetCronDaemonClientLeaseForTest() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  clientId = null;
  heartbeatTimer = null;
  registered = false;
}
