import { z } from 'zod/v4'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman, parseCronExpression } from '../../utils/cron.js'
import {
  getCronFilePath,
  nextCronRunMs,
} from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { requestCronDaemon } from '../../daemon/client.js'
import { assertCronDaemonOk } from '../../daemon/ipc.js'
import {
  buildCronCreateDescription,
  buildCronCreatePrompt,
  CRON_CREATE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderCreateResultMessage, renderCreateToolUseMessage } from './UI.js'

const MAX_JOBS = 50

const inputSchema = lazySchema(() =>
  z.strictObject({
    cron: z
      .string()
      .describe(
        'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
      ),
    prompt: z.string().describe('The prompt to enqueue at each fire time.'),
    recurring: semanticBoolean(z.boolean().optional()).describe(
      `true (default) = fire on every cron match until deleted or auto-expired after ${DEFAULT_MAX_AGE_DAYS} days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.`,
    ),
    durable: semanticBoolean(z.boolean().optional()).describe(
      'true = persist to .claude/scheduled_tasks.json and survive restarts. false (default) = session-scoped in the Cron daemon, stored separately from durable jobs and restored when the daemon restarts. Use true only when the user asks the task to survive across sessions.',
    ),
    manualOnly: semanticBoolean(z.boolean().optional()).describe(
      'true = create a proposal that appears in Always-On but never fires automatically on schedule. Use this when the task should wait for explicit user approval or a manual "Run now".',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    humanSchedule: z.string(),
    recurring: z.boolean(),
    durable: z.boolean().optional(),
      manualOnly: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type CreateOutput = z.infer<OutputSchema>

export const CronCreateTool = buildTool({
  name: CRON_CREATE_TOOL_NAME,
  searchHint: 'schedule a recurring or one-shot prompt',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  toAutoClassifierInput(input) {
    return `${input.cron}: ${input.prompt}`
  },
  async description() {
    return buildCronCreateDescription(isDurableCronEnabled())
  },
  async prompt() {
    return buildCronCreatePrompt(isDurableCronEnabled())
  },
  getPath() {
    return getCronFilePath()
  },
  async validateInput(input): Promise<ValidationResult> {
    if (!parseCronExpression(input.cron)) {
      return {
        result: false,
        message: `Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.`,
        errorCode: 1,
      }
    }
    if (nextCronRunMs(input.cron, Date.now()) === null) {
      return {
        result: false,
        message: `Cron expression '${input.cron}' does not match any calendar date in the next year.`,
        errorCode: 2,
      }
    }
    const listResponse = await requestCronDaemon({
      type: 'list_tasks',
      projectRoot: getProjectRoot(),
      originSessionId: getSessionId(),
    })
    assertCronDaemonOk(listResponse)
    if (listResponse.data.type !== 'list_tasks') {
      throw new Error('Unexpected Cron daemon list response')
    }
    const tasks = listResponse.data.tasks
    if (tasks.length >= MAX_JOBS) {
      return {
        result: false,
        message: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`,
        errorCode: 3,
      }
    }
    // Teammates don't persist across sessions, so a durable teammate cron
    // would orphan on restart (agentId would point to a nonexistent teammate).
    if (input.durable && getTeammateContext()) {
      return {
        result: false,
        message:
          'durable crons are not supported for teammates (teammates do not persist across sessions)',
        errorCode: 4,
      }
    }
    return { result: true }
  },
  async call({
    cron,
    prompt,
    recurring = true,
    durable = false,
    manualOnly = false,
  }, context) {
    // Kill switch forces session-only; schema stays stable so the model sees
    // no validation errors when the gate flips mid-session.
    const effectiveDurable = durable && isDurableCronEnabled()
    const { alwaysAllowRules } = context.getAppState().toolPermissionContext
    const allowedTools = [
      ...(alwaysAllowRules.session ?? []),
      ...(alwaysAllowRules.cliArg ?? []),
    ]
    const response = await requestCronDaemon({
      type: 'create_task',
      projectRoot: getProjectRoot(),
      originSessionId: getSessionId(),
      cron,
      prompt,
      recurring,
      durable: effectiveDurable,
      manualOnly,
      agentId: getTeammateContext()?.agentId,
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
    })
    assertCronDaemonOk(response)
    if (response.data.type !== 'create_task') {
      throw new Error('Unexpected Cron daemon create response')
    }
    return {
      data: {
        id: response.data.task.id,
        humanSchedule: cronToHuman(cron),
        recurring,
        durable: effectiveDurable,
        manualOnly,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const where = output.durable
      ? 'Persisted to .claude/scheduled_tasks.json'
      : 'Session-scoped in the Cron daemon (stored separately from .claude/scheduled_tasks.json and restored across daemon restarts)'
    const executionMode = output.manualOnly
      ? ' Manual-only: it will not run on schedule until explicitly triggered.'
      : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.recurring
        ? `Scheduled recurring job ${output.id} (${output.humanSchedule}). ${where}.${executionMode} Auto-expires after ${DEFAULT_MAX_AGE_DAYS} days. Use CronDelete to cancel sooner.`
        : `Scheduled one-shot task ${output.id} (${output.humanSchedule}). ${where}.${executionMode}${output.manualOnly ? '' : ' It will fire once then auto-delete.'}`,
    }
  },
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)
