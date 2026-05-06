import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { isClaudeSDKSessionActive } from './claude-sdk.js';
import {
  extractProjectDirectory,
  getProjectCronJobsOverview,
  getSessions
} from './projects.js';
import { appendAlwaysOnRunEvent } from './services/always-on-run-history.js';
import {
  appendAlwaysOnRunLog,
  appendAlwaysOnRunLogEvent,
  formatAlwaysOnPlanLogLine
} from './services/always-on-run-logs.js';
import {
  prepareAlwaysOnExecutionWorkspace,
  writeExecutionArtifacts,
} from './services/always-on-mirror.js';

const ALWAYS_ON_DISCOVERY_INDEX_VERSION = 1;
const ALWAYS_ON_DISCOVERY_STRUCTURE_VERSION = 1;
const DISCOVERY_CONTEXT_LOOKBACK_DAYS = 7;
const DISCOVERY_CONTEXT_MAX_ITEMS = 8;
const DISCOVERY_PLAN_STATUS_ORDER = {
  running: 0,
  queued: 1,
  apply_pending: 2,
  apply_queued: 3,
  apply_running: 4,
  apply_failed: 5,
  ready: 6,
  failed: 7,
  completed: 8,
  draft: 9,
  superseded: 10
};
const EMPTY_DISCOVERY_PLAN_STORE = {
  version: ALWAYS_ON_DISCOVERY_INDEX_VERSION,
  plans: []
};

function getAlwaysOnRoot(projectRoot) {
  return path.join(projectRoot, '.claude', 'always-on');
}

function getDiscoveryPlansIndexPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'discovery-plans.json');
}

function getDiscoveryPlanMarkdownDirectory(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'plans');
}

function getRelativePlanMarkdownPath(planId) {
  return path.join('.claude', 'always-on', 'plans', `${planId}.md`);
}

function isInvalidPlanMarkdownPath(value) {
  const normalized = normalizeString(value).replace(/\\/g, '/');
  return !normalized || normalized === '.claude/always-on/plans/.md';
}

function toTimestampValue(value) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function toIsoTimestamp(value) {
  const timestamp = toTimestampValue(value);
  return timestamp === null ? '' : new Date(timestamp).toISOString();
}

function pickLatestIsoTimestamp(...values) {
  let latest = null;

  for (const value of values) {
    const timestamp = toTimestampValue(value);
    if (timestamp === null) {
      continue;
    }
    if (latest === null || timestamp > latest) {
      latest = timestamp;
    }
  }

  return latest === null ? '' : new Date(latest).toISOString();
}

