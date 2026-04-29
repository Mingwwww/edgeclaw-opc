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

const ALWAYS_ON_DISCOVERY_INDEX_VERSION = 1;
const ALWAYS_ON_DISCOVERY_STRUCTURE_VERSION = 1;
const DISCOVERY_CONTEXT_LOOKBACK_DAYS = 7;
const DISCOVERY_CONTEXT_MAX_ITEMS = 8;
const DISCOVERY_PLAN_STATUS_ORDER = {
  running: 0,
  queued: 1,
  ready: 2,
  failed: 3,
  completed: 4,
  draft: 5,
  superseded: 6
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

  return {
    id,
    title: normalizeString(record?.title, 'Untitled discovery plan'),
    createdAt: toIsoTimestamp(record?.createdAt) || now,
    updatedAt: toIsoTimestamp(record?.updatedAt) || now,
    approvalMode: record?.approvalMode === 'auto' ? 'auto' : 'manual',
    status: normalizeString(record?.status, 'ready'),
    summary: normalizeString(record?.summary),
    rationale: normalizeString(record?.rationale),
    dedupeKey: normalizeString(record?.dedupeKey, id),
    sourceDiscoverySessionId: normalizeString(record?.sourceDiscoverySessionId),
    executionSessionId: normalizeString(record?.executionSessionId),
    executionStartedAt: toIsoTimestamp(record?.executionStartedAt),
    executionLastActivityAt: toIsoTimestamp(record?.executionLastActivityAt),
    executionStatus: normalizeString(record?.executionStatus),
    latestSummary: normalizeString(record?.latestSummary),
    contextRefs,
    planFilePath: normalizeString(record?.planFilePath, getRelativePlanMarkdownPath(id)),
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
    approvalMode: plan.approvalMode,
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

export function buildDiscoveryPlanExecutionPrompt(plan, planContent, projectName) {
  const autoSafety =
    plan.approvalMode === 'auto'
      ? [
          'Auto-execution safety boundary:',
          '- This plan may only do read-only preparation and write draft artifacts under `.claude/always-on/artifacts/`.',
          '- Do not modify product source code, tests, config, docs outside `.claude/always-on/artifacts/`, git state, schedules, or external services.',
          '- If the approved plan asks for anything outside that boundary, stop and explain that manual approval is required.',
          '',
        ]
      : [];

  return [
    `Always-On execution for project "${projectName}".`,
    '',
    'This plan is already approved.',
    'Execute the work directly.',
    'Do not enter Plan Mode.',
    'Do not create a second mini-plan before acting.',
    ...autoSafety,
    '',
    `Plan ID: ${plan.id}`,
    `Plan file: ${plan.planFilePath}`,
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

  const { projectRoot, store, index, plan } = match;
  if (plan.status === 'superseded') {
    const error = new Error('Superseded discovery plans cannot be executed');
    error.code = 'INVALID_STATE';
    throw error;
  }

  const executionStatus = computeExecutionStatus(plan, null);
  if (executionStatus === 'running' || executionStatus === 'queued') {
    const error = new Error('Discovery plan is already queued or running');
    error.code = 'ALREADY_RUNNING';
    throw error;
  }

  const content = await readDiscoveryPlanBody(projectRoot, plan.planFilePath);
  if (!normalizeString(content)) {
    const error = new Error('Discovery plan content is missing');
    error.code = 'MISSING_PLAN_BODY';
    throw error;
  }

  const now = new Date().toISOString();
  const updatedPlan = {
    ...plan,
    status: 'queued',
    executionStatus: 'queued',
    executionSessionId: '',
    executionStartedAt: '',
    executionLastActivityAt: '',
    latestSummary: '',
    updatedAt: now,
    lastExecutionSource: source
  };
  store.plans[index] = updatedPlan;
  await writeDiscoveryPlanStore(projectRoot, store);

  return {
    plan: buildDiscoveryPlanOverview(updatedPlan, content, null),
    sessionSummary: `Always-On: ${updatedPlan.title}`,
    command: buildDiscoveryPlanExecutionPrompt(updatedPlan, content, projectName),
    executionToken: randomUUID()
  };
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
  const nextPlan = {
    ...plan,
    executionSessionId: normalizeString(updates.executionSessionId, plan.executionSessionId),
    executionStartedAt: updates.executionStartedAt
      ? toIsoTimestamp(updates.executionStartedAt)
      : (normalizeString(updates.status) === 'running' && !plan.executionStartedAt
          ? now
          : plan.executionStartedAt),
    executionLastActivityAt: updates.executionLastActivityAt
      ? toIsoTimestamp(updates.executionLastActivityAt)
      : now,
    executionStatus: normalizeString(updates.status, plan.executionStatus),
    latestSummary: normalizeString(updates.latestSummary, plan.latestSummary),
    status:
      normalizeString(updates.status)
        ? normalizeString(updates.status)
        : plan.status,
    updatedAt: now
  };

  store.plans[index] = nextPlan;
  await writeDiscoveryPlanStore(projectRoot, store);

  const content = await readDiscoveryPlanBody(projectRoot, nextPlan.planFilePath);
  return buildDiscoveryPlanOverview(nextPlan, content, null);
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
