import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  clearProjectDirectoryCache,
  deleteSession,
  getProjectCronJobsOverview,
  getProjects,
  getSessions
} from './projects.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalEdgeClawConfigPath = process.env.EDGECLAW_CONFIG_PATH;
const tempDirs = [];

async function createTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createTempHome() {
  const homeDir = await createTempDir('projects-cron-jobs-');
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  clearProjectDirectoryCache();
  return homeDir;
}

async function writeProjectConfig(homeDir, projectName, projectRoot) {
  const claudeDir = path.join(homeDir, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, 'project-config.json'),
    JSON.stringify({
      [projectName]: {
        manuallyAdded: true,
        originalPath: projectRoot
      }
    }, null, 2),
    'utf8'
  );
}

async function writeScheduledTasks(projectRoot, tasks) {
  const configDir = path.join(projectRoot, '.claude');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'scheduled_tasks.json'),
    JSON.stringify({ tasks }, null, 2),
    'utf8'
  );
}

async function writeSessionScheduledTasks(projectRoot, tasks) {
  const configDir = path.join(projectRoot, '.claude');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'session_scheduled_tasks.json'),
    JSON.stringify({ tasks }, null, 2),
    'utf8'
  );
}

async function writeJsonl(filePath, entries) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8'
  );
}

function createTaskNotification({ taskId, outputFile, status, summary }) {
  return `<task-notification>
<task-id>${taskId}</task-id>
<output-file>${outputFile}</output-file>
<status>${status}</status>
<summary>${summary}</summary>
</task-notification>`;
}

async function createBackgroundCronArtifacts({
  homeDir,
  projectName,
  parentSessionId,
  transcriptFileName,
  status,
  summary
}) {
  const projectStoreDir = path.join(homeDir, '.claude', 'projects', projectName);
  const transcriptPath = path.join(projectStoreDir, parentSessionId, 'subagents', transcriptFileName);

  await writeJsonl(transcriptPath, [
    {
      timestamp: '2026-04-19T10:00:00.000Z',
      message: {
        role: 'user',
        content: 'Investigate the queue backlog'
      }
    },
    {
      timestamp: '2026-04-19T10:02:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Background run complete.' }]
      }
    }
  ]);

  await writeJsonl(path.join(projectStoreDir, 'history.jsonl'), [
    {
      sessionId: parentSessionId,
      timestamp: '2026-04-19T10:03:00.000Z',
      message: {
        role: 'user',
        content: createTaskNotification({
          taskId: `task-${status}`,
          outputFile: transcriptPath,
          status,
          summary
        })
      }
    }
  ]);

  return transcriptPath;
}

async function withCronDaemonServer(configDir, responder, callback) {
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const socketPath = path.join(configDir, 'cron-daemon.sock');
  const requests = [];
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
      socket.end(`${JSON.stringify(responder(request))}\n`);
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
    await callback(requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

afterEach(async () => {
  clearProjectDirectoryCache();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }

  if (originalEdgeClawConfigPath === undefined) {
    delete process.env.EDGECLAW_CONFIG_PATH;
  } else {
    process.env.EDGECLAW_CONFIG_PATH = originalEdgeClawConfigPath;
  }
});

test('getProjectCronJobsOverview returns an empty list when scheduled_tasks.json is missing', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-without-scheduled-tasks';
  const projectRoot = path.join(homeDir, 'workspace-no-cron');

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);

  const overview = await getProjectCronJobsOverview(projectName);

  assert.deepEqual(overview, { jobs: [] });
});

test('getProjects includes per-project always-on discovery trigger setting', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-with-always-on';
  const projectRoot = path.join(homeDir, 'workspace-always-on');
  process.env.EDGECLAW_CONFIG_PATH = path.join(homeDir, '.edgeclaw', 'config.yaml');

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await fs.mkdir(path.dirname(process.env.EDGECLAW_CONFIG_PATH), { recursive: true });
  await fs.writeFile(
    process.env.EDGECLAW_CONFIG_PATH,
    [
      'models:',
      '  providers:',
      '    edgeclaw:',
      '      type: openai-chat',
      '      baseUrl: http://localhost',
      '      apiKey: test-key',
      '  entries:',
      '    default:',
      '      provider: edgeclaw',
      '      name: test-model',
      'agents:',
      '  main:',
      '    model: default',
      'alwaysOn:',
      '  discovery:',
      '    projects:',
      `      ${JSON.stringify(projectRoot)}:`,
      '        enabled: true',
      ''
    ].join('\n'),
    'utf8'
  );

  const projects = await getProjects();
  const project = projects.find((candidate) => candidate.name === projectName);

  assert.equal(project?.alwaysOn?.discovery?.triggerEnabled, true);
});

