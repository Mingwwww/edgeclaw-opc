import { basename } from 'path'
import { ALWAYS_ON_DISCOVERY_PLAN_TOOL_NAME } from '../tools/AlwaysOnDiscoveryPlanTool/constants.js'

export function buildAlwaysOnDiscoveryPrompt(projectRoot: string): string {
  const displayName = basename(projectRoot) || projectRoot
  return [
    `Always-On discovery planning for project "${displayName}".`,
    '',
    'Your job is discovery only.',
    'Inspect the current workspace and decide whether there are worthwhile follow-up tasks.',
    '',
    'Requirements:',
    `1. Inspect the current workspace at \`${projectRoot}\`.`,
    '2. If there is no worthwhile follow-up work, explain why and stop without saving any plans.',
    `3. If there is worthwhile work, use \`${ALWAYS_ON_DISCOVERY_PLAN_TOOL_NAME}\` to persist structured discovery plans.`,
    '4. Every saved plan must include these markdown sections exactly:',
    '   - `## Context`',
    '   - `## Signals Reviewed`',
    '   - `## Proposed Work`',
    '   - `## Execution Steps`',
    '   - `## Verification`',
    '   - `## Approval And Execution`',
    '5. Use `approvalMode: "manual"` unless the work is clearly safe and suitable for auto-execution.',
    '6. Do not call `CronCreate`, do not execute the work now, and do not start background tasks.',
    '7. In your final reply, summarize what you reviewed and which discovery plan IDs were created or updated.',
  ].join('\n')
}
