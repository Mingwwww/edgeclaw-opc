import { feature } from 'bun:bundle'
import { registerAddProjectSkill } from './addProject.js'
import { registerBatchSkill } from './batch.js'
import { registerCloneRepoSkill } from './cloneRepo.js'
import { registerDebugSkill } from './debug.js'
import { registerImportOpenClawSkill } from './importOpenClaw.js'
import { registerKeybindingsSkill } from './keybindings.js'
import { registerListProjectsSkill } from './listProjects.js'
import { registerLoremIpsumSkill } from './loremIpsum.js'
import { registerPwdSkill } from './pwd.js'
import { registerRememberSkill } from './remember.js'
import { registerSimplifySkill } from './simplify.js'
import { registerSkillifySkill } from './skillify.js'
import { registerStuckSkill } from './stuck.js'
import { registerSwitchProjectSkill } from './switchProject.js'
import { registerUpdateConfigSkill } from './updateConfig.js'
import { registerVerifySkill } from './verify.js'

/**
 * Initialize all bundled skills.
 * Called at startup to register skills that ship with the CLI.
 *
 * To add a new bundled skill:
 * 1. Create a new file in src/skills/bundled/ (e.g., myskill.ts)
 * 2. Export a register function that calls registerBundledSkill()
 * 3. Import and call that function here
 */
export async function initBundledSkills(): Promise<void> {
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  registerVerifySkill()
  registerDebugSkill()
  registerLoremIpsumSkill()
  registerSkillifySkill()
  registerRememberSkill()
  registerSimplifySkill()
  registerBatchSkill()
  registerStuckSkill()
  registerImportOpenClawSkill()
  registerListProjectsSkill()
  registerAddProjectSkill()
  registerSwitchProjectSkill()
  registerPwdSkill()
  registerCloneRepoSkill()
  if (feature('KAIROS') || feature('KAIROS_DREAM')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerDreamSkill } = require('./dream.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerDreamSkill()
  }
  if (feature('REVIEW_ARTIFACT')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerHunterSkill } = require('./hunter.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerHunterSkill()
  }
  const { registerLoopSkill } = await import('./loop.js')
  // /loop's isEnabled delegates to isKairosCronEnabled() — same lazy
  // per-invocation pattern as the cron tools. Register it unconditionally so
  // all entrypoints share the same runtime gate.
  registerLoopSkill()
  if (feature('AGENT_TRIGGERS_REMOTE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      registerScheduleRemoteAgentsSkill,
    } = require('./scheduleRemoteAgents.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerScheduleRemoteAgentsSkill()
  }
  if (feature('BUILDING_CLAUDE_APPS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerClaudeApiSkill } = require('./claudeApi.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerClaudeApiSkill()
  }
  if (feature('RUN_SKILL_GENERATOR')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerRunSkillGeneratorSkill } = require('./runSkillGenerator.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerRunSkillGeneratorSkill()
  }
}
