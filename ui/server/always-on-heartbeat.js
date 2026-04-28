import { promises as fs } from 'fs';
import path from 'path';
import { extractProjectDirectory } from './projects.js';
import { getActiveClaudeSDKSessionDetails } from './claude-sdk.js';
import { sendCronDaemonRequest } from './services/cron-daemon-owner.js';
import {
  getAlwaysOnHeartbeatPath,
  getAlwaysOnHeartbeatsDir,
} from './services/always-on-paths.js';

const wsStates = new Map();

function heartbeatFileName(writerId) {
  return `webui-${writerId}.beat`;
}

function toIso(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function safeProjectRoot(projectName) {
  if (!projectName) return null;
  try {
    return await extractProjectDirectory(projectName);
  } catch {
    return null;
  }
}

async function writeBeat(projectRoot, writerId, body) {
  const dir = getAlwaysOnHeartbeatsDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  void sendCronDaemonRequest({ type: 'register_project', projectRoot }).catch(() => {});
  await fs.writeFile(
    getAlwaysOnHeartbeatPath(projectRoot, heartbeatFileName(writerId)),
    `${JSON.stringify(body, null, 2)}\n`,
    'utf-8',
  );
}

async function removeBeat(projectRoot, writerId) {
  await fs.rm(getAlwaysOnHeartbeatPath(projectRoot, heartbeatFileName(writerId)), {
    force: true,
  }).catch(() => {});
}

function groupActiveSessionsByProjectRoot() {
  const grouped = new Map();
  for (const session of getActiveClaudeSDKSessionDetails()) {
    if (!session.cwd) continue;
    const projectRoot = path.resolve(session.cwd);
    const existing = grouped.get(projectRoot) || [];
    existing.push(session.sessionId);
    grouped.set(projectRoot, existing);
  }
  return grouped;
}

export async function handleAlwaysOnPresence(ws, payload) {
  if (!ws.__alwaysOnWriterId) {
    ws.__alwaysOnWriterId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  const writerId = ws.__alwaysOnWriterId;
  const previous = wsStates.get(writerId) || {
    projectRoots: new Set(),
    lastUserMsgByProjectRoot: new Map(),
  };

  const projectRoot = await safeProjectRoot(payload?.projectName);
  if (projectRoot && payload?.lastUserMsgAt) {
    previous.lastUserMsgByProjectRoot.set(projectRoot, toIso(payload.lastUserMsgAt));
  }

  const activeByProject = groupActiveSessionsByProjectRoot();
  const nextProjectRoots = new Set();
  if (projectRoot) {
    nextProjectRoots.add(projectRoot);
  }
  for (const activeProjectRoot of activeByProject.keys()) {
    nextProjectRoots.add(activeProjectRoot);
  }

  const now = new Date().toISOString();
  for (const nextProjectRoot of nextProjectRoots) {
    const processingSessionIds = activeByProject.get(nextProjectRoot) || [];
    await writeBeat(nextProjectRoot, writerId, {
      schemaVersion: 1,
      writerKind: 'webui',
      writerId,
      writtenAt: now,
      agentBusy: processingSessionIds.length > 0,
      processingSessionIds,
      lastUserMsgAt: previous.lastUserMsgByProjectRoot.get(nextProjectRoot),
    });
  }

  for (const oldProjectRoot of previous.projectRoots) {
    if (!nextProjectRoots.has(oldProjectRoot)) {
      await removeBeat(oldProjectRoot, writerId);
    }
  }

  wsStates.set(writerId, {
    ...previous,
    projectRoots: nextProjectRoots,
  });
}

export async function clearAlwaysOnPresence(ws) {
  const writerId = ws.__alwaysOnWriterId;
  if (!writerId) return;
  const state = wsStates.get(writerId);
  if (!state) return;
  await Promise.all(
    [...state.projectRoots].map(projectRoot => removeBeat(projectRoot, writerId)),
  );
  wsStates.delete(writerId);
}
