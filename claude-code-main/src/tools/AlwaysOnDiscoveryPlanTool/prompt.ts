export const DESCRIPTION =
  'Create or update structured Always-On discovery plans stored in .claude/always-on'

export const PROMPT = `Use this tool during Always-On discovery when you have identified worthwhile follow-up work.

Use it to persist one or more discovery plans with fixed metadata and markdown content.

Rules:
- Save at most 1 worthwhile plan; Always-On executes saved ready plans later in an isolated worktree/mirror.
- Do not execute the plan in this discovery tool call.
- Do not create cron jobs during discovery.
- Each plan markdown must include these sections exactly:
  - ## Context
  - ## Signals Reviewed
  - ## Proposed Work
  - ## Execution Steps
  - ## Verification
  - ## To-Do List
- The \`## To-Do List\` section must use Markdown task list items such as \`- [ ] Review the current behavior\`.
- Language: if \`contextRefs.recentChats\` or the provided discovery context includes recent chat records, infer the primary language of those recent chats. Use that language for each saved plan markdown body and for the final discovery reply. If it differs from the UI or prompt language, recent chats win. If no recent chat language is discernible, use the active prompt language.
- If a new plan replaces older discovery plans, list their IDs in \`supersedesPlanIds\`.
- If there is no worthwhile work, do not call this tool.

The tool writes plan metadata to \`.claude/always-on/discovery-plans.json\` and markdown bodies to \`.claude/always-on/plans/<planId>.md\`.`