test('getProjectCronJobsOverview marks unmatched cron jobs as scheduled', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-with-scheduled-cron-only';
  const projectRoot = path.join(homeDir, 'workspace-scheduled-only');

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeScheduledTasks(projectRoot, [
    {
      id: 'cron-1234',
      cron: '0 * * * *',
      prompt: 'Check the queue depth',
      createdAt: 1713510000000,
      recurring: true,
      originSessionId: 'origin-session-1'
    }
  ]);

  const overview = await getProjectCronJobsOverview(projectName);

  assert.equal(overview.jobs.length, 1);
  assert.equal(overview.jobs[0].status, 'scheduled');
  assert.equal(overview.jobs[0].latestRun, null);
  assert.equal(overview.jobs[0].durable, true);
  assert.equal(overview.jobs[0].originSessionId, 'origin-session-1');
});

test('getProjectCronJobsOverview returns session-only one-shot jobs before they fire', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-with-session-only-cron';
  const projectRoot = path.join(homeDir, 'workspace-session-only');
  const createdAt = Date.now();

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeSessionScheduledTasks(projectRoot, [
    {
      id: 'cron-session-1234',
      cron: '* * * * *',
      prompt: 'Stand up and stretch',
      createdAt,
      originSessionId: 'origin-session-session-only'
    }
  ]);

  const overview = await getProjectCronJobsOverview(projectName);

  assert.equal(overview.jobs.length, 1);
  assert.equal(overview.jobs[0].id, 'cron-session-1234');
  assert.equal(overview.jobs[0].durable, false);
  assert.equal(overview.jobs[0].recurring, undefined);
  assert.equal(overview.jobs[0].status, 'scheduled');
  assert.equal(overview.jobs[0].latestRun, null);
});

test('getProjectCronJobsOverview keeps manual-only proposal jobs visible after their cron window passes', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-with-manual-only-cron';
  const projectRoot = path.join(homeDir, 'workspace-manual-only');

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeSessionScheduledTasks(projectRoot, [
    {
      id: 'cron-manual-only',
      cron: '0 9 1 1 *',
      prompt: 'Follow up on the stale TODOs',
      createdAt: 0,
      manualOnly: true,
      originSessionId: 'origin-session-manual-only'
    }
  ]);

  const overview = await getProjectCronJobsOverview(projectName);

  assert.equal(overview.jobs.length, 1);
  assert.equal(overview.jobs[0].id, 'cron-manual-only');
  assert.equal(overview.jobs[0].manualOnly, true);
  assert.equal(overview.jobs[0].status, 'scheduled');
});

test('getProjectCronJobsOverview merges durable and session-only cron jobs', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-with-mixed-crons';
  const projectRoot = path.join(homeDir, 'workspace-mixed-crons');
  const sessionCreatedAt = Date.now();

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeScheduledTasks(projectRoot, [
    {
      id: 'cron-durable-1234',
      cron: '0 * * * *',
      prompt: 'Check durable queue depth',
      createdAt: 1713510000000,
      recurring: true,
      originSessionId: 'origin-session-durable'
    }
  ]);
  await writeSessionScheduledTasks(projectRoot, [
    {
      id: 'cron-session-5678',
      cron: '* * * * *',
      prompt: 'Check session queue depth',
      createdAt: sessionCreatedAt,
      originSessionId: 'origin-session-session'
    }
  ]);

  const overview = await getProjectCronJobsOverview(projectName);
  const jobsById = new Map(overview.jobs.map((job) => [job.id, job]));

  assert.equal(overview.jobs.length, 2);
  assert.equal(jobsById.get('cron-durable-1234')?.durable, true);
  assert.equal(jobsById.get('cron-durable-1234')?.status, 'scheduled');
  assert.equal(jobsById.get('cron-session-5678')?.durable, false);
  assert.equal(jobsById.get('cron-session-5678')?.status, 'scheduled');
});

test('getProjectCronJobsOverview matches recurring cron jobs to completed background sessions via transcriptKey', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-with-completed-cron';
  const projectRoot = path.join(homeDir, 'workspace-completed');
  const parentSessionId = 'parent-session-completed';
  const transcriptFileName = 'agent-cron-completed.jsonl';
  const taskTranscriptKey = 'cron-completed';

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await createBackgroundCronArtifacts({
    homeDir,
    projectName,
    parentSessionId,
    transcriptFileName,
    status: 'completed',
    summary: 'Cron task "Recurring cron cron-5678" completed'
  });
  await writeScheduledTasks(projectRoot, [
    {
      id: 'cron-5678',
      cron: '*/15 * * * *',
      prompt: 'Review incoming support spikes',
      createdAt: 1713511000000,
      lastFiredAt: 1713512000000,
      recurring: true,
      originSessionId: parentSessionId,
      transcriptKey: taskTranscriptKey
    }
  ]);

  const overview = await getProjectCronJobsOverview(projectName);

  assert.equal(overview.jobs.length, 1);
  assert.equal(overview.jobs[0].status, 'completed');
  assert.equal(overview.jobs[0].transcriptKey, taskTranscriptKey);
  assert.equal(
    overview.jobs[0].latestRun?.sessionId,
    `background-${parentSessionId}-agent-cron-completed`
  );
  assert.equal(overview.jobs[0].latestRun?.parentSessionId, parentSessionId);
  assert.equal(overview.jobs[0].latestRun?.transcriptKey, transcriptFileName);
  assert.equal(overview.jobs[0].latestRun?.summary, 'Cron task "Recurring cron cron-5678" completed');
  assert.equal(
    overview.jobs[0].latestRun?.relativeTranscriptPath,
    `${parentSessionId}/subagents/${transcriptFileName}`
  );
});

