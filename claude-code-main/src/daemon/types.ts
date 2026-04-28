import type { CronTask } from '../utils/cronTasks.js'
import type { DiscoveryFireCompleteRequest } from './discoveryScheduler/types.js'
import type {
  ClientLeaseSummary,
  CronDaemonClientType,
} from './clientLeases.js'

export type DaemonCronTask = CronTask & {
  durable: boolean
}

export type DaemonListedCronTask = DaemonCronTask & {
  running: boolean
}

export type CronDaemonRequest =
  | {
      type: 'ping'
    }
  | {
      type: 'shutdown'
    }
  | {
      type: 'register_client'
      clientId: string
      clientType: CronDaemonClientType
      processId?: number
      ttlMs?: number
    }
  | {
      type: 'heartbeat_client'
      clientId: string
      ttlMs?: number
    }
  | {
      type: 'unregister_client'
      clientId: string
    }
  | {
      type: 'register_project'
      projectRoot: string
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
  | DiscoveryFireCompleteRequest

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
            clients?: ClientLeaseSummary
          }
        | { type: 'shutdown' }
        | {
            type: 'register_client'
            registered: true
            leaseExpiresAt: number
          }
        | {
            type: 'heartbeat_client'
            accepted: boolean
            leaseExpiresAt?: number
          }
        | {
            type: 'unregister_client'
            remainingClients: number
          }
        | { type: 'register_project'; projectRoot: string }
        | { type: 'create_task'; task: DaemonCronTask }
        | { type: 'list_tasks'; tasks: DaemonListedCronTask[] }
        | { type: 'delete_task'; deleted: boolean }
        | {
            type: 'run_task_now'
            started: boolean
            reason?: 'already_running' | 'not_found'
          }
        | { type: 'discovery_fire_complete'; accepted: boolean }
    }
  | {
      ok: false
      error: string
    }

export type CronWorkerPayload = {
  projectRoot: string
  task: DaemonCronTask
}
