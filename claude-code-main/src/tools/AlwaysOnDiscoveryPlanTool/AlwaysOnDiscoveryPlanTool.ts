import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  type DiscoveryPlanContextRefs,
  type DiscoveryPlanRecord,
  upsertDiscoveryPlans,
} from '../../utils/alwaysOnDiscoveryPlans.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { ALWAYS_ON_DISCOVERY_PLAN_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const contextRefsSchema = z.strictObject({
  workingDirectory: z.array(z.string()).optional(),
  memory: z.array(z.string()).optional(),
  existingPlans: z.array(z.string()).optional(),
  cronJobs: z.array(z.string()).optional(),
  recentChats: z.array(z.string()).optional(),
})

const discoveryPlanSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional existing discovery plan ID to update.'),
  title: z.string().describe('Short plan title shown in the Always-On dashboard.'),
  summary: z
    .string()
    .describe('A brief summary of the value of this plan.'),
  rationale: z
    .string()
    .describe('Why this work is worth doing now.'),
  dedupeKey: z
    .string()
    .describe('Stable deduplication key for this plan idea.'),
  content: z
    .string()
    .describe('Full markdown plan body using the required Always-On discovery plan sections.'),
  contextRefs: contextRefsSchema
    .optional()
    .describe('Human-readable references summarizing the signals that informed this plan.'),
  supersedesPlanIds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe('Existing discovery plan IDs that should be marked superseded by this new plan.'),
})

const inputSchema = lazySchema(() =>
  z.strictObject({
    plans: z
      .array(discoveryPlanSchema)
      .min(1)
      .max(1)
      .describe('The discovery plans to create or update.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    savedPlans: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        planFilePath: z.string(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = {
  savedPlans: Array<Pick<DiscoveryPlanRecord, 'id' | 'title' | 'status' | 'planFilePath'>>
}

function normalizeContextRefs(
  input: Partial<DiscoveryPlanContextRefs> | undefined,
): Partial<DiscoveryPlanContextRefs> | undefined {
  if (!input) {
    return undefined
  }

  return {
    workingDirectory: Array.isArray(input.workingDirectory)
      ? input.workingDirectory
      : undefined,
    memory: Array.isArray(input.memory) ? input.memory : undefined,
    existingPlans: Array.isArray(input.existingPlans)
      ? input.existingPlans
      : undefined,
    cronJobs: Array.isArray(input.cronJobs) ? input.cronJobs : undefined,
    recentChats: Array.isArray(input.recentChats)
      ? input.recentChats
      : undefined,
  }
}

export const AlwaysOnDiscoveryPlanTool = buildTool({
  name: ALWAYS_ON_DISCOVERY_PLAN_TOOL_NAME,
  searchHint: 'save structured Always-On discovery plans',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ALWAYS_ON_DISCOVERY_PLAN_TOOL_NAME
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.plans.map(plan => plan.title).join(', ')
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  async call({ plans }) {
    const savedPlans = await upsertDiscoveryPlans(
      plans.map(plan => ({
        ...plan,
        contextRefs: normalizeContextRefs(plan.contextRefs),
      })),
    )

    return {
      data: {
        savedPlans: savedPlans.map(plan => ({
          id: plan.id,
          title: plan.title,
          status: plan.status,
          planFilePath: plan.planFilePath,
        })),
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const output = content as Output
    const rendered = output.savedPlans
      .map(
        plan =>
          `- ${plan.id}: ${plan.title} (${plan.status}) -> ${plan.planFilePath}`,
      )
      .join('\n')

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        output.savedPlans.length > 0
          ? `Saved ${output.savedPlans.length} Always-On discovery plan(s):\n${rendered}`
          : 'No Always-On discovery plans were saved.',
    }
  },
} satisfies ToolDef<InputSchema, Output>)
