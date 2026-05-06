import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  archiveProjectDiscoveryPlan,
  getProjectDiscoveryPlansOverview,
  queueDiscoveryPlanApply,
  queueDiscoveryPlanExecution,
  readDiscoveryPlanStore,
  updateProjectDiscoveryPlanExecution,
} from './discovery-plans.js';
import {
  clearProjectDirectoryCache,
} from './projects.js';
import { getAlwaysOnRunHistory } from './services/always-on-run-history.js';
import { getAlwaysOnRunLog } from './services/always-on-run-logs.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs = [];

async function createTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createTempHome() {
  const homeDir = await createTempDir('discovery-plans-home-');
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  clearProjectDirectoryCache();
  return homeDir;
}

async function writeProjectConfig(homeDir, projectName, projectRoot) {
  const claudeDir = path.join(homeDir, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
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
    `# Example plan\n\n## Context\nA\n\n## Signals Reviewed\nB\n\n## Proposed Work\nC\n\n## Execution Steps\nD\n\n## Verification\nE\n\n## To-Do List\n- [ ] F\n`,
    'utf8',
  );
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
});

test('discovery plans can be listed, queued, updated, and archived', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-discovery-plans';
  const projectRoot = path.join(homeDir, 'workspace-discovery-plans');
  const createdAt = '2026-04-20T10:00:00.000Z';

  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'console.log("before");\n', 'utf8');
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeDiscoveryPlan(projectRoot, {
    id: 'plan-alpha',
    title: 'Investigate flaky tests',
    createdAt,
    updatedAt: createdAt,
    status: 'ready',
    summary: 'Check the recent flaky test failures and stabilize the suite.',
    rationale: 'This keeps CI healthy and avoids regressions shipping unnoticed.',
    dedupeKey: 'flaky-tests',
    sourceDiscoverySessionId: 'discovery-session-1',
    contextRefs: {
      workingDirectory: ['git status showed test changes'],
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    },
    planFilePath: '.claude/always-on/plans/plan-alpha.md',
    structureVersion: 1,
  });

  const overview = await getProjectDiscoveryPlansOverview(projectName);
  assert.equal(overview.plans.length, 1);
  assert.equal(overview.plans[0].id, 'plan-alpha');
  assert.equal(overview.plans[0].status, 'ready');
  assert.match(overview.plans[0].content, /## Proposed Work/);

  const execution = await queueDiscoveryPlanExecution(projectName, 'plan-alpha');
  assert.equal(execution.plan.status, 'queued');
  assert.equal(execution.sessionSummary, 'Always-On: Investigate flaky tests');
  assert.match(execution.command, /Do not enter Plan Mode/);
  assert.match(execution.command, /## Execution Steps/);
  assert.match(execution.command, /isolated execution workspace/);
  assert.ok(execution.executionToken);
  assert.equal(execution.executionWorkspace.kind, 'mirror');
  assert.ok(execution.executionWorkspace.path);
  assert.ok(execution.executionWorkspace.runDir);
  assert.equal(
    await fs.readFile(path.join(execution.executionWorkspace.path, 'src', 'app.js'), 'utf8'),
    'console.log("before");\n',
  );
  await assert.rejects(
    () => fs.access(path.join(execution.executionWorkspace.path, '.claude')),
    /ENOENT/,
  );

  let store = await readDiscoveryPlanStore(projectRoot);
  assert.equal(store.plans[0].status, 'queued');
  assert.equal(store.plans[0].executionStatus, 'queued');
  assert.equal(store.plans[0].executionWorkspaceKind, 'mirror');
  assert.equal(store.plans[0].executionWorkspacePath, execution.executionWorkspace.path);
  assert.equal(store.plans[0].applyStatus, '');
  await assert.rejects(
    () => queueDiscoveryPlanExecution(projectName, 'plan-alpha'),
    /Discovery plan is not ready for execution|already queued or running/,
  );

  const runningPlan = await updateProjectDiscoveryPlanExecution(projectName, 'plan-alpha', {
    executionSessionId: 'session-123',
    status: 'running',
    executionToken: execution.executionToken,
  });
  assert.equal(runningPlan.executionSessionId, 'session-123');
  assert.equal(runningPlan.status, 'running');

  await fs.writeFile(path.join(execution.executionWorkspace.path, 'src', 'app.js'), 'console.log("after");\n', 'utf8');

  const completedPlan = await updateProjectDiscoveryPlanExecution(projectName, 'plan-alpha', {
    executionSessionId: 'session-123',
    status: 'completed',
    latestSummary: 'Tests were stabilized and rerun successfully.',
    executionToken: execution.executionToken,
  });
  assert.equal(completedPlan.status, 'apply_pending');
  assert.equal(completedPlan.applyStatus, 'pending');
  assert.match(completedPlan.reportFilePath, /report\.md$/);
  assert.match(completedPlan.changesPatchPath, /changes\.patch$/);
  assert.match(completedPlan.fileOpsPath, /file-ops\.json$/);
  assert.match(
    await fs.readFile(path.join(projectRoot, completedPlan.reportFilePath), 'utf8'),
    /Tests were stabilized/,
  );
  assert.match(
    await fs.readFile(path.join(projectRoot, completedPlan.changesPatchPath), 'utf8'),
    /console\.log\("after"\)/,
  );
  const fileOps = JSON.parse(await fs.readFile(path.join(projectRoot, completedPlan.fileOpsPath), 'utf8'));
  assert.equal(fileOps.operations.length, 1);
  assert.equal(fileOps.operations[0].type, 'modified');
  assert.equal(fileOps.operations[0].path, 'src/app.js');

  const history = await getAlwaysOnRunHistory(projectRoot);
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].runId, execution.executionToken);
  assert.equal(history.runs[0].status, 'completed');
  assert.equal(history.runs[0].sourceId, 'plan-alpha');

  const runLog = await getAlwaysOnRunLog(projectRoot, execution.executionToken);
  assert.match(runLog.content, /\[AlwaysOnPlanRun\]/);
  assert.match(runLog.content, /phase=queued/);
  assert.match(runLog.content, /phase=completed/);
  assert.match(runLog.content, /phase=apply_pending/);
  assert.match(runLog.content, /Tests were stabilized/);

  const apply = await queueDiscoveryPlanApply(projectName, 'plan-alpha', {
    runId: execution.executionToken,
    userInstructions: 'Keep my local edits where possible.',
  });
  assert.equal(apply.status, 'queued');
  assert.match(apply.command, /semantic merge/);
  assert.match(apply.command, /Keep my local edits/);
  store = await readDiscoveryPlanStore(projectRoot);
  assert.equal(store.plans[0].status, 'apply_queued');
  assert.equal(store.plans[0].applyStatus, 'queued');

  const archiveResult = await archiveProjectDiscoveryPlan(projectName, 'plan-alpha');
  assert.deepEqual(archiveResult, { archived: true });

  store = await readDiscoveryPlanStore(projectRoot);
  assert.equal(store.plans[0].status, 'superseded');
});

