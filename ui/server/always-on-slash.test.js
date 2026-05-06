import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { executeAlwaysOnSlashCommand } from './always-on-slash.js';
import { clearProjectDirectoryCache } from './projects.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const tempDirs = [];

async function createTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createTempHome() {
  const homeDir = await createTempDir('always-on-slash-home-');
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  clearProjectDirectoryCache();
  return homeDir;
}

async function writeProjectConfig(homeDir, projectName, projectRoot) {
  const claudeDir = path.join(homeDir, '.claude');
  await fs.mkdir(path.join(claudeDir, 'projects', projectName), { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, 'project-config.json'),
    JSON.stringify({
      [projectName]: {
        manuallyAdded: true,
        originalPath: projectRoot,
      },
    }, null, 2),
    'utf8',
  );
}

async function writeScheduledTasks(projectRoot, tasks) {
  await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.claude', 'scheduled_tasks.json'),
    JSON.stringify({ tasks }, null, 2),
    'utf8',
  );
}

async function writeDiscoveryPlan(projectRoot, plan) {
  const alwaysOnDir = path.join(projectRoot, '.claude', 'always-on');
  const plansDir = path.join(alwaysOnDir, 'plans');
  await fs.mkdir(plansDir, { recursive: true });

  await fs.writeFile(
    path.join(alwaysOnDir, 'discovery-plans.json'),
    JSON.stringify({
      version: 1,
      plans: [plan],
    }, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, plan.planFilePath),
    `# Example plan

## Context
A

## Signals Reviewed
B

## Proposed Work
C

## Execution Steps
D

## Verification
E

## To-Do List
- [ ] F
`,
    'utf8',
  );
}

async function withCronDaemonServer(configDir, responder, callback) {
  process.env.CLAUDE_CONFIG_DIR = configDir;
  await fs.mkdir(configDir, { recursive: true });
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
});

