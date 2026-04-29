export function buildAlwaysOnDiscoveryPrompt(projectRoot: string): string {
  return [
    `Always-On discovery planning for project at \`${projectRoot}\`.`,
    '',
    'Your job is discovery only.',
    'Inspect the workspace and decide whether there are worthwhile follow-up tasks.',
    '',
    'Requirements:',
    '1. If there is no worthwhile follow-up work, explain why and stop without saving plans.',
    '2. If there is worthwhile work, use `AlwaysOnDiscoveryPlan` to persist up to 3 plans.',
    '3. Every saved plan must include `## Context`, `## Signals Reviewed`, `## Proposed Work`, `## Execution Steps`, `## Verification`, and `## Approval And Execution`.',
    '4. Pay special attention to future commitments: meetings, demos, launches, reviews, deadlines, interviews, and reports.',
    '5. If a reminder implies a deliverable, propose preparation work before the reminder fires. Examples: "remind me to present X" -> prepare a briefing draft; "demo X next week" -> prepare a demo script and risk checklist.',
    '6. Use `approvalMode: "auto"` only for safe read-only preparation that writes a draft artifact under `.claude/always-on/artifacts/` and does not modify product source, commit, push, deploy, or contact external services.',
    '7. Use `approvalMode: "manual"` for anything that changes source code, config, schedules, external systems, or user-visible product behavior.',
    '8. Do not call `CronCreate`, do not execute the work now, and do not start background tasks.',
    '9. In your final reply, summarize what you reviewed and which discovery plan IDs were created or updated.',
  ].join('\n')
}