test('discovery plan execution failure persists failed status and logs', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-discovery-plan-failure';
  const projectRoot = path.join(homeDir, 'workspace-discovery-plan-failure');
  const createdAt = '2026-04-20T10:00:00.000Z';
  const lockedFile = path.join(projectRoot, 'locked.txt');

  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(lockedFile, 'cannot copy\n', 'utf8');
  await fs.chmod(lockedFile, 0);
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeDiscoveryPlan(projectRoot, {
    id: 'plan-failure',
    title: 'Trigger mirror failure',
    createdAt,
    updatedAt: createdAt,
    status: 'ready',
    summary: 'This plan triggers a mirror preparation failure.',
    rationale: 'Exercise failure persistence.',
    dedupeKey: 'mirror-failure',
    sourceDiscoverySessionId: 'discovery-session-failure',
    contextRefs: {
      workingDirectory: [],
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    },
    planFilePath: '.claude/always-on/plans/plan-failure.md',
    structureVersion: 1,
  });

  try {
    await assert.rejects(
      () => queueDiscoveryPlanExecution(projectName, 'plan-failure'),
      /Failed to prepare|EACCES|permission|operation not permitted/i,
    );
  } finally {
    await fs.chmod(lockedFile, 0o644).catch(() => null);
  }

  const store = await readDiscoveryPlanStore(projectRoot);
  assert.equal(store.plans[0].status, 'failed');
  assert.equal(store.plans[0].executionStatus, 'failed');
  assert.match(store.plans[0].executionFailureReason, /EACCES|permission|operation not permitted|Failed/i);

  const history = await getAlwaysOnRunHistory(projectRoot);
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].status, 'failed');

  const runLog = await getAlwaysOnRunLog(projectRoot, store.plans[0].executionRunId);
  assert.match(runLog.content, /phase=failed/);
});

test('discovery plan overview normalizes legacy empty plan ids', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-empty-plan-id';
  const projectRoot = path.join(homeDir, 'workspace-empty-plan-id');
  const createdAt = '2026-04-20T10:00:00.000Z';

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeDiscoveryPlan(projectRoot, {
    id: '',
    title: 'Legacy malformed plan',
    createdAt,
    updatedAt: createdAt,
    status: 'ready',
    summary: 'A malformed legacy record with an empty id.',
    rationale: 'Ensure it cannot poison auto execution.',
    dedupeKey: 'malformed-empty-id',
    sourceDiscoverySessionId: 'discovery-session-empty-id',
    contextRefs: {
      workingDirectory: [],
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    },
    planFilePath: '.claude/always-on/plans/.md',
    structureVersion: 1,
  });

  const overview = await getProjectDiscoveryPlansOverview(projectName);
  assert.equal(overview.plans.length, 1);
  assert.match(overview.plans[0].id, /^plan-/);
  assert.match(overview.plans[0].planFilePath, /^\.claude[/\\]always-on[/\\]plans[/\\]plan-.+\.md$/);
  assert.notEqual(overview.plans[0].planFilePath, '.claude/always-on/plans/.md');
});
