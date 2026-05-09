import net from 'net'
import { mkdir, unlink } from 'fs/promises'
import { dirname, resolve } from 'path'
import { CronDaemonProjectRegistry } from './projectRegistry.js'
import { clearCronDaemonOwner } from './ownership.js'
import { ProjectRuntime } from './projectRuntime.js'
import { DaemonSessionTaskStore } from './sessionTaskStore.js'
import { getCronDaemonSocketPath } from './paths.js'
import { ClientLeaseRegistry } from './clientLeases.js'
import { DiscoveryScheduler } from './discoveryScheduler/index.js'
import { releaseDiscoveryLock } from './discoveryScheduler/lock.js'
import { markDiscoveryFireComplete } from './discoveryScheduler/state.js'
import type {
  CronDaemonRequest,
  CronDaemonResponse,
  DaemonCronTask,
  DaemonListedCronTask,
} from './types.js'
import { safeParseJSON } from '../utils/json.js'
import { logForDebugging } from '../utils/debug.js'
import { addCronTask, readCronTasks, removeCronTasks } from '../utils/cronTasks.js'

const DEFAULT_EMPTY_CLIENT_SHUTDOWN_DELAY_MS = 10_000

async function isSocketAcceptingConnections(socketPath: string): Promise<boolean> {
  return await new Promise(resolvePromise => {
    const socket = net.createConnection(socketPath)
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(result)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export class CronDaemonServer {
  private readonly server = net.createServer(socket =>
    this.handleConnection(socket).catch(error => {
      const response: CronDaemonResponse = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
      socket.end(JSON.stringify(response) + '\n')
    }),
  )
  private readonly runtimes = new Map<string, ProjectRuntime>()
  private readonly sessionTaskStore = new DaemonSessionTaskStore()
  private readonly registry = new CronDaemonProjectRegistry()
  private readonly discoveryScheduler = new DiscoveryScheduler()
  private readonly clientLeases = new ClientLeaseRegistry()
  private emptyClientShutdownTimer: ReturnType<typeof setTimeout> | null = null
  private stopping = false

  constructor(
    private readonly emptyClientShutdownDelayMs = DEFAULT_EMPTY_CLIENT_SHUTDOWN_DELAY_MS,
  ) {}

  async start(): Promise<void> {
    await this.registry.load()
    for (const projectRoot of this.registry.list()) {
      await this.ensureHydratedRuntime(projectRoot)
      this.discoveryScheduler.ensureProject(projectRoot)
    }

    const socketPath = getCronDaemonSocketPath()
    if (await isSocketAcceptingConnections(socketPath)) {
      throw new Error(`Cron daemon socket is already active at ${socketPath}`)
    }
    await mkdir(dirname(socketPath), { recursive: true })
    await unlink(socketPath).catch(() => {})
    await clearCronDaemonOwner()

    await new Promise<void>((resolvePromise, reject) => {
      this.server.once('error', reject)
      this.server.listen(socketPath, () => {
        this.server.off('error', reject)
        resolvePromise()
      })
    })

    this.clientLeases.start(() => this.handleClientLeasesChanged())
    this.scheduleEmptyClientShutdown()
    logForDebugging(`[CronDaemon] listening on ${socketPath}`)
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    logForDebugging('[CronDaemon] stopping')
    this.clearEmptyClientShutdownTimer()
    this.clientLeases.stop()
    this.discoveryScheduler.stop()
    await Promise.all([...this.runtimes.values()].map(runtime => runtime.stop()))
    await this.sessionTaskStore.persistProjects(this.runtimes.keys())
    if (this.server.listening) {
      await new Promise<void>(resolvePromise => {
        this.server.close(() => resolvePromise())
      })
    }
    await unlink(getCronDaemonSocketPath()).catch(() => {})
    await clearCronDaemonOwner()
  }

  private clearEmptyClientShutdownTimer(): void {
    if (!this.emptyClientShutdownTimer) return
    clearTimeout(this.emptyClientShutdownTimer)
    this.emptyClientShutdownTimer = null
  }

  private scheduleEmptyClientShutdown(): void {
    if (this.stopping || this.clientLeases.hasFreshClients()) {
      this.clearEmptyClientShutdownTimer()
      return
    }
    if (this.emptyClientShutdownTimer) return
    this.emptyClientShutdownTimer = setTimeout(() => {
      this.emptyClientShutdownTimer = null
      if (!this.clientLeases.hasFreshClients()) {
        logForDebugging('[CronDaemon] stopping after all client leases expired')
        void this.stop()
      }
    }, this.emptyClientShutdownDelayMs)
    this.emptyClientShutdownTimer.unref()
  }

  private handleClientLeasesChanged(): void {
    if (this.clientLeases.hasFreshClients()) {
      this.clearEmptyClientShutdownTimer()
      return
    }
    this.scheduleEmptyClientShutdown()
  }

  private normalizeProjectRoots(projectRoots: unknown): string[] {
    if (!Array.isArray(projectRoots)) return []
    return [
      ...new Set(
        projectRoots
          .filter(root => typeof root === 'string' && root.trim().length > 0)
          .map(root => resolve(root)),
      ),
    ]
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString('utf-8')
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) return
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      void this.dispatchLine(line, socket)
    })
  }

  private async dispatchLine(line: string, socket: net.Socket): Promise<void> {
    const parsed = safeParseJSON(line, false) as CronDaemonRequest | null
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      socket.end(
        JSON.stringify({ ok: false, error: 'Invalid Cron daemon request' }) +
          '\n',
      )
      return
    }

    const response = await this.handleRequest(parsed)
    socket.end(JSON.stringify(response) + '\n')
    if (parsed.type === 'shutdown' && response.ok) {
      setTimeout(() => {
        void this.stop()
      }, 0)
    }
  }

  private async handleRequest(
    request: CronDaemonRequest,
  ): Promise<CronDaemonResponse> {
    try {
      switch (request.type) {
        case 'ping': {
          const runtimes = await Promise.all(
            [...this.runtimes.values()].map(runtime => runtime.summarize()),
          )
          return {
            ok: true,
            data: { type: 'pong', runtimes, clients: this.clientLeases.list() },
          }
        }
        case 'shutdown':
          return { ok: true, data: { type: 'shutdown' } }
        case 'create_task': {
          const projectRoot = await this.ensureRuntime(request.projectRoot)
          let createdSessionTask: DaemonCronTask | null = null
          const id = await addCronTask(
            request.cron,
            request.prompt,
            request.recurring,
            request.durable,
            request.agentId,
            {
              dir: projectRoot,
              originSessionId: request.originSessionId,
                manualOnly: request.manualOnly,
              allowedTools: request.allowedTools,
              addSessionTask: task => {
                createdSessionTask = this.sessionTaskStore.addTask(projectRoot, {
                  ...task,
                  durable: false,
                })
              },
            },
          )

          const task = request.durable
            ? (await readCronTasks(projectRoot).then(tasks =>
                tasks.find(candidate => candidate.id === id),
              ))
            : createdSessionTask

          if (!task) {
            throw new Error(`Failed to create cron task ${id}`)
          }

          if (!request.durable) {
            await this.sessionTaskStore.persistProject(projectRoot)
          }

          return {
            ok: true,
            data: {
              type: 'create_task',
              task: {
                ...task,
                durable: request.durable,
              },
            },
          }
        }
        case 'list_tasks': {
          const projectRoot = await this.ensureRuntime(request.projectRoot)
          const runtime = await this.ensureHydratedRuntime(projectRoot)
          const durableTasks = (await readCronTasks(projectRoot)).map(task => ({
            ...task,
            durable: true as const,
          }))
          const sessionTasks = this.sessionTaskStore.listVisibleTasks(
            projectRoot,
            request.originSessionId,
          )
          const tasks: DaemonListedCronTask[] = [...durableTasks, ...sessionTasks].map(
            task => ({
              ...task,
              running: runtime.isTaskRunning(task.id),
            }),
          )
          return {
            ok: true,
            data: {
              type: 'list_tasks',
              tasks,
            },
          }
        }
        case 'delete_task': {
          const projectRoot = await this.ensureRuntime(request.projectRoot)
          const deletedSessionTask = this.sessionTaskStore.deleteTask(
            projectRoot,
            request.taskId,
            request.originSessionId,
          )
          if (deletedSessionTask) {
            await this.sessionTaskStore.persistProject(projectRoot)
            return {
              ok: true,
              data: { type: 'delete_task', deleted: true },
            }
          }

          const durableTasks = await readCronTasks(projectRoot)
          const exists = durableTasks.some(task => task.id === request.taskId)
          if (exists) {
            await removeCronTasks([request.taskId], projectRoot)
          }
          return {
            ok: true,
            data: { type: 'delete_task', deleted: exists },
          }
        }
        case 'run_task_now': {
          const projectRoot = await this.ensureRuntime(request.projectRoot)
          const runtime = await this.ensureHydratedRuntime(projectRoot)
          const sessionTask = this.sessionTaskStore.getTask(
            projectRoot,
            request.taskId,
          )
          if (sessionTask) {
            const started = await runtime.launchSessionTask(sessionTask)
            return {
              ok: true,
              data: {
                type: 'run_task_now',
                started,
                ...(started ? {} : { reason: 'already_running' as const }),
              },
            }
          }

          const durableTask = (await readCronTasks(projectRoot)).find(
            task => task.id === request.taskId,
          )
          if (!durableTask) {
            return {
              ok: true,
              data: {
                type: 'run_task_now',
                started: false,
                reason: 'not_found',
              },
            }
          }

          const started = await runtime.launchSessionTask({
            ...durableTask,
            durable: true,
          })
          return {
            ok: true,
            data: {
              type: 'run_task_now',
              started,
              ...(started ? {} : { reason: 'already_running' as const }),
            },
          }
        }
        case 'register_project': {
          const projectRoot = await this.ensureRuntime(request.projectRoot)
          this.discoveryScheduler.ensureProject(projectRoot)
          return {
            ok: true,
            data: { type: 'register_project', projectRoot },
          }
        }
        case 'discovery_fire_complete': {
          const projectRoot = resolve(request.projectRoot)
          await markDiscoveryFireComplete(projectRoot, request.status)
          await releaseDiscoveryLock(projectRoot)
          return {
            ok: true,
            data: { type: 'discovery_fire_complete' },
          }
        }
        case 'register_client': {
          const projectRoots = this.normalizeProjectRoots(request.projectRoots)
          const client = this.clientLeases.upsert({
            clientId: request.clientId,
            clientKind: request.clientKind,
            processId: request.processId,
            projectRoots,
          })
          logForDebugging(
            `[CronDaemon] registered client ${client.clientKind}:${client.clientId} active=${this.clientLeases.count()}`,
          )
          this.handleClientLeasesChanged()
          return {
            ok: true,
            data: {
              type: 'register_client',
              client,
              activeClients: this.clientLeases.count(),
            },
          }
        }
        case 'client_heartbeat': {
          const client = this.clientLeases.heartbeat(
            request.clientId,
            this.normalizeProjectRoots(request.projectRoots),
          )
          if (!client) {
            logForDebugging(
              `[CronDaemon] heartbeat from unknown client ${request.clientId}`,
            )
            throw new Error(`Unknown Cron daemon client ${request.clientId}`)
          }
          this.handleClientLeasesChanged()
          return {
            ok: true,
            data: {
              type: 'client_heartbeat',
              client,
              activeClients: this.clientLeases.count(),
            },
          }
        }
        case 'unregister_client': {
          const removed = this.clientLeases.unregister(request.clientId)
          logForDebugging(
            `[CronDaemon] unregistered client ${request.clientId} removed=${removed} active=${this.clientLeases.count()}`,
          )
          this.handleClientLeasesChanged()
          return {
            ok: true,
            data: {
              type: 'unregister_client',
              activeClients: this.clientLeases.count(),
            },
          }
        }
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async ensureRuntime(projectRoot: string): Promise<string> {
    const normalized = resolve(projectRoot)
    await this.registry.remember(normalized)
    await this.ensureHydratedRuntime(normalized)
    this.discoveryScheduler.ensureProject(normalized)
    return normalized
  }

  private async ensureHydratedRuntime(projectRoot: string): Promise<ProjectRuntime> {
    const normalized = resolve(projectRoot)
    let runtime = this.runtimes.get(normalized)
    if (!runtime) {
      await this.sessionTaskStore.hydrateProject(normalized)
      runtime = new ProjectRuntime(normalized, this.sessionTaskStore)
      this.runtimes.set(normalized, runtime)
    }
    runtime.start()
    return runtime
  }
}
