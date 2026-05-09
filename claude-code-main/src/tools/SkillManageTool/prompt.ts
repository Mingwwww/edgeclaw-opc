import { SKILL_MANAGE_TOOL_NAME } from './constants.js'

export const DESCRIPTION =
  'Create, patch, edit, or delete skills in ~/.claude/skills (user) or ' +
  '<cwd>/.claude/skills (project). Use this instead of raw file edits so ' +
  'frontmatter is validated, writes are atomic, and the skill cache is ' +
  'invalidated immediately.'

export function getSkillManageToolPrompt(): string {
  return `Manage skills — Claude Code's procedural memory — via a single tool with six actions.

## When to use

- **create**: you discovered a non-trivial workflow (5+ tool calls, errors overcome, or a user-corrected approach). Persist it as a skill so future sessions can \`/skill-name\` it.
- **patch** (preferred for fixes): you loaded an existing skill via \`Skill\`, followed it, and found a bug/missing step. Fix the skill *before* finishing the user's task. Uses fuzzy matching — whitespace and indentation differences are tolerated.
- **edit**: full SKILL.md rewrite (major structural overhaul only). Prefer \`patch\` when possible.
- **delete**: remove a skill entirely. Confirm with the user first.
- **write_file** / **remove_file**: add or remove supporting files under \`references/\`, \`templates/\`, \`scripts/\`, or \`assets/\`.

Do NOT use this tool for one-off tasks, trivial instructions, or for data that belongs in memory (CLAUDE.md / CLAUDE.local.md).

## Scope

- \`scope: "user"\` (default) → \`~/.claude/skills/<name>/\` — follows the user across repos.
- \`scope: "project"\` → \`<cwd>/.claude/skills/<name>/\` — lives with the project.

Pick based on the skill's reusability: repo-specific workflow → project, personal workflow → user.

**IMPORTANT**: In general chat (no real project context), ALWAYS use \`scope: "user"\`. Project scope is only valid inside a real project directory. If you're unsure, default to \`scope: "user"\`.

## SKILL.md format (create / edit)

Must start with YAML frontmatter:

\`\`\`yaml
---
name: my-skill
description: One-line description (<=1024 chars). Shown in skill index.
when_to_use: "Use when the user wants X. Examples: 'do X', 'handle X'."
allowed-tools:
  - Read
  - Bash(gh:*)
---

# My Skill

## Goal
...

## Steps
...
\`\`\`

Body after frontmatter is required. Keep SKILL.md under ~100k chars; put long reference docs in \`references/\` via \`write_file\`.

## Patch action

Provide \`old_string\` (text to find) and \`new_string\` (replacement). The match must be unique unless \`replace_all: true\`. Fuzzy matching tolerates minor whitespace/indentation drift, so you can quote the snippet you see in the skill even if its exact byte representation differs.

If the patch would break the SKILL.md frontmatter structure, it's rejected — use \`edit\` for structural rewrites.

## Cache invalidation

After a successful mutation, the skill cache is cleared automatically so \`${SKILL_MANAGE_TOOL_NAME}\` → \`Skill(name='my-skill')\` in the same session will see the new content.

## Do NOT

- Write to skill directories with \`Write\`/\`Edit\` — use this tool so validation and cache invalidation run. Skills created via raw file writes will NOT appear in the skills panel until the next session.
- Create a skill for a trivial, one-off instruction.
- Use \`scope: "project"\` in a general chat context (no project open) — the skill will be invisible to the UI.
- Leave a skill you found to be buggy unpatched after a successful recovery. Patch it in the same turn.
`
}