function normalizeString(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function truncateText(value, maxLength = 220) {
  const normalized = normalizeString(value).replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function createEmptyContextRefs() {
  return {
    workingDirectory: [],
    memory: [],
    existingPlans: [],
    cronJobs: [],
    recentChats: []
  };
}

function normalizeDiscoveryPlanRecord(record) {
  const now = new Date().toISOString();
  const contextRefs = record?.contextRefs && typeof record.contextRefs === 'object'
    ? {
        workingDirectory: normalizeStringList(record.contextRefs.workingDirectory),
        memory: normalizeStringList(record.contextRefs.memory),
        existingPlans: normalizeStringList(record.contextRefs.existingPlans),
        cronJobs: normalizeStringList(record.contextRefs.cronJobs),
        recentChats: normalizeStringList(record.contextRefs.recentChats)
      }
    : createEmptyContextRefs();

  const fallbackId = `plan-${randomUUID().slice(0, 8)}`;
  const id = normalizeString(record?.id, fallbackId);
  const planFilePath = isInvalidPlanMarkdownPath(record?.planFilePath)
    ? getRelativePlanMarkdownPath(id)
    : normalizeString(record?.planFilePath, getRelativePlanMarkdownPath(id));

  return {
    id,
    title: normalizeString(record?.title, 'Untitled discovery plan'),
    createdAt: toIsoTimestamp(record?.createdAt) || now,
    updatedAt: toIsoTimestamp(record?.updatedAt) || now,
    status: normalizeString(record?.status, 'ready'),
    summary: normalizeString(record?.summary),
    rationale: normalizeString(record?.rationale),
    dedupeKey: normalizeString(record?.dedupeKey, id),
    sourceDiscoverySessionId: normalizeString(record?.sourceDiscoverySessionId),
    executionSessionId: normalizeString(record?.executionSessionId),
    executionRunId: normalizeString(record?.executionRunId),
    executionQueuedAt: toIsoTimestamp(record?.executionQueuedAt),
    executionStartedAt: toIsoTimestamp(record?.executionStartedAt),
    executionLastActivityAt: toIsoTimestamp(record?.executionLastActivityAt),
    executionStatus: normalizeString(record?.executionStatus),
    executionFailureReason: normalizeString(record?.executionFailureReason),
    executionWorkspaceKind: normalizeString(record?.executionWorkspaceKind),
    executionWorkspacePath: normalizeString(record?.executionWorkspacePath),
    executionRunDir: normalizeString(record?.executionRunDir),
    mirrorStrategy: record?.mirrorStrategy && typeof record.mirrorStrategy === 'object'
      ? record.mirrorStrategy
      : undefined,
    applyStatus: normalizeString(record?.applyStatus),
    reportFilePath: normalizeString(record?.reportFilePath),
    changesPatchPath: normalizeString(record?.changesPatchPath),
    fileOpsPath: normalizeString(record?.fileOpsPath),
    latestSummary: normalizeString(record?.latestSummary),
    contextRefs,
    planFilePath,
    structureVersion:
      typeof record?.structureVersion === 'number'
        ? record.structureVersion
        : ALWAYS_ON_DISCOVERY_STRUCTURE_VERSION
  };
}

async function ensureDiscoveryPlanDirectories(projectRoot) {
  await fs.mkdir(getDiscoveryPlanMarkdownDirectory(projectRoot), { recursive: true });
}

async function readDiscoveryPlanStore(projectRoot) {
  try {
    const raw = await fs.readFile(getDiscoveryPlansIndexPath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.plans)) {
      return { ...EMPTY_DISCOVERY_PLAN_STORE };
    }
    return {
      version:
        typeof parsed.version === 'number'
          ? parsed.version
          : ALWAYS_ON_DISCOVERY_INDEX_VERSION,
      plans: parsed.plans.map(normalizeDiscoveryPlanRecord)
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ...EMPTY_DISCOVERY_PLAN_STORE };
    }
    throw error;
  }
}

async function writeDiscoveryPlanStore(projectRoot, store) {
  await ensureDiscoveryPlanDirectories(projectRoot);
  await fs.writeFile(
    getDiscoveryPlansIndexPath(projectRoot),
    `${JSON.stringify({
      version: ALWAYS_ON_DISCOVERY_INDEX_VERSION,
      plans: store.plans
    }, null, 2)}\n`,
    'utf8'
  );
}

function getDiscoveryPlanLocksDir(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'locks');
}

function getDiscoveryPlanLockPath(projectRoot, planId) {
  const safePlanId = normalizeString(planId, 'unknown').replace(/[^a-zA-Z0-9._:-]/g, '-');
  return path.join(getDiscoveryPlanLocksDir(projectRoot), `plan-${safePlanId}.lock`);
}

async function withPlanExecutionLock(projectRoot, planId, callback) {
  await fs.mkdir(getDiscoveryPlanLocksDir(projectRoot), { recursive: true });
  const lockPath = getDiscoveryPlanLockPath(projectRoot, planId);
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const lockError = new Error('Discovery plan is already being queued or running');
      lockError.code = 'ALREADY_RUNNING';
      throw lockError;
    }
    throw error;
  }

  try {
    return await callback();
  } finally {
    await handle?.close().catch(() => null);
    await fs.rm(lockPath, { force: true }).catch(() => null);
  }
}

