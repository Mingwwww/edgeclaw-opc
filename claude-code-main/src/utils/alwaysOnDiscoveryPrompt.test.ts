import { describe, expect, test } from 'bun:test'
import { buildAlwaysOnDiscoveryPrompt } from './alwaysOnDiscoveryPrompt.js'

describe('buildAlwaysOnDiscoveryPrompt', () => {
  test('teaches discovery to treat future commitments as preparation signals', () => {
    const prompt = buildAlwaysOnDiscoveryPrompt('/workspace/edgeclaw-opc')

    expect(prompt).toContain('future commitments')
    expect(prompt).toContain('meetings, demos, launches, reviews, deadlines, interviews, and reports')
    expect(prompt).toContain('If a reminder implies a deliverable')
    expect(prompt).toContain('.claude/always-on/artifacts/')
    expect(prompt).toContain('does not modify product source')
  })
})
