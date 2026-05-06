import { describe, expect, it, vi } from 'vitest';
import type { ExecuteDiscoveryPlanResponse } from '../../../types/app';
import { handleAlwaysOnSlashAction } from './alwaysOnSlashActions';

const executionPayload: ExecuteDiscoveryPlanResponse = {
  plan: {
    id: 'plan-alpha',
    title: 'Investigate flaky tests',
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    status: 'queued',
    summary: 'Stabilize the flaky test suite.',
    rationale: 'Reduce CI noise.',
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
    content: '## Context',
  },
  sessionSummary: 'Always-On: Investigate flaky tests',
  command: 'Always-On execution prompt',
  executionToken: 'token-123',
};

describe('handleAlwaysOnSlashAction', () => {
  it('adds a message and launches queued discovery plans', async () => {
    const addMessage = vi.fn();
    const onLaunchAlwaysOnPlanExecution = vi.fn().mockResolvedValue(undefined);

    await handleAlwaysOnSlashAction({
      data: {
        mode: 'run-plan',
        content: 'Queued discovery plan `plan-alpha` for execution.',
        execution: executionPayload,
      },
      addMessage,
      onLaunchAlwaysOnPlanExecution,
    });

    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(addMessage).toHaveBeenCalledWith({
      type: 'assistant',
      content: 'Queued discovery plan `plan-alpha` for execution.',
      timestamp: expect.any(Number),
    });
    expect(onLaunchAlwaysOnPlanExecution).toHaveBeenCalledTimes(1);
    expect(onLaunchAlwaysOnPlanExecution).toHaveBeenCalledWith(executionPayload);
  });

  it('only echoes list and status results', async () => {
    const addMessage = vi.fn();
    const onLaunchAlwaysOnPlanExecution = vi.fn();

    await handleAlwaysOnSlashAction({
      data: {
        mode: 'message',
        content: '# Always-On\n\n## Cron jobs (0)',
      },
      addMessage,
      onLaunchAlwaysOnPlanExecution,
    });

    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(onLaunchAlwaysOnPlanExecution).not.toHaveBeenCalled();
  });
});