async function readDiscoveryPlanBody(projectRoot, planFilePath) {
  const absolutePath = path.resolve(projectRoot, planFilePath);
  try {
    return await fs.readFile(absolutePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function summarizeSession(session) {
  const summary = normalizeString(
    session?.summary || session?.title || session?.name || session?.lastUserMessage || session?.lastAssistantMessage
  );
  return truncateText(summary, 200);
}

function computeExecutionStatus(plan, session) {
  if (plan.status === 'superseded') {
    return '';
  }
  if (plan.status === 'apply_pending' || plan.status === 'apply_queued' || plan.status === 'apply_running' || plan.status === 'apply_failed') {
    return plan.status;
  }

  if (plan.executionSessionId && isClaudeSDKSessionActive(plan.executionSessionId)) {
    return 'running';
  }

  if (plan.executionStatus === 'failed') {
    return 'failed';
  }

  if (plan.executionStatus === 'completed') {
    return 'completed';
  }

  if (plan.executionStatus === 'queued') {
    return plan.executionSessionId && session ? 'completed' : 'queued';
  }

  if (plan.executionStatus === 'running') {
    return plan.executionSessionId && session ? 'completed' : 'running';
  }

  if (plan.executionSessionId && session) {
    return 'completed';
  }

  if (plan.status === 'queued' || plan.status === 'running' || plan.status === 'completed' || plan.status === 'failed') {
    return plan.status;
  }

  return '';
}

function computePlanStatus(plan, session) {
  if (plan.status === 'superseded') {
    return 'superseded';
  }

  const executionStatus = computeExecutionStatus(plan, session);
  if (executionStatus) {
    return executionStatus;
  }

  return normalizeString(plan.status, 'ready');
}

function buildDiscoveryPlanOverview(plan, content, session) {
  const status = computePlanStatus(plan, session);
  const latestSummary = normalizeString(
    session?.lastAssistantMessage || session?.summary || session?.title || plan.latestSummary
  );

  return {
    ...plan,
    status,
    executionStatus: computeExecutionStatus(plan, session) || undefined,
    executionStartedAt:
      pickLatestIsoTimestamp(plan.executionStartedAt, session?.createdAt, session?.created_at) || undefined,
    executionLastActivityAt:
      pickLatestIsoTimestamp(plan.executionLastActivityAt, session?.lastActivity, session?.updated_at) || undefined,
    latestSummary: latestSummary || undefined,
    content: content.trim()
  };
}

function sortDiscoveryPlans(plans) {
  return [...plans].sort((left, right) => {
    const leftOrder = DISCOVERY_PLAN_STATUS_ORDER[left.status] ?? 99;
    const rightOrder = DISCOVERY_PLAN_STATUS_ORDER[right.status] ?? 99;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return (toTimestampValue(right.updatedAt) ?? 0) - (toTimestampValue(left.updatedAt) ?? 0);
  });
}

async function findProjectDiscoveryPlan(projectName, planId) {
  const projectRoot = await extractProjectDirectory(projectName);
  const store = await readDiscoveryPlanStore(projectRoot);
  const index = store.plans.findIndex((plan) => plan.id === planId);
  if (index === -1) {
    return null;
  }

  return {
    projectRoot,
    store,
    index,
    plan: store.plans[index]
  };
}

async function runCommand(command, args, cwd) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.on('error', () => resolve(''));
    child.on('close', (code) => {
      resolve(code === 0 ? stdout.trim() : '');
    });
  });
}

async function collectWorkspaceSignals(projectRoot) {
  const [gitStatus, recentCommit] = await Promise.all([
    runCommand('git', ['-C', projectRoot, 'status', '--short'], projectRoot),
    runCommand('git', ['-C', projectRoot, 'log', '-1', '--stat', '--oneline', '--decorate=no'], projectRoot)
  ]);

  const signals = [];
  signals.push(`Project root: ${projectRoot}`);
  if (gitStatus) {
    signals.push(`Git status:\n${gitStatus.split('\n').slice(0, 20).join('\n')}`);
  }
  if (recentCommit) {
    signals.push(`Latest commit:\n${recentCommit.split('\n').slice(0, 12).join('\n')}`);
  }

  return signals;
}

async function walkDirectory(rootDir, visit) {
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        return;
      }
      await walkDirectory(entryPath, visit);
      return;
    }

    if (entry.isFile()) {
      await visit(entryPath);
    }
  }));
}

async function collectMemorySignals(projectName) {
  const projectStoreDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  const candidates = [];

  await walkDirectory(projectStoreDir, async (entryPath) => {
    const normalized = entryPath.replace(/\\/g, '/');
    const isSessionMemorySummary = normalized.endsWith('/session-memory/summary.md');
    const isAutoMemoryFile = normalized.includes('/memory/') && normalized.endsWith('.md');
    if (!isSessionMemorySummary && !isAutoMemoryFile) {
      return;
    }

    try {
      const stats = await fs.stat(entryPath);
      candidates.push({
        entryPath,
        modifiedAt: stats.mtime.toISOString()
      });
    } catch {
      // Ignore transient files.
    }
  });

  candidates.sort((left, right) =>
    (toTimestampValue(right.modifiedAt) ?? 0) - (toTimestampValue(left.modifiedAt) ?? 0)
  );

  const selected = candidates.slice(0, DISCOVERY_CONTEXT_MAX_ITEMS);
  return await Promise.all(selected.map(async (candidate) => {
    const raw = await fs.readFile(candidate.entryPath, 'utf8').catch(() => '');
    return {
      path: path.relative(projectStoreDir, candidate.entryPath).replace(/\\/g, '/'),
      modifiedAt: candidate.modifiedAt,
      summary: truncateText(raw, 280)
    };
  }));
}

