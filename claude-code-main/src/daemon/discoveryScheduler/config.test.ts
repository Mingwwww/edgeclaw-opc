import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { getDiscoveryTriggerConfig } from './config.js'

const previousConfigPath = process.env.EDGECLAW_CONFIG_PATH
const tempDirs: string[] = []

async function writeConfig(raw: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'always-on-config-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'config.yaml')
  process.env.EDGECLAW_CONFIG_PATH = configPath
  await writeFile(configPath, raw, 'utf-8')
}

afterEach(async () => {
  if (previousConfigPath === undefined) {
    delete process.env.EDGECLAW_CONFIG_PATH
  } else {
    process.env.EDGECLAW_CONFIG_PATH = previousConfigPath
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

test('getDiscoveryTriggerConfig reads top-level alwaysOn discovery trigger', async () => {
  await writeConfig(`
alwaysOn:
  discovery:
    trigger:
      enabled: true
      tickIntervalMinutes: 7
      preferClient: tui
`)

  expect(getDiscoveryTriggerConfig()).toMatchObject({
    enabled: true,
    tickIntervalMinutes: 7,
    preferClient: 'tui',
  })
})

test('getDiscoveryTriggerConfig reads and normalizes project opt-in settings', async () => {
  const projectRoot = join(tmpdir(), 'always-on-config-project', '..', 'always-on-config-project')
  await writeConfig(`
alwaysOn:
  discovery:
    trigger:
      enabled: true
    projects:
      "${projectRoot}":
        enabled: true
      "/workspace/disabled":
        enabled: false
`)

  expect(getDiscoveryTriggerConfig().projectSettings).toEqual({
    [resolve(projectRoot)]: { enabled: true },
    [resolve('/workspace/disabled')]: { enabled: false },
  })
})

test('getDiscoveryTriggerConfig migrates legacy agents alwaysOn trigger', async () => {
  await writeConfig(`
agents:
  alwaysOn:
    discovery:
      trigger:
        enabled: true
        cooldownMinutes: 12
`)

  expect(getDiscoveryTriggerConfig()).toMatchObject({
    enabled: true,
    cooldownMinutes: 12,
  })
})
