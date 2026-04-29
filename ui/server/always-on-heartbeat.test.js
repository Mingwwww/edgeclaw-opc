import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAlwaysOnHeartbeatManager } from './always-on-heartbeat.js';

const tempDirs = [];

async function createTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readOnlyBeat(projectRoot) {
  const dir = path.join(projectRoot, '.claude', 'always-on', 'heartbeats');
  const entries = await fs.readdir(dir);
  assert.equal(entries.length, 1);
  const raw = await fs.readFile(path.join(dir, entries[0]), 'utf8');
  return {
    filePath: path.join(dir, entries[0]),
    beat: JSON.parse(raw),
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writes a Web UI heartbeat for the selected project', async () => {
  const projectRoot = await createTempDir('always-on-webui-project-');
  const ws = {};
  const manager = createAlwaysOnHeartbeatManager();

  await manager.handlePresence(ws, {
    selectedProject: { projectRoot },
    lastUserMsgAt: '2026-04-29T00:00:00.000Z',
  });

  const { filePath, beat } = await readOnlyBeat(projectRoot);
  assert.equal(beat.schemaVersion, 1);
  assert.equal(beat.writerKind, 'webui');
  assert.equal(beat.writerId, manager.getWriterId(ws));
  assert.equal(beat.agentBusy, false);
  assert.deepEqual(beat.processingSessionIds, []);
  assert.equal(beat.lastUserMsgAt, '2026-04-29T00:00:00.000Z');

  await manager.clearPresence(ws);
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
});

test('marks projects with active Claude sessions as busy', async () => {
  const selectedRoot = await createTempDir('always-on-selected-project-');
  const activeRoot = await createTempDir('always-on-active-project-');
  const ws = {};
  const manager = createAlwaysOnHeartbeatManager({
    getActiveClaudeSessions: () => [
      {
        cwd: activeRoot,
        sessionId: 'session-active-1',
      },
    ],
  });

  await manager.handlePresence(ws, {
    selectedProject: { projectRoot: selectedRoot },
    lastUserMsgAt: '',
  });

  const selected = await readOnlyBeat(selectedRoot);
  const active = await readOnlyBeat(activeRoot);

  assert.equal(selected.beat.agentBusy, false);
  assert.deepEqual(selected.beat.processingSessionIds, []);
  assert.equal(selected.beat.lastUserMsgAt, null);

  assert.equal(active.beat.agentBusy, true);
  assert.deepEqual(active.beat.processingSessionIds, ['session-active-1']);
});
