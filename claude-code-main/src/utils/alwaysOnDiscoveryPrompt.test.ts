import { expect, test } from 'bun:test'
import { AlwaysOnDiscoveryPlanTool } from '../tools/AlwaysOnDiscoveryPlanTool/AlwaysOnDiscoveryPlanTool.js'
import { PROMPT as alwaysOnDiscoveryPlanToolPrompt } from '../tools/AlwaysOnDiscoveryPlanTool/prompt.js'
import {
  buildAlwaysOnDiscoveryPrompt,
  normalizeAlwaysOnDiscoveryPromptLanguage,
} from './alwaysOnDiscoveryPrompt.js'

test('buildAlwaysOnDiscoveryPrompt defaults to English', () => {
  const prompt = buildAlwaysOnDiscoveryPrompt('/tmp/project')

  expect(prompt).toContain('Always-On discovery planning')
  expect(prompt).toContain('recent chats win')
  expect(prompt).toContain('final reply')
  expect(prompt).not.toContain('主动发现规划')
})

test('buildAlwaysOnDiscoveryPrompt supports Simplified Chinese', () => {
  const prompt = buildAlwaysOnDiscoveryPrompt('/tmp/project', 'zh-CN')

  expect(prompt).toContain('Always-On 主动发现规划')
  expect(prompt).toContain('近期聊天语言为准')
  expect(prompt).toContain('最终回复')
  expect(prompt).toContain('## To-Do List')
  expect(prompt).toContain('- [ ] 检查当前行为')
})

test('normalizeAlwaysOnDiscoveryPromptLanguage falls back to English', () => {
  expect(normalizeAlwaysOnDiscoveryPromptLanguage('zh-CN')).toBe('zh-CN')
  expect(normalizeAlwaysOnDiscoveryPromptLanguage('en')).toBe('en')
  expect(normalizeAlwaysOnDiscoveryPromptLanguage('fr')).toBe('en')
  expect(normalizeAlwaysOnDiscoveryPromptLanguage(undefined)).toBe('en')
})

test('AlwaysOnDiscoveryPlan tool prompt explains recent chat language priority', () => {
  expect(alwaysOnDiscoveryPlanToolPrompt).toContain('contextRefs.recentChats')
  expect(alwaysOnDiscoveryPlanToolPrompt).toContain('recent chats win')
  expect(alwaysOnDiscoveryPlanToolPrompt).toContain('saved plan markdown body')
})

test('AlwaysOnDiscoveryPlan tool schema rejects empty ids', () => {
  const result = AlwaysOnDiscoveryPlanTool.inputSchema.safeParse({
    plans: [
      {
        id: '',
        title: 'Plan',
        summary: 'Summary',
        rationale: 'Rationale',
        dedupeKey: 'plan',
        content: [
          '## Context',
          'A',
          '## Signals Reviewed',
          'B',
          '## Proposed Work',
          'C',
          '## Execution Steps',
          'D',
          '## Verification',
          'E',
          '## To-Do List',
          '- [ ] F',
        ].join('\n'),
      },
    ],
  })

  expect(result.success).toBe(false)
})

test('AlwaysOnDiscoveryPlan tool schema rejects empty superseded ids', () => {
  const result = AlwaysOnDiscoveryPlanTool.inputSchema.safeParse({
    plans: [
      {
        title: 'Plan',
        summary: 'Summary',
        rationale: 'Rationale',
        dedupeKey: 'plan',
        content: [
          '## Context',
          'A',
          '## Signals Reviewed',
          'B',
          '## Proposed Work',
          'C',
          '## Execution Steps',
          'D',
          '## Verification',
          'E',
          '## To-Do List',
          '- [ ] F',
        ].join('\n'),
        supersedesPlanIds: [''],
      },
    ],
  })

  expect(result.success).toBe(false)
})
