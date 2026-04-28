/**
 * Policy Limits Service (stubbed)
 */

export function _resetPolicyLimitsForTesting(): void {}

export function initializePolicyLimitsLoadingPromise(): void {}

export function isPolicyLimitsEligible(): boolean {
  return false
}

export async function waitForPolicyLimitsToLoad(): Promise<void> {
  return Promise.resolve()
}

export function isPolicyAllowed(_policy: string): boolean {
  return true
}

export async function loadPolicyLimits(): Promise<void> {
  return Promise.resolve()
}

export async function refreshPolicyLimits(): Promise<void> {
  return Promise.resolve()
}

export async function clearPolicyLimitsCache(): Promise<void> {
  return Promise.resolve()
}

export function startBackgroundPolling(): void {}

export function stopBackgroundPolling(): void {}
