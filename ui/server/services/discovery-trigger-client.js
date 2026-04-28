import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { sendCronDaemonRequest } from './cron-daemon-owner.js';

function getClaudeConfigHomeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function getDiscoveryRequestDir() {
  return path.join(getClaudeConfigHomeDir(), 'cron-daemon', 'discovery-requests');
}

function getDiscoveryRequestPath(fileName) {
  return path.join(getDiscoveryRequestDir(), fileName);
}

async function readRequests() {
  let names = [];
  try {
    names = (await fs.readdir(getDiscoveryRequestDir()))
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }

  const requests = [];
  for (const fileName of names) {
    try {
      const parsed = JSON.parse(await fs.readFile(getDiscoveryRequestPath(fileName), 'utf-8'));
      if (parsed?.type === 'discovery_fire_request' && parsed.requestId) {
        requests.push({ ...parsed, fileName });
      }
    } catch {
      // Ignore malformed transient files.
    }
  }
  return requests;
}

async function removeRequest(fileName) {
  await fs.rm(getDiscoveryRequestPath(fileName), { force: true }).catch(() => {});
}

export function startDiscoveryTriggerClient({ getWebSocketByWriterId }) {
  const poll = async () => {
    const requests = await readRequests();
    for (const request of requests) {
      if (request.targetWriterKind !== 'webui') {
        continue;
      }
      const ws = getWebSocketByWriterId(request.targetWriterId);
      if (!ws || ws.readyState !== 1) {
        await completeDiscoveryFire(
          request.requestId,
          request.projectRoot,
          'failed',
          'Target Web UI client is no longer connected'
        ).catch(() => {});
        await removeRequest(request.fileName);
        continue;
      }
      ws.send(JSON.stringify({
        type: 'always-on-auto-discovery-start',
        requestId: request.requestId,
        projectRoot: request.projectRoot,
      }));
      await removeRequest(request.fileName);
    }
  };

  const interval = setInterval(() => {
    void poll();
  }, 1000);
  void poll();
  return () => clearInterval(interval);
}

export async function completeDiscoveryFire(requestId, projectRoot, result, errorMessage) {
  return await sendCronDaemonRequest({
    type: 'discovery_fire_complete',
    requestId,
    projectRoot,
    result,
    ...(errorMessage ? { errorMessage } : {}),
  });
}