test('list returns combined cron and plan markdown', async () => {
  const homeDir = await createTempHome();
  const projectName = 'always-on-list-project';
  const projectRoot = path.join(homeDir, 'workspace-always-on-list');
  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeScheduledTasks(projectRoot, [{
    id: 'cron-alpha',
    cron: '*/5 * * * *',
    prompt: 'Check repo health',
    createdAt: Date.now(),
    recurring: true,
    originSessionId: 'session-1',
  }]);
  await writeDiscoveryPlan(projectRoot, {
    id: 'plan-alpha',
    title: 'Investigate flaky tests',
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    status: 'ready',
    summary: 'Check the recent flaky test failures and stabilize the suite.',
    rationale: 'This keeps CI healthy and reduces noise.',
    dedupeKey: 'flaky-tests',
    sourceDiscoverySessionId: 'discovery-session-1',
    contextRefs: {
      workingDirectory: [],
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    },
    planFilePath: '.claude/always-on/plans/plan-alpha.md',
    structureVersion: 1,
  });

  const result = await executeAlwaysOnSlashCommand(['list'], {
    projectName,
    projectPath: projectRoot,
  });

  assert.equal(result.action, 'ao');
  assert.equal(result.data.mode, 'message');
  assert.match(result.data.content, /## Discovery plans \(1\)/);
  assert.match(result.data.content, /## Cron jobs \(1\)/);
  assert.match(result.data.content, /plan-alpha/);
  assert.match(result.data.content, /cron-alpha/);
});

test('status returns detailed markdown for cron jobs and discovery plans', async () => {
  const homeDir = await createTempHome();
  const projectName = 'always-on-status-project';
  const projectRoot = path.join(homeDir, 'workspace-always-on-status');
  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeScheduledTasks(projectRoot, [{
    id: 'cron-status',
    cron: '0 * * * *',
    prompt: 'Status prompt',
    createdAt: Date.now(),
    recurring: true,
    manualOnly: true,
    originSessionId: 'session-2',
    transcriptKey: 'cron-thread-1',
  }]);
  await writeDiscoveryPlan(projectRoot, {
    id: 'plan-status',
    title: 'Investigate alerts',
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    status: 'ready',
    summary: 'Inspect recurring alert spikes.',
    rationale: 'Reduce alert fatigue.',
    dedupeKey: 'alert-spikes',
    sourceDiscoverySessionId: 'discovery-session-2',
    contextRefs: {
      workingDirectory: [],
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    },
    planFilePath: '.claude/always-on/plans/plan-status.md',
    structureVersion: 1,
  });

  const cronResult = await executeAlwaysOnSlashCommand(['status', 'cron', 'cron-status'], {
    projectName,
    projectPath: projectRoot,
  });
  const planResult = await executeAlwaysOnSlashCommand(['status', 'plan', 'plan-status'], {
    projectName,
    projectPath: projectRoot,
  });

  assert.match(cronResult.data.content, /# Cron job `cron-status`/);
  assert.match(cronResult.data.content, /Manual only: `yes`/);
  assert.match(planResult.data.content, /# Discovery plan `plan-status`/);
  assert.match(planResult.data.content, /Status: `ready`/);
});

test('run cron forwards to the daemon and reports started or already running', async () => {
  const homeDir = await createTempHome();
  const configDir = await createTempDir('always-on-slash-config-');
  const projectName = 'always-on-run-cron';
  const projectRoot = path.join(homeDir, 'workspace-always-on-run-cron');
  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);

  await withCronDaemonServer(configDir, (request) => {
    if (request.taskId === 'cron-running') {
      return {
        ok: true,
        data: { type: 'run_task_now', started: false, reason: 'already_running' },
      };
    }

    return {
      ok: true,
      data: { type: 'run_task_now', started: true },
    };
  }, async (requests) => {
    const startedResult = await executeAlwaysOnSlashCommand(['run', 'cron', 'cron-start'], {
      projectName,
      projectPath: projectRoot,
    });
    const runningResult = await executeAlwaysOnSlashCommand(['run', 'cron', 'cron-running'], {
      projectName,
      projectPath: projectRoot,
    });

    assert.match(startedResult.data.content, /Started cron job `cron-start` immediately/);
    assert.match(runningResult.data.content, /already running/);
    assert.deepEqual(requests, [
      { type: 'run_task_now', projectRoot, taskId: 'cron-start' },
      { type: 'run_task_now', projectRoot, taskId: 'cron-running' },
    ]);
  });
});

test('run plan returns a queued execution payload', async () => {
  const homeDir = await createTempHome();
  const projectName = 'always-on-run-plan';
  const projectRoot = path.join(homeDir, 'workspace-always-on-run-plan');
  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeDiscoveryPlan(projectRoot, {
    id: 'plan-run',
    title: 'Follow up on CI regressions',
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    status: 'ready',
    summary: 'Investigate CI regressions and fix the root cause.',
    rationale: 'Keep the branch healthy.',
    dedupeKey: 'ci-regressions',
    sourceDiscoverySessionId: 'discovery-session-3',
    contextRefs: {
      workingDirectory: [],
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    },
    planFilePath: '.claude/always-on/plans/plan-run.md',
    structureVersion: 1,
  });

  const result = await executeAlwaysOnSlashCommand(['run', 'plan', 'plan-run'], {
    projectName,
    projectPath: projectRoot,
  });

  assert.equal(result.data.mode, 'run-plan');
  assert.equal(result.data.execution.plan.id, 'plan-run');
  assert.match(result.data.execution.command, /Do not enter Plan Mode/);
  assert.match(result.data.content, /Queued discovery plan `plan-run` for execution/);
});

test('run plan returns a message when the plan cannot be queued', async () => {
  const homeDir = await createTempHome();
  const projectName = 'always-on-run-plan-invalid';
  const projectRoot = path.join(homeDir, 'workspace-always-on-run-plan-invalid');
  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeDiscoveryPlan(projectRoot, {
    id: 'plan-running',
    title: 'Already running plan',
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    status: 'queued',
    summary: 'This plan is already queued.',
    rationale: 'Avoid duplicate execution.',
    dedupeKey: 'already-running',
    sourceDiscoverySessionId: 'discovery-session-4',
    executionStatus: 'queued',
    contextRefs: {
      workingDirectory: [],
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    },
    planFilePath: '.claude/always-on/plans/plan-running.md',
    structureVersion: 1,
  });

  const result = await executeAlwaysOnSlashCommand(['run', 'plan', 'plan-running'], {
    projectName,
    projectPath: projectRoot,
  });

  assert.equal(result.data.mode, 'message');
  assert.match(result.data.content, /already queued or running/i);
});
