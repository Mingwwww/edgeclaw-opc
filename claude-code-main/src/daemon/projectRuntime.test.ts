import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectRuntime, type KillProcessTreeFn } from './projectRuntime.js'

function createSessionTaskStore() {
  return {
    listProjectTasks: () => [],
    deleteTask: () => false,
    persistProject: async () => {},
    markTaskFired: () => false,
    countForProject: () => 0,
    updateTask: () => null,
  } as any
}

describe('ProjectRuntime stop', () => {
  test('terminates active workers with a process-tree SIGTERM', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'cron-runtime-'))
    const child = new EventEmitter() as any
    child.pid = 12345
    child.exitCode = null
    child.signalCode = null

    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const killProcessTreeFn: KillProcessTreeFn = async (pid, signal) => {
      signals.push({ pid, signal })
      setTimeout(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
      }, 0)
    }

    try {
      const runtime = new ProjectRuntime(
        projectRoot,
        createSessionTaskStore(),
        killProcessTreeFn,
      )
      ;(runtime as any).activeWorkers.set('cron-task-1', child)

      await runtime.stop()

      expect(signals).toEqual([{ pid: 12345, signal: 'SIGTERM' }])
      expect((runtime as any).activeWorkers.size).toBe(0)
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
