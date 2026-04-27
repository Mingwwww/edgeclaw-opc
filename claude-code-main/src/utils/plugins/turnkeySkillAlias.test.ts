import { expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { parseFrontmatter } from '../frontmatterParser.js'

test('turnkey start skill exposes /turnkey as user-facing name', async () => {
  const skillPath = resolve(
    import.meta.dir,
    '../../../../packages/turnkey-cc-plugin/skills/start/SKILL.md',
  )
  const raw = await readFile(skillPath, 'utf8')
  const { frontmatter } = parseFrontmatter(raw, skillPath)

  expect(frontmatter.name).toBe('turnkey')
})