function buildRecentChatEntry(session) {
  return {
    id: session.id,
    summary: summarizeSession(session),
    lastActivity: toIsoTimestamp(session.lastActivity || session.updated_at || session.createdAt || session.created_at),
    lastUserMessage: truncateText(session.lastUserMessage, 220),
    lastAssistantMessage: truncateText(session.lastAssistantMessage, 220)
  };
}

function buildExistingPlanContextItem(plan) {
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    updatedAt: plan.updatedAt,
    summary: truncateText(plan.summary, 180)
  };
}

function buildCronContextItem(job) {
  return {
    id: job.id,
    status: job.status,
    cron: job.cron,
    recurring: Boolean(job.recurring),
    manualOnly: Boolean(job.manualOnly),
    prompt: truncateText(job.prompt, 180),
    latestRunSummary: truncateText(job.latestRun?.summary, 180)
  };
}

export async function getProjectDiscoveryContext(projectName) {
  const projectRoot = await extractProjectDirectory(projectName);
  const cutoff = Date.now() - DISCOVERY_CONTEXT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  const [
    workspaceSignals,
    memory,
    discoveryPlansResponse,
    cronOverview,
    sessionResult
  ] = await Promise.all([
    collectWorkspaceSignals(projectRoot),
    collectMemorySignals(projectName),
    getProjectDiscoveryPlansOverview(projectName),
    getProjectCronJobsOverview(projectName),
    getSessions(projectName, Number.MAX_SAFE_INTEGER, 0)
  ]);

  const recentChats = Array.isArray(sessionResult?.sessions)
    ? sessionResult.sessions
        .filter((session) => session?.sessionKind !== 'background_task')
        .filter((session) => (toTimestampValue(session?.lastActivity || session?.updated_at || session?.createdAt || session?.created_at) ?? 0) >= cutoff)
        .sort((left, right) =>
          (toTimestampValue(right?.lastActivity || right?.updated_at || right?.createdAt || right?.created_at) ?? 0) -
          (toTimestampValue(left?.lastActivity || left?.updated_at || left?.createdAt || left?.created_at) ?? 0)
        )
        .slice(0, DISCOVERY_CONTEXT_MAX_ITEMS)
        .map(buildRecentChatEntry)
    : [];

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays: DISCOVERY_CONTEXT_LOOKBACK_DAYS,
    workspace: {
      projectName,
      projectRoot,
      signals: workspaceSignals
    },
    memory,
    existingPlans: discoveryPlansResponse.plans
      .filter((plan) => plan.status !== 'superseded')
      .slice(0, DISCOVERY_CONTEXT_MAX_ITEMS)
      .map(buildExistingPlanContextItem),
    cronJobs: Array.isArray(cronOverview?.jobs)
      ? cronOverview.jobs.slice(0, DISCOVERY_CONTEXT_MAX_ITEMS).map(buildCronContextItem)
      : [],
    recentChats
  };
}

export async function getProjectDiscoveryPlansOverview(projectName) {
  const projectRoot = await extractProjectDirectory(projectName);
  const store = await readDiscoveryPlanStore(projectRoot);

  if (store.plans.length === 0) {
    return { plans: [] };
  }

  const sessionResult = await getSessions(projectName, Number.MAX_SAFE_INTEGER, 0).catch(() => ({ sessions: [] }));
  const sessionsById = new Map(
    Array.isArray(sessionResult?.sessions)
      ? sessionResult.sessions.map((session) => [session.id, session])
      : []
  );

  const plans = await Promise.all(store.plans.map(async (plan) => {
    const body = await readDiscoveryPlanBody(projectRoot, plan.planFilePath);
    const session = plan.executionSessionId
      ? sessionsById.get(plan.executionSessionId) || null
      : null;
    return buildDiscoveryPlanOverview(plan, body, session);
  }));

  return {
    plans: sortDiscoveryPlans(plans)
  };
}

