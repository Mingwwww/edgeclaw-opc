import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readDiscoveryPlanIndex, upsertDiscoveryPlans } from './alwaysOnDiscoveryPlans.js'

function validPlanContent(): string {
  return [
    '## Context',
    'A',
    '',
    '## Signals Reviewed',
    'B',
    '',
    '## Proposed Work',
    'C',
    '',
    '## Execution Steps',
    'D',
    '',
    '## Verification',
    'E',
    '',
    '## To-Do List',
    '- [ ] F',
  ].join('\n')
}

test('upsertDiscoveryPlans treats an empty input id as missing', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'always-on-empty-id-'))
  try {
    const [plan] = await upsertDiscoveryPlans(
      [
        {
          id: '',
          title: 'Create project skeleton',
          summary: 'Create the initial files.',
          rationale: 'The project has no source yet.',
          dedupeKey: 'project-skeleton',
          content: validPlanContent(),
        },
      ],
      projectRoot,
    )

    expect(plan.id.length).toBeGreaterThan(0)
    expect(plan.id).not.toBe('')
    expect(plan.planFilePath).not.toBe('.claude/always-on/plans/.md')
    expect(plan.planFilePath).toContain(`${plan.id}.md`)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test('upsertDiscoveryPlans ignores empty superseded plan ids', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'always-on-empty-supersedes-'))
  try {
    const [oldPlan] = await upsertDiscoveryPlans(
      [
        {
          title: 'Old plan',
          summary: 'Old summary.',
          rationale: 'Old rationale.',
          dedupeKey: 'old-plan',
          content: validPlanContent(),
        },
      ],
      projectRoot,
    )

    await upsertDiscoveryPlans(
      [
        {
          title: 'Replacement plan',
          summary: 'Replacement summary.',
          rationale: 'Replacement rationale.',
          dedupeKey: 'replacement-plan',
          content: validPlanContent(),
          supersedesPlanIds: ['', '   ', oldPlan.id],
        },
      ],
      projectRoot,
    )

    const index = await readDiscoveryPlanIndex(projectRoot)
    expect(index.plans.find(plan => plan.id === oldPlan.id)?.status).toBe('superseded')
    expect(index.plans.some(plan => plan.id === '')).toBe(false)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

