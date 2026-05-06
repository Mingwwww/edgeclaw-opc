import { describe, expect, it } from 'vitest';
import type { DiscoveryPlanOverview } from '../types/app';
import { isAutoExecutableDiscoveryPlan } from './alwaysOnPlanExecution';

const basePlan: DiscoveryPlanOverview = {
  id: 'plan-alpha',
  title: 'Plan Alpha',
  createdAt: '2026-04-20T10:00:00.000Z',
  updatedAt: '2026-04-20T10:00:00.000Z',
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

describe('isAutoExecutableDiscoveryPlan', () => {
  it('auto-executes ready plans without requiring mode metadata', () => {
    expect(isAutoExecutableDiscoveryPlan(basePlan, new Set())).toBe(true);
  });

  it('skips plans that are already running or in flight', () => {
    expect(isAutoExecutableDiscoveryPlan({ ...basePlan, status: 'queued' }, new Set())).toBe(false);
    expect(isAutoExecutableDiscoveryPlan({ ...basePlan, executionSessionId: 'session-123' }, new Set())).toBe(false);
    expect(isAutoExecutableDiscoveryPlan(basePlan, new Set(['plan-alpha']))).toBe(false);
  });

  it('skips malformed ready plans without an id', () => {
    expect(isAutoExecutableDiscoveryPlan({ ...basePlan, id: '' }, new Set())).toBe(false);
    expect(isAutoExecutableDiscoveryPlan({ ...basePlan, id: '   ' }, new Set())).toBe(false);
  });
});