function buildDiscoveryPlanExecutionPrompt(plan, planContent, projectName, executionContext = {}) {
  const runDir = normalizeString(executionContext.runDir);
  const executionRoot = normalizeString(executionContext.executionRoot);
  const workspaceKind = normalizeString(executionContext.workspaceKind);
  return [
    `Always-On execution for project "${projectName}".`,
    '',
    'This plan is ready for isolated execution.',
    'Execute the work directly in the isolated execution workspace.',
    'Do not enter Plan Mode.',
    'Do not create a second mini-plan before acting.',
    'Do not apply changes back to the source workspace. Leave the source workspace untouched.',
    'When finished, summarize the work clearly; Always-On will write the review artifacts and wait for user approval before apply.',
    '',
    `Plan ID: ${plan.id}`,
    `Plan file: ${plan.planFilePath}`,
    `Execution workspace kind: ${workspaceKind}`,
    `Execution workspace path: ${executionRoot}`,
    `Run artifacts directory: ${runDir}`,
    '',
    workspaceKind === 'snapshot-git-mirror'
      ? 'This execution workspace is a git-initialized snapshot of the source workspace current files. It has an Always-On baseline commit and branch; do not write back to the source workspace.'
      : '',
    workspaceKind === 'mirror'
      ? 'For non-git mirrors, inspect the workspace scan and mirror strategy artifacts in the run directory. If deeper inspection changes your assessment, update mirror-strategy.json with strict JSON using only strategy "copy-on-write" or "full-copy"; do not move execution out of the prepared workspace.'
      : '',
    '',
    'Approved plan:',
    '',
    planContent.trim()
  ].join('\n');
}

