import { logForDebugging } from '../../utils/debug.js'
import { evaluateDiscoveryGates } from './gates.js'
import { loadDiscoveryTriggerConfig } from './config.js'
import { notifyDiscoveryClient } from './notifier.js'
import {
  markDiscoveryFireCompleted,
  markDiscoveryFireStarted,
} from './state.js'
import { releaseDiscoveryLock } from './lock.js'
import type {
  DiscoveryFireCompleteRequest,
  DiscoveryLockHandle,
} from './types.js'

type DiscoverySchedulerOptions = {
  listProjectRoots: () => Iterable<string>
}

type PendingFire = {
  projectRoot: string
  lockHandle: DiscoveryLockHandle
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export class DiscoveryScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly pending = new Map<string, PendingFire>()
  private readonly options: DiscoverySchedulerOptions

  constructor(options: DiscoverySchedulerOptions) {
    this.options = options
  }

  start(): void {
    const config = loadDiscoveryTriggerConfig()
    if (!config.enabled) {
      return
    }
    for (const projectRoot of this.options.listProjectRoots()) {
      this.ensureProjectTimer(projectRoot)
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      void releaseDiscoveryLock(pending.lockHandle)
    }
    this.pending.clear()
  }

  ensureProjectTimer(projectRoot: string): void {
    if (this.timers.has(projectRoot)) {
      return
    }
    const config = loadDiscoveryTriggerConfig()
    if (!config.enabled) {
      return
    }
    const intervalMs = config.tickIntervalMinutes * 60_000
    const timer = setInterval(() => {
      void this.tick(projectRoot)
    }, intervalMs)
    timer.unref?.()
    this.timers.set(projectRoot, timer)
    void this.tick(projectRoot)
  }

  async completeFire(request: DiscoveryFireCompleteRequest): Promise<boolean> {
    const pending = this.pending.get(request.requestId)
    if (!pending || pending.projectRoot !== request.projectRoot) {
      return false
    }
    this.pending.delete(request.requestId)
    clearTimeout(pending.timeout)
    if (request.result === 'started') {
      await markDiscoveryFireStarted(request.projectRoot)
    }
    await markDiscoveryFireCompleted(request.projectRoot, request.result)
    await releaseDiscoveryLock(pending.lockHandle)
    return true
  }

  private async tick(projectRoot: string): Promise<void> {
    const config = loadDiscoveryTriggerConfig()
    const result = await evaluateDiscoveryGates(projectRoot, config)
    if (!result.fire) {
      return
    }

    try {
      const request = await notifyDiscoveryClient({
        projectRoot,
        target: result.target,
        lockHandle: result.lockHandle,
      })
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId)
        void markDiscoveryFireCompleted(projectRoot, 'failed')
        void releaseDiscoveryLock(result.lockHandle)
      }, REQUEST_TIMEOUT_MS)
      timeout.unref?.()
      this.pending.set(request.requestId, {
        projectRoot,
        lockHandle: result.lockHandle,
        timeout,
      })
    } catch (error) {
      logForDebugging(
        `[AlwaysOnDiscovery] notify failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      await markDiscoveryFireCompleted(projectRoot, 'failed')
      await releaseDiscoveryLock(result.lockHandle)
    }
  }
}
