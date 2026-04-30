import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendAlwaysOnRunEvent,
  getAlwaysOnRunHistory,
  getAlwaysOnRunHistoryDetail,
  getRunHistoryPath,
} from './always-on-run-history.js';
import { appendAlwaysOnRunLog } from './always-on-run-logs.js';

const tempDirs = [];
const priorHome = process.env.HOME;

async function createTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (priorHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = priorHome;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createProjectStore(projectName) {
  const homeDir = await createTempDir('always-on-run-history-home-');
  process.env.HOME = homeDir;
  const projectDir = path.join(homeDir, '.claude', 'projects', projectName);
  await fs.mkdir(projectDir, { recursive: true });
  return { homeDir, projectDir };
}

async function writeJsonl(filePath, entries) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

test('run history appends events and folds them by run id', async () => {
  const projectRoot = await createTempDir('always-on-run-history-');

  await appendAlwaysOnRunEvent(projectRoot, {
    runId: 'run-1',
    kind: 'plan',
    sourceId: 'plan-alpha',
    title: 'Plan Alpha',
    status: 'queued',
    timestamp: '2026-04-20T10:00:00.000Z',
    metadata: { source: 'manual' },
  });
  await appendAlwaysOnRunEvent(projectRoot, {
    runId: 'run-1',
    kind: 'plan',
    sourceId: 'plan-alpha',
    title: 'Plan Alpha',
    status: 'completed',
    timestamp: '2026-04-20T10:05:00.000Z',
    finishedAt: '2026-04-20T10:05:00.000Z',
    sessionId: 'session-1',
    output: 'Done.',
    metadata: { planFilePath: '.claude/always-on/plans/plan-alpha.md' },
  });
  await fs.appendFile(getRunHistoryPath(projectRoot), 'not json\n', 'utf8');

  const history = await getAlwaysOnRunHistory(projectRoot);
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].runId, 'run-1');
  assert.equal(history.runs[0].status, 'completed');
  assert.equal(history.runs[0].sourceId, 'plan-alpha');
  assert.equal(history.runs[0].session?.sessionId, 'session-1');

  const detail = await getAlwaysOnRunHistoryDetail(projectRoot, 'run-1');
  assert.match(detail.outputLog, /Done/);
  assert.equal(detail.metadata.source, 'manual');
  assert.equal(detail.metadata.planFilePath, '.claude/always-on/plans/plan-alpha.md');
});

test('run history detail returns not found for unknown run id', async () => {
  const projectRoot = await createTempDir('always-on-run-history-missing-');
  await assert.rejects(
    () => getAlwaysOnRunHistoryDetail(projectRoot, 'missing-run'),
    /Run history entry not found/,
  );
});

test('run history derives background session id from transcript path', async () => {
  const projectRoot = await createTempDir('always-on-run-history-session-id-');

  await appendAlwaysOnRunEvent(projectRoot, {
    runId: 'run-cron',
    kind: 'cron',
    sourceId: 'cron-alpha',
    title: 'Cron Alpha',
    status: 'completed',
    timestamp: '2026-04-20T10:00:00.000Z',
    parentSessionId: 'origin-session',
    relativeTranscriptPath: 'origin-session/subagents/agent-cron-thread.jsonl',
  });

  const history = await getAlwaysOnRunHistory(projectRoot);
  assert.equal(history.runs[0].session?.sessionId, 'background-origin-session-agent-cron-thread');

  const detail = await getAlwaysOnRunHistoryDetail(projectRoot, 'run-cron');
  assert.equal(detail.session?.sessionId, 'background-origin-session-agent-cron-thread');
  assert.equal(detail.metadata.sessionId, 'background-origin-session-agent-cron-thread');
});

test('run history derives background session fields from metadata', async () => {
  const projectRoot = await createTempDir('always-on-run-history-metadata-session-');

  await appendAlwaysOnRunEvent(projectRoot, {
    runId: 'run-cron-metadata',
    kind: 'cron',
    sourceId: 'cron-beta',
    title: 'Cron Beta',
    status: 'completed',
    timestamp: '2026-04-20T10:00:00.000Z',
    metadata: {
      originSessionId: 'origin-session',
      transcriptKey: 'cron-thread-raw',
    },
  });

  const detail = await getAlwaysOnRunHistoryDetail(projectRoot, 'run-cron-metadata');
  assert.equal(detail.session?.sessionId, 'background-origin-session-agent-cron-thread-raw');
  assert.equal(detail.session?.parentSessionId, 'origin-session');
  assert.equal(detail.session?.relativeTranscriptPath, 'origin-session/subagents/agent-cron-thread-raw.jsonl');
  assert.equal(detail.metadata.sessionId, 'background-origin-session-agent-cron-thread-raw');
});

