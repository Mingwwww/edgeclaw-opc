import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import { resolve } from 'path'
import treeKill from 'tree-kill'
import {
  createCronScheduler,
  type CronScheduler,
  buildMissedTaskNotification,
} from '../utils/cronScheduler.js'
import { readCronTasks, updateCronTask, type CronTask } from '../utils/cronTasks.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { generateCronId } from '../tasks/CronBackgroundTask.js'
import { getCronDaemonWorkerPayloadDir, getCronDaemonWorkerPayloadPath } from './paths.js'
import { getDaemonWorkerCommandArgs } from './spawn.js'
import { DaemonSessionTaskStore } from './sessionTaskStore.js'
import type { CronWorkerPayload, DaemonCronTask, RuntimeSummary } from './types.js'

const WORKER_SHUTDOWN_GRACE_MS = 5_000

export type KillProcessTreeFn = (
  pid: number,
  signal: NodeJS.Signals,
) => Promise<void>

export const killProcessTree: KillProcessTreeFn = async (pid, signal) => {
  await new Promise<void>((resolvePromise, reject) => {
    treeKill(pid, signal, error => {
      if (error) {
        reject(error)
        return
      }
      resolvePromise()
    })
  })
}

async function waitForWorkerExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true
  }

  return await new Promise<boolean>(resolvePromise => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolvePromise(false)
    }, timeoutMs)
    timeout.unref?.()

    const onExit = () => {
      clearTimeout(timeout)
      resolvePromise(true)
    }

    child.once('exit', onExit)
  })
}

export class ProjectRuntime {
  readonly projectRoot: string
  private readonly scheduler: CronScheduler
  private readonly activeWorkers = new Map<string, ReturnType<typeof spawn>>()
  private started = false

