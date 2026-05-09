/**
 * SkillManage tool — agent-managed skill self-evolution.
 *
 * Port of hermes-agent `tools/skill_manager_tool.py`. Exposes a single tool
 * with six actions (create / patch / edit / delete / write_file / remove_file)
 * so the agent can persist, refine, and retire skills on its own.
 *
 * Skills are stored under either ~/.claude/skills/<name>/ (scope: user, default)
 * or <cwd>/.claude/skills/<name>/ (scope: project). On success the skill cache
 * is invalidated so the updated SKILL.md is visible to the current session.
 */

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  clearDynamicSkills,
  clearSkillCaches,
} from '../../skills/loadSkillsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { isRestrictedToPluginOnly } from '../../utils/settings/pluginOnlyPolicy.js'
import {
  createSkill,
  deleteSkill,
  editSkill,
  findExistingSkill,
  isWithinAnySkillsRoot,
  patchSkill,
  removeSupportingFile,
  writeSupportingFile,
  type ActionInput,
  type ActionResult,
  type SkillsDirResolver,
} from './actions.js'
import {
  SKILL_MANAGE_ACTIONS,
  SKILL_MANAGE_TOOL_NAME,
  type SkillScope,
} from './constants.js'
import { DESCRIPTION, getSkillManageToolPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(SKILL_MANAGE_ACTIONS)
      .describe(
        "The action to perform: 'create', 'patch', 'edit', 'delete', " +
          "'write_file', or 'remove_file'.",
      ),
    name: z
      .string()
      .describe(
        'Skill name (lowercase letters/digits with dots, hyphens, underscores; ' +
          'max 64 chars). Must match an existing skill for patch/edit/delete/' +
          'write_file/remove_file.',
      ),
    scope: z
      .enum(['user', 'project'])
      .optional()
      .describe(
        "Where to store the skill. 'user' (default) = ~/.claude/skills; " +
          "'project' = <cwd>/.claude/skills. Only used for 'create'; other " +
          'actions resolve the skill automatically.',
      ),
    category: z
      .string()
      .optional()
      .describe(
        "Optional single-segment subdirectory (e.g. 'devops'). Used only " +
          "with 'create'.",
      ),
    content: z
      .string()
      .optional()
      .describe(
        'Full SKILL.md content (YAML frontmatter + markdown body). ' +
          "Required for 'create' and 'edit'.",
      ),
    old_string: z
      .string()
      .optional()
      .describe(
        "Text to find (required for 'patch'). Must be unique unless " +
          'replace_all=true.',
      ),
    new_string: z
      .string()
      .optional()
      .describe(
        "Replacement text (required for 'patch'). Empty string deletes " +
          'the matched text.',
      ),
    replace_all: z
      .boolean()
      .optional()
      .describe(
        "For 'patch': replace all occurrences instead of requiring uniqueness.",
      ),
    file_path: z
      .string()
      .optional()
      .describe(
        'Path to a supporting file within the skill directory. Required for ' +
          "'write_file'/'remove_file'; must be under references/, templates/, " +
          "scripts/, or assets/. For 'patch': optional, defaults to SKILL.md.",
      ),
    file_content: z
      .string()
      .optional()
      .describe("Content for the file. Required for 'write_file'."),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    name: z.string().optional(),
    path: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
    matchCount: z.number().optional(),
    strategy: z.string().optional(),
    filePreview: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>

const GENERAL_CWD_SUFFIXES = [
  `${sep}Claude${sep}general`,
  `${sep}.claude-gateway${sep}general`,
]

function isGeneralChatCwd(): boolean {
  const cwd = resolve(getCwd())
  return GENERAL_CWD_SUFFIXES.some(suffix => cwd.endsWith(suffix))
}

const defaultSkillsDirResolver: SkillsDirResolver = scope =>
  scope === 'project'
    ? join(getCwd(), '.claude', 'skills')
    : join(getClaudeConfigHomeDir(), 'skills')

export const SkillManageTool = buildTool({
  name: SKILL_MANAGE_TOOL_NAME,
  searchHint: 'create / patch / edit / delete skills',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getSkillManageToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'SkillManage'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    const parts = [input.action, input.name]
    if (input.scope) parts.push(`scope=${input.scope}`)
    if (input.file_path) parts.push(input.file_path)
    return parts.filter(Boolean).join(' ')
  },
  renderToolUseMessage() {
    return null
  },
  async checkPermissions(input): Promise<PermissionDecision> {
    if (isRestrictedToPluginOnly('skills')) {
      return {
        behavior: 'deny',
        message:
          'Skill mutations are disabled by the strictPluginOnlyCustomization policy.',
        decisionReason: {
          type: 'other',
          reason: 'strictPluginOnlyCustomization policy applies to skills',
        },
      }
    }

    if (input.action !== 'create') {
      const existing = findExistingSkill(input.name, defaultSkillsDirResolver)
      if (!existing) return { behavior: 'allow', updatedInput: input }
      if (isWithinAnySkillsRoot(existing.skillDir, defaultSkillsDirResolver)) {
        return { behavior: 'allow', updatedInput: input }
      }
      return {
        behavior: 'ask',
        message: `${input.action} skill '${input.name}' at ${existing.skillDir}?`,
      }
    }

    const scope: SkillScope =
      input.scope === 'project' && isGeneralChatCwd()
        ? 'user'
        : (input.scope ?? 'user')
    const root = defaultSkillsDirResolver(scope)
    if (
      resolve(root).startsWith(resolve(homedir())) ||
      resolve(root).startsWith(resolve(getCwd()))
    ) {
      return { behavior: 'allow', updatedInput: { ...input, scope } }
    }
    return {
      behavior: 'ask',
      message: `Create skill '${input.name}' at ${root}?`,
    }
  },
  async call(input: Input): Promise<{ data: Output }> {
    const effectiveScope: SkillScope | undefined =
      input.action === 'create' && input.scope === 'project' && isGeneralChatCwd()
        ? 'user'
        : input.scope

    const actionInput: ActionInput = {
      name: input.name,
      scope: effectiveScope,
      category: input.category,
      content: input.content,
      old_string: input.old_string,
      new_string: input.new_string,
      replace_all: input.replace_all,
      file_path: input.file_path,
      file_content: input.file_content,
    }

    let data: ActionResult
    try {
      switch (input.action) {
        case 'create':
          data = await createSkill(actionInput, defaultSkillsDirResolver)
          break
        case 'edit':
          data = await editSkill(actionInput, defaultSkillsDirResolver)
          break
        case 'patch':
          data = await patchSkill(actionInput, defaultSkillsDirResolver)
          break
        case 'delete':
          data = await deleteSkill(actionInput, defaultSkillsDirResolver)
          break
        case 'write_file':
          data = await writeSupportingFile(
            actionInput,
            defaultSkillsDirResolver,
          )
          break
        case 'remove_file':
          data = await removeSupportingFile(
            actionInput,
            defaultSkillsDirResolver,
          )
          break
        default: {
          const _exhaustive: never = input.action
          void _exhaustive
          data = {
            success: false,
            action: String(input.action),
            name: input.name,
            error: 'Unknown action.',
          }
        }
      }
    } catch (e) {
      data = {
        success: false,
        action: input.action,
        name: input.name,
        error: e instanceof Error ? e.message : String(e),
      }
    }

    if (data.success) {
      try {
        clearSkillCaches()
        clearDynamicSkills()
      } catch {
        /* best-effort */
      }
    }

    return { data }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const out = content as Output
    const lines: string[] = []
    lines.push(`${out.action}: ${out.success ? 'ok' : 'failed'}`)
    if (out.name) lines.push(`name: ${out.name}`)
    if (out.path) lines.push(`path: ${out.path}`)
    if (out.message) lines.push(out.message)
    if (out.strategy) lines.push(`match strategy: ${out.strategy}`)
    if (out.error) lines.push(`error: ${out.error}`)
    if (out.filePreview) lines.push(`preview:\n${out.filePreview}`)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