test('deleteSession removes background cron transcript files', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-with-deleted-cron-transcript';
  const projectRoot = path.join(homeDir, 'workspace-delete-cron-transcript');
  const parentSessionId = 'parent-session-delete';
  const transcriptFileName = 'agent-cron-delete.jsonl';
  const taskTranscriptKey = 'cron-delete';
  const backgroundSessionId = `background-${parentSessionId}-agent-cron-delete`;

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  const transcriptPath = await createBackgroundCronArtifacts({
    homeDir,
    projectName,
    parentSessionId,
    transcriptFileName,
    status: 'completed',
    summary: 'Cron task "Recurring cron cron-delete" completed'
  });
  await writeScheduledTasks(projectRoot, [
    {
      id: 'cron-delete',
      cron: '*/15 * * * *',
      prompt: 'Review incoming support spikes',
      createdAt: 1713511000000,
      lastFiredAt: 1713512000000,
      recurring: true,
      originSessionId: parentSessionId,
      transcriptKey: taskTranscriptKey
    }
  ]);

  const beforeDelete = await getSessions(projectName, Number.MAX_SAFE_INTEGER, 0);
  assert.ok(beforeDelete.sessions.some((session) => session.id === backgroundSessionId));

  await deleteSession(projectName, backgroundSessionId, {
    sessionKind: 'background_task',
    parentSessionId,
    relativeTranscriptPath: `${parentSessionId}/subagents/${transcriptFileName}`
  });

  await assert.rejects(fs.access(transcriptPath), { code: 'ENOENT' });

  const afterDelete = await getSessions(projectName, Number.MAX_SAFE_INTEGER, 0);
  assert.ok(!afterDelete.sessions.some((session) => session.id === backgroundSessionId));

  const overview = await getProjectCronJobsOverview(projectName);
  assert.equal(overview.jobs.length, 1);
  assert.equal(overview.jobs[0].latestRun, null);

  await deleteSession(projectName, backgroundSessionId, {
    sessionKind: 'background_task',
    parentSessionId,
    relativeTranscriptPath: `${parentSessionId}/subagents/${transcriptFileName}`
  });
});

test('getSessions counts displayable read-only cron transcript records', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-with-readonly-cron-count';
  const projectRoot = path.join(homeDir, 'workspace-readonly-cron-count');
  const projectStoreDir = path.join(homeDir, '.claude', 'projects', projectName);
  const parentSessionId = 'parent-session-readonly';
  const transcriptFileName = 'agent-cron-readonly.jsonl';
  const transcriptPath = path.join(projectStoreDir, parentSessionId, 'subagents', transcriptFileName);

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeJsonl(transcriptPath, [
    {
      uuid: 'cron-trigger',
      timestamp: '2026-04-19T10:00:00.000Z',
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content: '提醒用户：该站起来活动一下了！'
      }
    },
    {
      uuid: 'cron-system-error',
      timestamp: '2026-04-19T10:00:01.000Z',
      type: 'system',
      subtype: 'api_error',
      cause: {
        code: 'ConnectionRefused',
        path: 'http://ccr.local/v1/messages?beta=true'
      },
      retryAttempt: 1,
      maxRetries: 10
    },
    {
      uuid: 'cron-synthetic-error',
      timestamp: '2026-04-19T10:00:02.000Z',
      type: 'assistant',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [
          {
            type: 'text',
            text: 'API Error: Unable to connect to API (ConnectionRefused)'
          }
        ]
      }
    }
  ]);

  const sessionsResult = await getSessions(projectName, Number.MAX_SAFE_INTEGER, 0);
  const backgroundSession = sessionsResult.sessions.find(
    (session) => session.id === `background-${parentSessionId}-agent-cron-readonly`
  );

  assert.ok(backgroundSession);
  assert.equal(backgroundSession.messageCount, 3);
  assert.equal(backgroundSession.isReadOnly, true);
  assert.ok(backgroundSession.relativeTranscriptPath.endsWith(`${parentSessionId}/subagents/${transcriptFileName}`));
});

