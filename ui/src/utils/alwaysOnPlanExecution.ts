import type { DiscoveryPlanOverview } from '../types/app';

export function isAutoExecutableDiscoveryPlan(
  plan: DiscoveryPlanOverview,
  inFlightPlanIds: ReadonlySet<string>,
): boolean {
  const planId = typeof plan.id === 'string' ? plan.id.trim() : '';
  return (
    planId.length > 0 &&
    plan.status === 'ready' &&
    !plan.executionSessionId &&
    !inFlightPlanIds.has(planId)
  );
}

