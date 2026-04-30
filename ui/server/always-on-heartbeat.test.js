import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { createAlwaysOnHeartbeatManager } from './always-on-heartbeat.js';

test('always-on heartbeat writes and registers all opted-in workspace roots', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'always-on-heartbeat-'));
  const projectA = path.join(tmpDir, 'project-a');
  const projectB = path.join(tmpDir, 'project-b');
  const projectC = path.join(tmpDir, 'project-c');
  await Promise.all([projectA, projectB, projectC].map((dir) => fs.mkdir(dir, { recursive: true })));

  const registered = [];
  const ws = {};
  const manager = createAlwaysOnHeartbeatManager({
    getActiveClaudeSessions: () => [
      { cwd: projectB, sessionId: 'session-b' },
      { cwd: projectC, sessionId: 'session-c' }
    ],
    registerProjectFn: async (projectRoot) => {
      registered.push(projectRoot);
    }
  });

  try {
    const roots = await manager.handlePresence(ws, {
      selectedProject: { name: 'project-a', fullPath: projectA },
      alwaysOnProjects: [
        { name: 'project-a', fullPath: projectA },
        { name: 'project-b', fullPath: projectB }
      ],
      lastUserMsgAt: '2026-04-30T06:00:00.000Z'
    });

    assert.deepEqual(new Set(roots), new Set([projectA, projectB]));
    assert.deepEqual(new Set(manager.getProjectRoots(ws)), new Set([projectA, projectB]));
    assert.deepEqual(new Set(registered), new Set([projectA, projectB]));

    const beatA = JSON.parse(await fs.readFile(
      path.join(projectA, '.claude', 'always-on', 'heartbeats', `webui-${manager.getWriterId(ws)}.beat`),
      'utf8'
    ));
    const beatB = JSON.parse(await fs.readFile(
      path.join(projectB, '.claude', 'always-on', 'heartbeats', `webui-${manager.getWriterId(ws)}.beat`),
      'utf8'
    ));

    assert.equal(beatA.agentBusy, false);
    assert.equal(beatA.lastUserMsgAt, '2026-04-30T06:00:00.000Z');
    assert.equal(beatB.agentBusy, true);
    assert.deepEqual(beatB.processingSessionIds, ['session-b']);
    await assert.rejects(
      fs.access(path.join(projectC, '.claude', 'always-on', 'heartbeats'))
    );

    await manager.clearPresence(ws);
    assert.deepEqual(manager.getProjectRoots(ws), []);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
