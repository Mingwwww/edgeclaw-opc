import { resolve } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { getDiscoveryTriggerConfig } from './config.js'
import { evaluateDiscoveryGates } from './gates.js'
import { notifyDiscoveryFire } from './notifier.js'
import type { DiscoveryTriggerConfig, GateResult, AlwaysOnHeartbeat } from './types.js'

type ProjectTimer = {
  timer: ReturnType<typeof setInterval>
  running: boolean
}

type DiscoverySchedulerDependencies = {
  getDiscoveryTriggerConfig: () => DiscoveryTriggerConfig
  evaluateDiscoveryGates: (
    projectRoot: string,
    config: DiscoveryTriggerConfig,
  ) => Promise<GateResult>
  notifyDiscoveryFire: (
    projectRoot: string,
    heartbeat: AlwaysOnHeartbeat,
  ) => Promise<void>
}

const defaultDependencies: DiscoverySchedulerDependencies = {
  getDiscoveryTriggerConfig,
  evaluateDiscoveryGates,
  notifyDiscoveryFire,
}

export class DiscoveryScheduler {
  private readonly timers = new Map<string, ProjectTimer>()
  private stopped = false

  constructor(private readonly deps = defaultDependencies) {}

  ensureProject(projectRoot: string): void {
    if (this.stopped) return
    const normalized = resolve(projectRoot)
    if (this.timers.has(normalized)) return

    const config = getDiscoveryTriggerConfig()
    const timer = setInterval(
      () => void this.tickProject(normalized),
      config.tickIntervalMinutes * 60_000,
    )
    timer.unref()
    this.timers.set(normalized, { timer, running: false })
    void this.tickProject(normalized)
  }

  stop(): void {
    this.stopped = true
    for (const { timer } of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
  }

  private async tickProject(projectRoot: string): Promise<void> {
    if (this.stopped) return
    const entry = this.timers.get(projectRoot)
    if (!entry || entry.running) return
    entry.running = true
    try {
      if (this.stopped) return
      const config = this.deps.getDiscoveryTriggerConfig()
      const result = await this.deps.evaluateDiscoveryGates(projectRoot, config)
      if (!result.ok) {
        return
      }
      if (this.stopped) return
      await this.deps.notifyDiscoveryFire(projectRoot, result.heartbeat)
    } catch (error) {
      logForDebugging(
        `[AlwaysOnDiscovery] tick failed for ${projectRoot}: ${String(error)}`,
      )
    } finally {
      entry.running = false
    }
  }
}