  constructor(
    projectRoot: string,
    private readonly sessionTaskStore: DaemonSessionTaskStore,
    private readonly killProcessTreeFn: KillProcessTreeFn = killProcessTree,
  ) {
    this.projectRoot = resolve(projectRoot)
    this.scheduler = createCronScheduler({
      dir: this.projectRoot,
      lockIdentity: `cron-daemon:${process.pid}:${this.projectRoot}`,
      runtimeTaskSource: {
        listTasks: () => this.sessionTaskStore.listProjectTasks(this.projectRoot),
        removeTasks: ids => {
          let deletedAny = false
          for (const id of ids) {
            deletedAny =
              this.sessionTaskStore.deleteTask(this.projectRoot, id) || deletedAny
          }
          if (deletedAny) {
            void this.sessionTaskStore.persistProject(this.projectRoot).catch(logError)
          }
        },
        markTasksFired: (ids, firedAt) => {
          let updatedAny = false
          for (const id of ids) {
            updatedAny =
              this.sessionTaskStore.markTaskFired(this.projectRoot, id, firedAt) ||
              updatedAny
          }
          if (updatedAny) {
            void this.sessionTaskStore.persistProject(this.projectRoot).catch(logError)
          }
        },
      },
      onFire: prompt => {
        void this.handleMissedPrompt(prompt)
      },
      onMissed: tasks => {
        void this.handleMissedTasks(tasks)
      },
      onFireTask: task => {
        return this.handleScheduledTask({
          ...task,
          durable: true,
        }).catch(error => {
          logForDebugging(
            `[CronDaemon] failed to start scheduled task ${task.id}: ${String(error)}`,
          )
        })
      },
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.scheduler.start()
  }

  async stop(): Promise<void> {
    if (this.started) {
      this.started = false
      this.scheduler.stop()
    }
    await this.stopActiveWorkers()
  }

  async summarize(): Promise<RuntimeSummary> {
    const durableCount = (await readCronTasks(this.projectRoot)).length
    return {
      projectRoot: this.projectRoot,
      durableCount,
      sessionOnlyCount: this.sessionTaskStore.countForProject(this.projectRoot),
      activeWorkers: this.activeWorkers.size,
    }
  }

  isTaskRunning(taskId: string): boolean {
    return this.activeWorkers.has(taskId)
  }

  private async handleMissedTasks(tasks: CronTask[]): Promise<void> {
    if (tasks.length === 0) return
    await this.handleMissedPrompt(buildMissedTaskNotification(tasks), tasks[0])
  }

  private async handleMissedPrompt(
    prompt: string,
    exemplarTask?: Pick<CronTask, 'originSessionId'>,
  ): Promise<void> {
    const syntheticTask: DaemonCronTask = {
      id: generateCronId('cron-missed'),
      cron: '* * * * *',
      prompt,
      createdAt: Date.now(),
      originSessionId: exemplarTask?.originSessionId ?? randomUUID(),
      durable: false,
    }
    await this.spawnWorkerForTask(syntheticTask)
  }

  async launchSessionTask(task: DaemonCronTask): Promise<boolean> {
    return await this.spawnWorkerForTask(await this.prepareTask(task))
  }

  private async handleScheduledTask(task: DaemonCronTask): Promise<void> {
    await this.spawnWorkerForTask(await this.prepareTask(task))
  }

  private async prepareTask(task: DaemonCronTask): Promise<DaemonCronTask> {
    if (!task.recurring || task.transcriptKey) {
      return task
    }

    const transcriptKey = generateCronId('cron-thread')
    const originSessionId = task.originSessionId ?? randomUUID()

    if (task.durable) {
      const updated =
        (await updateCronTask(
          task.id,
          currentTask => ({
            ...currentTask,
            transcriptKey,
            originSessionId: currentTask.originSessionId ?? originSessionId,
          }),
          this.projectRoot,
        )) ?? {
          ...task,
          transcriptKey,
          originSessionId,
        }

      return {
        ...updated,
        durable: true,
      }
    }

    const updated =
      this.sessionTaskStore.updateTask(this.projectRoot, task.id, currentTask => ({
        ...currentTask,
        transcriptKey,
        originSessionId: currentTask.originSessionId ?? originSessionId,
      })) ?? {
        ...task,
        transcriptKey,
        originSessionId,
        durable: false,
      }

    if (updated) {
      await this.sessionTaskStore.persistProject(this.projectRoot)
    }

    return updated
  }

  private async spawnWorkerForTask(task: DaemonCronTask): Promise<boolean> {
    if (this.activeWorkers.has(task.id)) {
      logForDebugging(
        `[CronDaemon] skipping ${task.id}: worker already active for ${this.projectRoot}`,
      )
      return false
    }

    const workerId = randomUUID()
    await mkdir(getCronDaemonWorkerPayloadDir(), { recursive: true })
    const payloadPath = getCronDaemonWorkerPayloadPath(workerId)
    const payload: CronWorkerPayload = {
      projectRoot: this.projectRoot,
      task,
    }
    await writeFile(payloadPath, jsonStringify(payload), 'utf-8')

    const child = spawn(process.execPath, getDaemonWorkerCommandArgs(`cron:${payloadPath}`), {
      cwd: this.projectRoot,
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    this.activeWorkers.set(task.id, child)

    child.stderr?.on('data', chunk => {
      logForDebugging(
        `[CronDaemonWorker:${task.id}] ${chunk.toString('utf-8').trim()}`,
      )
    })

    child.on('error', error => {
      this.activeWorkers.delete(task.id)
      logError(error)
    })

    child.on('exit', code => {
      this.activeWorkers.delete(task.id)
      if (code !== 0) {
        logForDebugging(
          `[CronDaemon] worker for ${task.id} exited with code ${code ?? 'unknown'}`,
        )
      }
    })

    return true
  }

  private async stopActiveWorkers(): Promise<void> {
    const workers = [...this.activeWorkers.entries()]
    await Promise.all(
      workers.map(async ([taskId, child]) => {
        await this.stopWorker(taskId, child)
      }),
    )
  }

  private async stopWorker(
    taskId: string,
    child: ReturnType<typeof spawn>,
  ): Promise<void> {
    if (!child.pid) {
      this.activeWorkers.delete(taskId)
      return
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      this.activeWorkers.delete(taskId)
      return
    }

    try {
      await this.killProcessTreeFn(child.pid, 'SIGTERM')
    } catch (error) {
      logForDebugging(
        `[CronDaemon] failed to SIGTERM worker ${taskId}: ${String(error)}`,
      )
    }

    const exited = await waitForWorkerExit(child, WORKER_SHUTDOWN_GRACE_MS)
    if (exited) {
      this.activeWorkers.delete(taskId)
      return
    }

    try {
      await this.killProcessTreeFn(child.pid, 'SIGKILL')
    } catch (error) {
      logForDebugging(
        `[CronDaemon] failed to SIGKILL worker ${taskId}: ${String(error)}`,
      )
    } finally {
      this.activeWorkers.delete(taskId)
    }
  }
}
