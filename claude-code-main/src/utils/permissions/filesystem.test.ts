import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getOriginalCwd, setOriginalCwd } from '../../bootstrap/state.js'
import { checkEditableInternalPath } from './filesystem.js'

describe('checkEditableInternalPath', () => {
  let projectRoot: string
  let priorOriginalCwd: string

  beforeEach(async () => {
    priorOriginalCwd = getOriginalCwd()
    projectRoot = await mkdtemp(join(tmpdir(), 'always-on-artifact-perms-'))
    setOriginalCwd(projectRoot)
  })

  afterEach(async () => {
    setOriginalCwd(priorOriginalCwd)
    await rm(projectRoot, { recursive: true, force: true })
  })

  test('allows project-local Always-On artifact writes', () => {
    const artifactPath = join(
      projectRoot,
      '.claude',
      'always-on',
      'artifacts',
      'meeting-brief.md',
    )

    expect(checkEditableInternalPath(artifactPath, {})).toMatchObject({
      behavior: 'allow',
      decisionReason: {
        type: 'other',
        reason: 'Always-On artifact files are allowed for writing',
      },
    })
  })

  test('does not broaden access to other Always-On metadata', () => {
    const planIndexPath = join(
      projectRoot,
      '.claude',
      'always-on',
      'discovery-plans.json',
    )

    expect(checkEditableInternalPath(planIndexPath, {})).toMatchObject({
      behavior: 'passthrough',
    })
  })
})