test('deleteSession keeps regular session deletion behavior', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-with-regular-session-delete';
  const projectStoreDir = path.join(homeDir, '.claude', 'projects', projectName);
  const sessionFile = path.join(projectStoreDir, 'history.jsonl');

  await writeJsonl(sessionFile, [
    {
      sessionId: 'session-to-delete',
      timestamp: '2026-04-19T10:00:00.000Z',
      message: { role: 'user', content: 'Delete me' }
    },
    {
      sessionId: 'session-to-keep',
      timestamp: '2026-04-19T10:01:00.000Z',
      message: { role: 'user', content: 'Keep me' }
    }
  ]);

  await deleteSession(projectName, 'session-to-delete');

  const content = await fs.readFile(sessionFile, 'utf8');
  assert.equal(content.includes('session-to-delete'), false);
  assert.equal(content.includes('session-to-keep'), true);
});

test('getProjectCronJobsOverview matches recurring cron jobs to failed background sessions via transcriptKey', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-with-failed-cron';
  const projectRoot = path.join(homeDir, 'workspace-failed');
  const parentSessionId = 'parent-session-failed';
  const transcriptFileName = 'agent-cron-failed.jsonl';

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await createBackgroundCronArtifacts({
    homeDir,
    projectName,
    parentSessionId,
    transcriptFileName,
    status: 'failed',
    summary: 'Cron task "Recurring cron cron-9012" failed'
  });
  await writeScheduledTasks(projectRoot, [
    {
      id: 'cron-9012',
      cron: '30 * * * *',
      prompt: 'Audit the overnight background queue',
      createdAt: 1713513000000,
      lastFiredAt: 1713513600000,
      recurring: true,
      originSessionId: parentSessionId,
      transcriptKey: transcriptFileName
    }
  ]);

  const overview = await getProjectCronJobsOverview(projectName);

  assert.equal(overview.jobs.length, 1);
  assert.equal(overview.jobs[0].status, 'failed');
  assert.equal(overview.jobs[0].latestRun?.summary, 'Cron task "Recurring cron cron-9012" failed');
  assert.equal(overview.jobs[0].latestRun?.taskId, 'task-failed');
});

test('getProjectCronJobsOverview marks daemon-running cron jobs as running', async () => {
  const homeDir = await createTempHome();
  const configDir = await createTempDir('projects-cron-jobs-config-');
  const projectName = 'project-with-running-cron';
  const projectRoot = path.join(homeDir, 'workspace-running');
  const parentSessionId = 'parent-session-running';
  const transcriptFileName = 'agent-cron-running.jsonl';

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await createBackgroundCronArtifacts({
    homeDir,
    projectName,
    parentSessionId,
    transcriptFileName,
    status: 'completed',
    summary: 'Cron task "Recurring cron cron-running" completed'
  });
  await writeScheduledTasks(projectRoot, [
    {
      id: 'cron-running',
      cron: '*/10 * * * *',
      prompt: 'Watch the live queue',
      createdAt: 1713515000000,
      recurring: true,
      originSessionId: parentSessionId,
      transcriptKey: transcriptFileName
    }
  ]);

  await withCronDaemonServer(configDir, () => ({
    ok: true,
    data: {
      type: 'list_tasks',
      tasks: [
        {
          id: 'cron-running',
          cron: '*/10 * * * *',
          prompt: 'Watch the live queue',
          createdAt: 1713515000000,
          recurring: true,
          durable: true,
          originSessionId: parentSessionId,
          transcriptKey: transcriptFileName,
          running: true
        }
      ]
    }
  }), async (requests) => {
    const overview = await getProjectCronJobsOverview(projectName);

    assert.equal(overview.jobs.length, 1);
    assert.equal(overview.jobs[0].status, 'running');
    assert.equal(overview.jobs[0].latestRun?.summary, 'Cron task "Recurring cron cron-running" completed');
    assert.deepEqual(requests, [{
      type: 'list_tasks',
      projectRoot
    }]);
  });
});

test('getProjectCronJobsOverview falls back when the cron daemon is unavailable', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-without-daemon';
  const projectRoot = path.join(homeDir, 'workspace-no-daemon');

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeScheduledTasks(projectRoot, [
    {
      id: 'cron-fallback',
      cron: '0 * * * *',
      prompt: 'Fallback to file-backed schedule',
      createdAt: 1713516000000,
      recurring: true,
      originSessionId: 'origin-session-fallback'
    }
  ]);

  const overview = await getProjectCronJobsOverview(projectName);

  assert.equal(overview.jobs.length, 1);
  assert.equal(overview.jobs[0].status, 'scheduled');
  assert.equal(overview.jobs[0].latestRun, null);
});