export async function queueDiscoveryPlanExecution(projectName, planId, { source = 'manual' } = {}) {
  const match = await findProjectDiscoveryPlan(projectName, planId);
  if (!match) {
    const error = new Error('Discovery plan not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const { projectRoot } = match;
  return await withPlanExecutionLock(projectRoot, planId, async () => {
    const lockedMatch = await findProjectDiscoveryPlan(projectName, planId);
    if (!lockedMatch) {
      const error = new Error('Discovery plan not found');
      error.code = 'NOT_FOUND';
      throw error;
    }

    const { store, index, plan } = lockedMatch;
    if (plan.status === 'superseded') {
      const error = new Error('Superseded discovery plans cannot be executed');
      error.code = 'INVALID_STATE';
      throw error;
    }
    if (plan.status !== 'ready') {
      const alreadyRunning = plan.status === 'queued' || plan.status === 'running';
      const error = new Error(
        alreadyRunning
          ? 'Discovery plan is already queued or running'
          : 'Discovery plan is not ready for execution',
      );
      error.code = alreadyRunning ? 'ALREADY_RUNNING' : 'INVALID_STATE';
      throw error;
    }

    const content = await readDiscoveryPlanBody(projectRoot, plan.planFilePath);
    if (!normalizeString(content)) {
      const error = new Error('Discovery plan content is missing');
      error.code = 'MISSING_PLAN_BODY';
      throw error;
    }

    const now = new Date().toISOString();
    const executionToken = randomUUID();
    const queuedPlan = {
      ...plan,
      status: 'queued',
      executionStatus: 'queued',
      executionRunId: executionToken,
      executionQueuedAt: now,
      executionSessionId: '',
      executionStartedAt: '',
      executionLastActivityAt: '',
      executionWorkspaceKind: '',
      executionWorkspacePath: '',
      executionRunDir: '',
      executionFailureReason: '',
      mirrorStrategy: undefined,
      applyStatus: '',
      reportFilePath: '',
      changesPatchPath: '',
      fileOpsPath: '',
      latestSummary: '',
      updatedAt: now,
      lastExecutionSource: source,
    };
    store.plans[index] = queuedPlan;
    await writeDiscoveryPlanStore(projectRoot, store);
    await appendAlwaysOnRunEvent(projectRoot, {
      runId: executionToken,
      kind: 'plan',
      sourceId: queuedPlan.id,
      title: queuedPlan.title,
      status: 'queued',
      timestamp: now,
      startedAt: now,
      metadata: {
        planId: queuedPlan.id,
        planFilePath: queuedPlan.planFilePath,
        source,
      },
    });
    await appendAlwaysOnRunLog(projectRoot, executionToken, [
      formatAlwaysOnPlanLogLine({
        timestamp: now,
        runId: executionToken,
        planId: queuedPlan.id,
        phase: 'queued',
        message: `Queued plan "${queuedPlan.title}" from ${source}`,
      }),
      formatAlwaysOnPlanLogLine({
        timestamp: now,
        runId: executionToken,
        planId: queuedPlan.id,
        phase: 'plan_file',
        message: `Plan file: ${queuedPlan.planFilePath}`,
      }),
    ]);

    let executionWorkspace;
    try {
      executionWorkspace = await prepareAlwaysOnExecutionWorkspace(projectRoot, executionToken, content);
    } catch (error) {
      const failedAt = new Date().toISOString();
      const failureReason = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : 'Failed to prepare Always-On execution workspace.';
      const failedPlan = {
        ...queuedPlan,
        status: 'failed',
        executionStatus: 'failed',
        executionLastActivityAt: failedAt,
        executionFailureReason: failureReason,
        latestSummary: failureReason,
        updatedAt: failedAt,
      };
      store.plans[index] = failedPlan;
      await writeDiscoveryPlanStore(projectRoot, store);
      await appendAlwaysOnRunEvent(projectRoot, {
        runId: executionToken,
        kind: 'plan',
        sourceId: failedPlan.id,
        title: failedPlan.title,
        status: 'failed',
        timestamp: failedAt,
        startedAt: now,
        finishedAt: failedAt,
        error: failureReason,
        metadata: {
          planId: failedPlan.id,
          planFilePath: failedPlan.planFilePath,
          source,
        },
      });
      await appendAlwaysOnRunLog(projectRoot, executionToken, [
        formatAlwaysOnPlanLogLine({
          timestamp: failedAt,
          level: 'error',
          runId: executionToken,
          planId: failedPlan.id,
          phase: 'failed',
          message: failureReason,
        }),
      ]);
      await appendAlwaysOnRunLogEvent(projectRoot, executionToken, {
        kind: 'plan',
        planId: failedPlan.id,
        phase: 'failed',
        status: 'failed',
        error: failureReason,
      });

      const executionError = new Error(failureReason);
      executionError.code = 'EXECUTION_PREP_FAILED';
      throw executionError;
    }

    const preparedAt = new Date().toISOString();
    const updatedPlan = {
      ...queuedPlan,
      executionWorkspaceKind: executionWorkspace.workspaceKind,
      executionWorkspacePath: executionWorkspace.executionRoot,
      executionRunDir: executionWorkspace.runDir,
      mirrorStrategy: executionWorkspace.mirrorStrategy,
      updatedAt: preparedAt,
    };
    store.plans[index] = updatedPlan;
    await writeDiscoveryPlanStore(projectRoot, store);
    await appendAlwaysOnRunEvent(projectRoot, {
      runId: executionToken,
      kind: 'plan',
      sourceId: updatedPlan.id,
      title: updatedPlan.title,
      status: 'queued',
      timestamp: preparedAt,
      startedAt: now,
      metadata: {
        planId: updatedPlan.id,
        planFilePath: updatedPlan.planFilePath,
        source,
        executionWorkspaceKind: updatedPlan.executionWorkspaceKind,
        executionWorkspacePath: updatedPlan.executionWorkspacePath,
        executionRunDir: updatedPlan.executionRunDir,
      },
    });
    await appendAlwaysOnRunLog(projectRoot, executionToken, [
      formatAlwaysOnPlanLogLine({
        timestamp: preparedAt,
        runId: executionToken,
        planId: updatedPlan.id,
        phase: 'execution_workspace',
        message: `Execution workspace: ${updatedPlan.executionWorkspaceKind} at ${updatedPlan.executionWorkspacePath}`,
      }),
    ]);
    await appendAlwaysOnRunLogEvent(projectRoot, executionToken, {
      kind: 'plan',
      planId: updatedPlan.id,
      phase: 'queued',
      status: 'queued',
      source,
      planFilePath: updatedPlan.planFilePath,
      executionWorkspaceKind: updatedPlan.executionWorkspaceKind,
      executionWorkspacePath: updatedPlan.executionWorkspacePath,
    });

    return {
      plan: buildDiscoveryPlanOverview(updatedPlan, content, null),
      sessionSummary: `Always-On: ${updatedPlan.title}`,
      command: buildDiscoveryPlanExecutionPrompt(updatedPlan, content, projectName, executionWorkspace),
      executionToken,
      executionWorkspace: {
        kind: updatedPlan.executionWorkspaceKind,
        path: updatedPlan.executionWorkspacePath,
        runDir: updatedPlan.executionRunDir,
      },
    };
  });
}

export async function updateProjectDiscoveryPlanExecution(projectName, planId, updates = {}) {
  const match = await findProjectDiscoveryPlan(projectName, planId);
  if (!match) {
    const error = new Error('Discovery plan not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const { projectRoot, store, index, plan } = match;
  const now = new Date().toISOString();
  const requestedStatus = normalizeString(updates.status);
  const isCompletedUpdate = requestedStatus === 'completed';
  const artifactResult = isCompletedUpdate && normalizeString(plan.executionWorkspacePath)
    ? await writeExecutionArtifacts(
        projectRoot,
        normalizeString(updates.executionToken, plan.executionSessionId || plan.id),
        plan.executionWorkspacePath,
        normalizeString(updates.latestSummary, plan.latestSummary),
      ).catch(() => null)
    : null;
  const planStatus = isCompletedUpdate ? 'apply_pending' : requestedStatus;
  const executionStatus = isCompletedUpdate ? 'completed' : normalizeString(updates.status, plan.executionStatus);

  const nextPlan = {
    ...plan,
    executionSessionId: normalizeString(updates.executionSessionId, plan.executionSessionId),
    executionStartedAt: updates.executionStartedAt
      ? toIsoTimestamp(updates.executionStartedAt)
      : (requestedStatus === 'running' && !plan.executionStartedAt
          ? now
          : plan.executionStartedAt),
    executionLastActivityAt: updates.executionLastActivityAt
      ? toIsoTimestamp(updates.executionLastActivityAt)
      : now,
    executionStatus,
    latestSummary: normalizeString(updates.latestSummary, plan.latestSummary),
    status: planStatus || plan.status,
    applyStatus: isCompletedUpdate ? 'pending' : plan.applyStatus,
    reportFilePath: artifactResult?.reportFilePath || plan.reportFilePath,
    changesPatchPath: artifactResult?.changesPatchPath || plan.changesPatchPath,
    fileOpsPath: artifactResult?.fileOpsPath || plan.fileOpsPath,
    updatedAt: now
  };

  store.plans[index] = nextPlan;
  await writeDiscoveryPlanStore(projectRoot, store);
  const executionRunId = normalizeString(
    updates.executionToken,
    nextPlan.executionSessionId || plan.executionSessionId || nextPlan.id
  );
  const normalizedStatus = isCompletedUpdate
    ? 'completed'
    : normalizeString(updates.status, nextPlan.executionStatus || nextPlan.status);
  if (executionRunId && normalizedStatus) {
    await appendAlwaysOnRunEvent(projectRoot, {
      runId: executionRunId,
      kind: 'plan',
      sourceId: nextPlan.id,
      title: nextPlan.title,
      status: normalizedStatus,
      timestamp: now,
      startedAt: nextPlan.executionStartedAt || now,
      finishedAt: normalizedStatus === 'completed' || normalizedStatus === 'failed' ? now : undefined,
      sessionId: nextPlan.executionSessionId,
      output: nextPlan.latestSummary,
      metadata: {
        planId: nextPlan.id,
        planFilePath: nextPlan.planFilePath,
        executionWorkspaceKind: nextPlan.executionWorkspaceKind,
        executionWorkspacePath: nextPlan.executionWorkspacePath,
        executionRunDir: nextPlan.executionRunDir,
        applyStatus: nextPlan.applyStatus,
        reportFilePath: nextPlan.reportFilePath,
        changesPatchPath: nextPlan.changesPatchPath,
        fileOpsPath: nextPlan.fileOpsPath,
      },
    });
    await appendAlwaysOnRunLog(projectRoot, executionRunId, [
      formatAlwaysOnPlanLogLine({
        timestamp: now,
        level: normalizedStatus === 'failed' ? 'error' : 'info',
        runId: executionRunId,
        planId: nextPlan.id,
        phase: normalizedStatus,
        message: `Plan execution ${normalizedStatus}`,
      }),
      nextPlan.latestSummary
        ? formatAlwaysOnPlanLogLine({
            timestamp: now,
            runId: executionRunId,
            planId: nextPlan.id,
            phase: 'summary',
            message: nextPlan.latestSummary,
          })
        : '',
      isCompletedUpdate
        ? formatAlwaysOnPlanLogLine({
            timestamp: now,
            runId: executionRunId,
            planId: nextPlan.id,
            phase: 'apply_pending',
            message: 'Execution completed in the isolated workspace. Waiting for user approval before applying to the source workspace.',
          })
        : '',
    ].filter(Boolean));
    await appendAlwaysOnRunLogEvent(projectRoot, executionRunId, {
      kind: 'plan',
      planId: nextPlan.id,
      phase: normalizedStatus,
      status: normalizedStatus,
      sessionId: nextPlan.executionSessionId,
      applyStatus: nextPlan.applyStatus,
      reportFilePath: nextPlan.reportFilePath,
      changesPatchPath: nextPlan.changesPatchPath,
      fileOpsPath: nextPlan.fileOpsPath,
    });
  }

  const content = await readDiscoveryPlanBody(projectRoot, nextPlan.planFilePath);
  return buildDiscoveryPlanOverview(nextPlan, content, null);
}

export async function queueDiscoveryPlanApply(projectName, planId, { runId = '', userInstructions = '' } = {}) {
  const match = await findProjectDiscoveryPlan(projectName, planId);
  if (!match) {
    const error = new Error('Discovery plan not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const { projectRoot, store, index, plan } = match;
  if (plan.status !== 'apply_pending') {
    const error = new Error('Discovery plan is not waiting for apply');
    error.code = 'INVALID_STATE';
    throw error;
  }

  const now = new Date().toISOString();
  const applyRunId = `apply-${randomUUID()}`;
  const targetRunId = normalizeString(runId, plan.executionSessionId || plan.id);
  const nextPlan = {
    ...plan,
    status: 'apply_queued',
    applyStatus: 'queued',
    updatedAt: now,
  };
  store.plans[index] = nextPlan;
  await writeDiscoveryPlanStore(projectRoot, store);

  const command = [
    `Always-On apply for project "${projectName}".`,
    '',
    'You are applying a completed Always-On isolated execution back to the source workspace.',
    'Do not rerun the original task from scratch.',
    'Read the plan, report, changes patch, file operations, and mirror manifest before editing.',
    'If the source workspace has changed, preserve the user changes and perform a semantic merge.',
    'Stop and report apply_needs_review for high-risk binary replacements, secrets, or destructive changes.',
    '',
    `Plan ID: ${plan.id}`,
    `Execution run ID: ${targetRunId}`,
    `Report: ${plan.reportFilePath}`,
    `Changes patch: ${plan.changesPatchPath}`,
    `File operations: ${plan.fileOpsPath}`,
    `Execution workspace: ${plan.executionWorkspacePath}`,
    '',
    userInstructions ? `User apply instructions:\n${userInstructions}` : '',
  ].filter(Boolean).join('\n');

  await appendAlwaysOnRunEvent(projectRoot, {
    runId: applyRunId,
    kind: 'plan',
    sourceId: nextPlan.id,
    title: `Apply: ${nextPlan.title}`,
    status: 'queued',
    timestamp: now,
    startedAt: now,
    metadata: {
      planId: nextPlan.id,
      sourceRunId: targetRunId,
      applyStatus: nextPlan.applyStatus,
    },
  });

  return {
    applyRunId,
    status: 'queued',
    plan: buildDiscoveryPlanOverview(nextPlan, await readDiscoveryPlanBody(projectRoot, nextPlan.planFilePath), null),
    sessionSummary: `Apply Always-On: ${nextPlan.title}`,
    command,
  };
}

export async function archiveProjectDiscoveryPlan(projectName, planId) {
  const match = await findProjectDiscoveryPlan(projectName, planId);
  if (!match) {
    const error = new Error('Discovery plan not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const { projectRoot, store, index, plan } = match;
  const executionStatus = computeExecutionStatus(plan, null);
  if (executionStatus === 'running' || executionStatus === 'queued') {
    const error = new Error('Running discovery plans cannot be archived');
    error.code = 'INVALID_STATE';
    throw error;
  }

  const nextPlan = {
    ...plan,
    status: 'superseded',
    updatedAt: new Date().toISOString()
  };
  store.plans[index] = nextPlan;
  await writeDiscoveryPlanStore(projectRoot, store);
  return { archived: true };
}

export {
  readDiscoveryPlanStore
};
