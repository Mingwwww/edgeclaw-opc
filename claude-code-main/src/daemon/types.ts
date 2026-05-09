import type { CronTask } from '../utils/cronTasks.js'

export type DaemonCronTask = CronTask & {
  durable: boolean
}

export type DaemonListedCronTask = DaemonCronTask & {
  running: boolean
}

export type CronDaemonClientKind = 'webui' | 'tui'

export type CronDaemonClientLease = {
  clientId: string
  clientKind: CronDaemonClientKind
  processId?: number
  projectRoots: string[]
  lastSeenAt: number
}

export type CronDaemonClientSummary = CronDaemonClientLease & {
  expiresAt: number
}

export type CronDaemonRequest =
  | {
      type: 'ping'
    }
  | {
      type: 'shutdown'
    }
  | {
      type: 'create_task'
      projectRoot: string
      originSessionId: string
      cron: string
      prompt: string
      recurring: boolean
      durable: boolean
      manualOnly?: boolean
      agentId?: string
      allowedTools?: string[]
    }
  | {
      type: 'list_tasks'
      projectRoot: string
      originSessionId?: string
    }
  | {
      type: 'delete_task'
      projectRoot: string
      taskId: string
      originSessionId?: string
    }
  | {
      type: 'run_task_now'
      projectRoot: string
      taskId: string
    }
  | {
      type: 'register_project'
      projectRoot: string
    }
  | {
      type: 'discovery_fire_complete'
      projectRoot: string
      status: 'started' | 'completed' | 'failed'
    }
  | {
      type: 'register_client'
      clientId: string
      clientKind: CronDaemonClientKind
      processId?: number
      projectRoots?: string[]
    }
  | {
      type: 'client_heartbeat'
      clientId: string
      projectRoots?: string[]
    }
  | {
      type: 'unregister_client'
      clientId: string
    }

export type RuntimeSummary = {
  projectRoot: string
  durableCount: number
  sessionOnlyCount: number
  activeWorkers: number
}

export type CronDaemonResponse =
  | {
      ok: true
      data:
        | {
            type: 'pong'
            runtimes: RuntimeSummary[]
            clients?: CronDaemonClientSummary[]
          }
        | { type: 'shutdown' }
        | { type: 'create_task'; task: DaemonCronTask }
        | { type: 'list_tasks'; tasks: DaemonListedCronTask[] }
        | { type: 'delete_task'; deleted: boolean }
        | {
            type: 'run_task_now'
            started: boolean
            reason?: 'already_running' | 'not_found'
          }
        | { type: 'register_project'; projectRoot: string }
        | { type: 'discovery_fire_complete' }
        | {
            type: 'register_client'
            client: CronDaemonClientLease
            activeClients: number
          }
        | {
            type: 'client_heartbeat'
            client: CronDaemonClientLease
            activeClients: number
          }
        | { type: 'unregister_client'; activeClients: number }
    }
  | {
      ok: false
      error: string
    }

export type CronWorkerPayload = {
  projectRoot: string
  task: DaemonCronTask
  runId?: string
  startedAt?: string
}