test('run history recovers legacy one-shot session from task notification output', async () => {
  const projectRoot = await createTempDir('always-on-run-history-notification-');
  const projectName = 'project-with-notification';
  const parentSessionId = 'origin-session';
  const transcriptFilename = 'agent-cron-shot-abc123.jsonl';
  const { projectDir } = await createProjectStore(projectName);
  const transcriptPath = path.join(projectDir, parentSessionId, 'subagents', transcriptFilename);

  await writeJsonl(path.join(projectDir, `${parentSessionId}.jsonl`), [
    {
      type: 'user',
      sessionId: parentSessionId,
      timestamp: '2026-04-20T10:02:00.000Z',
      message: {
        role: 'user',
        content: `<task-notification>
<task-id>cron-run-runtime</task-id>
<output-file>${transcriptPath}</output-file>
<status>completed</status>
<summary>Cron task "One-shot cron cron-legacy" completed</summary>
</task-notification>`,
      },
    },
  ]);
  await writeJsonl(transcriptPath, [
    {
      type: 'user',
      isSidechain: true,
      timestamp: '2026-04-20T10:00:00.000Z',
      message: { role: 'user', content: 'Run once' },
    },
  ]);
  await appendAlwaysOnRunEvent(projectRoot, {
    runId: 'run-legacy',
    kind: 'cron',
    sourceId: 'cron-legacy',
    title: 'Legacy one-shot',
    status: 'completed',
    timestamp: '2026-04-20T10:02:00.000Z',
    startedAt: '2026-04-20T10:00:00.000Z',
    finishedAt: '2026-04-20T10:02:00.000Z',
    parentSessionId,
    metadata: { taskId: 'cron-legacy', originSessionId: parentSessionId },
  });

  const detail = await getAlwaysOnRunHistoryDetail(projectRoot, 'run-legacy', { projectName });
  assert.equal(detail.session?.sessionId, 'background-origin-session-agent-cron-shot-abc123');
  assert.equal(detail.session?.relativeTranscriptPath, `${parentSessionId}/subagents/${transcriptFilename}`);
  assert.equal(detail.metadata.sessionId, 'background-origin-session-agent-cron-shot-abc123');
});

test('run history recovers legacy one-shot session by scanning subagents timestamps', async () => {
  const projectRoot = await createTempDir('always-on-run-history-scan-');
  const projectName = 'project-with-scan';
  const parentSessionId = 'origin-session';
  const transcriptFilename = 'agent-cron-shot-nearby.jsonl';
  const { projectDir } = await createProjectStore(projectName);
  const transcriptPath = path.join(projectDir, parentSessionId, 'subagents', transcriptFilename);

  await writeJsonl(transcriptPath, [
    {
      type: 'user',
      isSidechain: true,
      timestamp: '2026-04-20T10:00:30.000Z',
      message: { role: 'user', content: 'Nearby cron' },
    },
  ]);
  await appendAlwaysOnRunEvent(projectRoot, {
    runId: 'run-scan',
    kind: 'cron',
    sourceId: 'cron-scan',
    title: 'Scan one-shot',
    status: 'completed',
    timestamp: '2026-04-20T10:01:00.000Z',
    startedAt: '2026-04-20T10:00:00.000Z',
    finishedAt: '2026-04-20T10:01:00.000Z',
    parentSessionId,
    metadata: { taskId: 'cron-scan', originSessionId: parentSessionId },
  });

  const detail = await getAlwaysOnRunHistoryDetail(projectRoot, 'run-scan', { projectName });
  assert.equal(detail.session?.sessionId, 'background-origin-session-agent-cron-shot-nearby');
  assert.equal(detail.metadata.relativeTranscriptPath, `${parentSessionId}/subagents/${transcriptFilename}`);
});

test('run history detail prefers dedicated log file over history output', async () => {
  const projectRoot = await createTempDir('always-on-run-history-log-');

  await appendAlwaysOnRunEvent(projectRoot, {
    runId: 'run-log',
    kind: 'plan',
    sourceId: 'plan-log',
    title: 'Plan Log',
    status: 'completed',
    timestamp: '2026-04-20T10:00:00.000Z',
    output: 'history output',
  });
  await appendAlwaysOnRunLog(projectRoot, 'run-log', 'dedicated log output');

  const detail = await getAlwaysOnRunHistoryDetail(projectRoot, 'run-log');
  assert.equal(detail.outputLog, 'dedicated log output\n');
  assert.equal(detail.metadata.logSource, 'log-file');
  assert.equal(detail.metadata.logSize, 'dedicated log output\n'.length);
});

test('run history detail falls back to history output without log file', async () => {
  const projectRoot = await createTempDir('always-on-run-history-fallback-');

  await appendAlwaysOnRunEvent(projectRoot, {
    runId: 'run-fallback',
    kind: 'plan',
    sourceId: 'plan-fallback',
    title: 'Plan Fallback',
    status: 'failed',
    timestamp: '2026-04-20T10:00:00.000Z',
    output: 'history fallback output',
  });

  const detail = await getAlwaysOnRunHistoryDetail(projectRoot, 'run-fallback');
  assert.equal(detail.outputLog, 'history fallback output');
  assert.equal(detail.metadata.logSource, 'history');
});

test('run history list filters unknown status entries', async () => {
  const projectRoot = await createTempDir('always-on-run-history-unknown-');

  await appendAlwaysOnRunEvent(projectRoot, {
    runId: 'run-visible',
    kind: 'cron',
    sourceId: 'cron-visible',
    title: 'Visible run',
    status: 'completed',
    timestamp: '2026-04-20T10:00:00.000Z',
  });
  await appendAlwaysOnRunEvent(projectRoot, {
    runId: 'run-hidden',
    kind: 'cron',
    sourceId: 'cron-hidden',
    title: 'Hidden run',
    status: 'unknown',
    timestamp: '2026-04-20T10:01:00.000Z',
  });

  const history = await getAlwaysOnRunHistory(projectRoot);
  assert.deepEqual(history.runs.map((run) => run.runId), ['run-visible']);

  const detail = await getAlwaysOnRunHistoryDetail(projectRoot, 'run-hidden');
  assert.equal(detail.status, 'unknown');
});
