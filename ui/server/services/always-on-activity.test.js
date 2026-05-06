import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendAlwaysOnActivity,
  getAlwaysOnInboxSummary,
  getActivityPath,
  markAlwaysOnActivityReviewed,
  markAlwaysOnActivitySeen,
  readAlwaysOnActivities,
} from './always-on-activity.js';

const tempDirs = [];

async function createTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('activity store appends reads and summarizes attention state', async () => {
  const projectRoot = await createTempDir('always-on-activity-');

  await appendAlwaysOnActivity(projectRoot, {
    id: 'activity-1',
    kind: 'plan_created',
    targetType: 'plan',
    targetId: 'plan-alpha',
    title: 'Plan Alpha',
    summary: 'Created a new plan.',
    happenedAt: '2026-04-20T10:00:00.000Z',
    severity: 'review',
  });
  await appendAlwaysOnActivity(projectRoot, {
    id: 'activity-2',
    kind: 'run_failed',
    targetType: 'run',
    targetId: 'run-alpha',
    title: 'Run Alpha',
    summary: 'Run failed.',
    happenedAt: '2026-04-20T10:05:00.000Z',
    severity: 'error',
  });
  await fs.appendFile(getActivityPath(projectRoot), 'not json\n', 'utf8');

  const activity = await readAlwaysOnActivities(projectRoot);
  assert.equal(activity.activities.length, 2);
  assert.equal(activity.activities[0].id, 'activity-2');

  const summary = await getAlwaysOnInboxSummary(projectRoot);
  assert.equal(summary.unseenCount, 2);
  assert.equal(summary.needsReviewCount, 2);
  assert.equal(summary.totalAttentionCount, 2);
  assert.equal(summary.newPlansCount, 1);
  assert.equal(summary.failedRunsCount, 1);
});

test('marking activity seen and reviewed updates summary counts', async () => {
  const projectRoot = await createTempDir('always-on-activity-review-');

  await appendAlwaysOnActivity(projectRoot, {
    id: 'activity-review',
    kind: 'plan_updated',
    targetType: 'plan',
    targetId: 'plan-alpha',
    title: 'Plan Alpha',
    summary: 'Updated plan.',
    happenedAt: '2026-04-20T10:00:00.000Z',
    severity: 'review',
  });

  await markAlwaysOnActivitySeen(projectRoot, 'activity-review');
  let summary = await getAlwaysOnInboxSummary(projectRoot);
  assert.equal(summary.unseenCount, 0);
  assert.equal(summary.needsReviewCount, 1);

  await markAlwaysOnActivityReviewed(projectRoot, 'activity-review');
  summary = await getAlwaysOnInboxSummary(projectRoot);
  assert.equal(summary.unseenCount, 0);
  assert.equal(summary.needsReviewCount, 0);
  assert.equal(summary.updatedPlansCount, 0);
});
