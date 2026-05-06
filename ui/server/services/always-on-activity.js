import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getAlwaysOnRoot } from './always-on-paths.js';

const ACTIVITY_FILE_NAME = 'activity.jsonl';
const ACTIVITY_MAX_ITEMS = 500;
const VALID_KINDS = new Set([
  'plan_created',
  'plan_updated',
  'plan_merged',
  'cron_ran',
  'run_failed',
  'run_completed',
]);
const VALID_TARGET_TYPES = new Set(['plan', 'cron', 'run']);
const VALID_SEVERITIES = new Set(['info', 'review', 'warning', 'error']);
const REVIEW_SEVERITIES = new Set(['review', 'warning', 'error']);

function normalizeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toIsoTimestamp(value) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function getActivityPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), ACTIVITY_FILE_NAME);
}

function normalizeActivity(activity) {
  const kind = normalizeString(activity?.kind);
  const targetType = normalizeString(activity?.targetType);
  const targetId = normalizeString(activity?.targetId);
  if (!VALID_KINDS.has(kind) || !VALID_TARGET_TYPES.has(targetType) || !targetId) {
    return null;
  }

  const severity = normalizeString(activity?.severity, 'info');
  const happenedAt = toIsoTimestamp(activity?.happenedAt) || new Date().toISOString();
  const id = normalizeString(activity?.id, `${kind}:${targetType}:${targetId}:${happenedAt}:${randomUUID()}`);

  return {
    id,
    kind,
    targetType,
    targetId,
    title: normalizeString(activity?.title, targetId),
    summary: normalizeString(activity?.summary),
    happenedAt,
    severity: VALID_SEVERITIES.has(severity) ? severity : 'info',
    seenAt: toIsoTimestamp(activity?.seenAt) || undefined,
    reviewedAt: toIsoTimestamp(activity?.reviewedAt) || undefined,
    metadata: sanitizeMetadata(activity?.metadata),
  };
}

async function readAllActivities(projectRoot) {
  let raw = '';
  try {
    raw = await fs.readFile(getActivityPath(projectRoot), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const activities = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const activity = normalizeActivity(JSON.parse(line));
      if (activity) activities.push(activity);
    } catch {
      // Ignore partially written or manually edited bad lines.
    }
  }
  return activities.sort((left, right) => {
    const leftTime = Date.parse(left.happenedAt) || 0;
    const rightTime = Date.parse(right.happenedAt) || 0;
    return rightTime - leftTime;
  });
}

async function writeAllActivities(projectRoot, activities) {
  await fs.mkdir(getAlwaysOnRoot(projectRoot), { recursive: true });
  const lines = activities.map(activity => JSON.stringify(activity)).join('\n');
  await fs.writeFile(getActivityPath(projectRoot), lines ? `${lines}\n` : '', 'utf8');
}

export async function appendAlwaysOnActivity(projectRoot, activity) {
  const normalized = normalizeActivity(activity);
  if (!normalized) {
    return null;
  }
  await fs.mkdir(getAlwaysOnRoot(projectRoot), { recursive: true });
  await fs.appendFile(getActivityPath(projectRoot), `${JSON.stringify(normalized)}\n`, 'utf8');
  return normalized;
}

export async function readAlwaysOnActivities(projectRoot, { limit = ACTIVITY_MAX_ITEMS } = {}) {
  const activities = await readAllActivities(projectRoot);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : ACTIVITY_MAX_ITEMS;
  return {
    activities: activities.slice(0, safeLimit),
  };
}

async function markActivity(projectRoot, activityId, field) {
  const normalizedId = normalizeString(activityId);
  if (!normalizedId) {
    const error = new Error('Activity id is required');
    error.code = 'INVALID_INPUT';
    throw error;
  }

  const activities = await readAllActivities(projectRoot);
  const index = activities.findIndex(activity => activity.id === normalizedId);
  if (index === -1) {
    const error = new Error('Activity not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const now = new Date().toISOString();
  activities[index] = {
    ...activities[index],
    [field]: activities[index][field] || now,
    ...(field === 'reviewedAt' ? { seenAt: activities[index].seenAt || now } : {}),
  };
  await writeAllActivities(projectRoot, activities);
  return activities[index];
}

export async function markAlwaysOnActivitySeen(projectRoot, activityId) {
  return markActivity(projectRoot, activityId, 'seenAt');
}

export async function markAlwaysOnActivityReviewed(projectRoot, activityId) {
  return markActivity(projectRoot, activityId, 'reviewedAt');
}

export async function getAlwaysOnInboxSummary(projectRoot) {
  const activities = await readAllActivities(projectRoot);
  const unseen = activities.filter(activity => !activity.seenAt);
  const needsReview = activities.filter(
    activity => REVIEW_SEVERITIES.has(activity.severity) && !activity.reviewedAt,
  );
  const updatedPlans = activities.filter(activity => activity.kind === 'plan_updated' && !activity.seenAt);
  const newPlans = activities.filter(activity => activity.kind === 'plan_created' && !activity.seenAt);
  const failedRuns = activities.filter(activity => activity.kind === 'run_failed' && !activity.reviewedAt);
  const attentionIds = new Set([
    ...unseen.map(activity => activity.id),
    ...needsReview.map(activity => activity.id),
  ]);

  const parts = [];
  if (updatedPlans.length > 0) parts.push(`${updatedPlans.length} updates`);
  if (newPlans.length > 0) parts.push(`${newPlans.length} new`);
  if (failedRuns.length > 0) parts.push(`${failedRuns.length} failed`);

  return {
    unseenCount: unseen.length,
    needsReviewCount: needsReview.length,
    updatedPlansCount: updatedPlans.length,
    newPlansCount: newPlans.length,
    failedRunsCount: failedRuns.length,
    totalAttentionCount: attentionIds.size,
    headline: parts.join(' · '),
    latestActivity: activities[0] || null,
  };
}

export {
  getActivityPath,
};
