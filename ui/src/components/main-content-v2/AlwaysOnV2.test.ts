import { describe, expect, it } from 'vitest';
import type { AlwaysOnRunHistoryEntry, CronJobOverview, DiscoveryPlanOverview } from '../../types/app';
import {
  getVisibleRunMetadataEntries,
  getPlanRowTitle,
  isActiveCronJob,
  isActivePlan,
  isVisibleRunHistoryEntry,
  shouldPollRunLog,
} from './AlwaysOnV2';

const basePlan: DiscoveryPlanOverview = {
  id: 'plan-alpha',
  title: 'Plan Alpha',
  createdAt: '2026-04-20T10:00:00.000Z',
  updatedAt: '2026-04-20T10:00:00.000Z',
  approvalMode: 'manual',
  status: 'ready',
  summary: '',
  rationale: '',
  dedupeKey: 'plan-alpha',
  sourceDiscoverySessionId: '',
  contextRefs: {
    workingDirectory: [],
    memory: [],
    existingPlans: [],
    cronJobs: [],
    recentChats: [],
  },
  planFilePath: '.claude/always-on/plans/plan-alpha.md',
  structureVersion: 1,
  content: '',
};

const baseCronJob: CronJobOverview = {
  id: 'cron-alpha',
  cron: '* * * * *',
  prompt: 'Run maintenance',
  createdAt: 1770000000000,
  recurring: false,
  status: 'scheduled',
};

describe('AlwaysOnV2 active item filtering', () => {
  it('hides completed plans from the active list', () => {
    expect(isActivePlan({ ...basePlan, status: 'completed' })).toBe(false);
    expect(isActivePlan({ ...basePlan, executionStatus: 'completed' })).toBe(false);
  });

  it('hides superseded plans from the active list', () => {
    expect(isActivePlan({ ...basePlan, status: 'superseded' })).toBe(false);
  });

  it('keeps failed and running plans visible in the active list', () => {
    expect(isActivePlan({ ...basePlan, status: 'failed' })).toBe(true);
    expect(isActivePlan({ ...basePlan, status: 'running' })).toBe(true);
  });

  it('uses the plan title instead of the markdown file name for plan rows', () => {
    expect(
      getPlanRowTitle({
        ...basePlan,
        title: 'Investigate flaky tests',
        planFilePath: '.claude/always-on/plans/foamy-wibbling-salamander.md',
      }),
    ).toBe('Investigate flaky tests');
  });

  it('hides completed one-shot cron jobs from the active list', () => {
    expect(isActiveCronJob({ ...baseCronJob, recurring: false, status: 'completed' })).toBe(false);
  });

  it('keeps recurring cron jobs visible even after a completed run', () => {
    expect(isActiveCronJob({ ...baseCronJob, recurring: true, status: 'completed' })).toBe(true);
  });

  it('keeps failed running and scheduled cron jobs visible in the active list', () => {
    expect(isActiveCronJob({ ...baseCronJob, status: 'failed' })).toBe(true);
    expect(isActiveCronJob({ ...baseCronJob, status: 'running' })).toBe(true);
    expect(isActiveCronJob({ ...baseCronJob, status: 'scheduled' })).toBe(true);
  });

  it('hides unknown run history entries from history lists', () => {
    const baseRun: AlwaysOnRunHistoryEntry = {
      runId: 'run-1',
      title: 'Run 1',
      kind: 'cron',
      status: 'completed',
      sourceId: 'cron-1',
    };

    expect(isVisibleRunHistoryEntry(baseRun)).toBe(true);
    expect(isVisibleRunHistoryEntry({ ...baseRun, status: 'unknown' })).toBe(false);
  });

  it('polls run logs only while queued or running', () => {
    expect(shouldPollRunLog('queued')).toBe(true);
    expect(shouldPollRunLog('running')).toBe(true);
    expect(shouldPollRunLog('completed')).toBe(false);
    expect(shouldPollRunLog('failed')).toBe(false);
    expect(shouldPollRunLog('unknown')).toBe(false);
  });

  it('hides internal run metadata keys from history detail metadata', () => {
    const entries = getVisibleRunMetadataEntries({
      source: 'manual',
      sourceId: 'plan-alpha',
      parentSessionId: 'origin-session',
      originSessionId: 'origin-session',
      logUpdatedAt: '2026-04-29T14:31:14.104Z',
      sessionId: 'background-origin-session-agent-cron-thread',
      planFilePath: '.claude/always-on/plans/plan-alpha.md',
      logSize: 800,
      logSource: 'log-file',
      logTruncated: false,
    });

    expect(entries).toEqual([
      ['originSessionId', 'origin-session'],
      ['sessionId', 'background-origin-session-agent-cron-thread'],
      ['planFilePath', '.claude/always-on/plans/plan-alpha.md'],
      ['logSource', 'log-file'],
    ]);
  });
});
