import { join, resolve } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

export function getCronDaemonDir(): string {
  return join(getClaudeConfigHomeDir(), 'cron-daemon')
}

export function getCronDaemonSocketPath(): string {
  return join(getClaudeConfigHomeDir(), 'cron-daemon.sock')
}

export function getCronDaemonProjectsPath(): string {
  return join(getCronDaemonDir(), 'projects.json')
}

export function getCronDaemonOwnerPath(): string {
  return join(getCronDaemonDir(), 'owner.json')
}

export function getCronDaemonWorkerPayloadDir(): string {
  return join(getCronDaemonDir(), 'workers')
}

export function getCronDaemonWorkerPayloadPath(workerId: string): string {
  return join(getCronDaemonWorkerPayloadDir(), `${workerId}.json`)
}

export function getCronDaemonNotificationDir(): string {
  return join(getCronDaemonDir(), 'notifications')
}

export function getCronDaemonDiscoveryRequestDir(): string {
  return join(getCronDaemonDir(), 'discovery-requests')
}

export function getCronDaemonDiscoveryRequestPath(fileId: string): string {
  return join(getCronDaemonDiscoveryRequestDir(), `${fileId}.json`)
}

export function getCronDaemonSessionNotificationDir(sessionId: string): string {
  return join(getCronDaemonNotificationDir(), sessionId)
}

export function getCronDaemonSessionNotificationPath(
  sessionId: string,
  notificationId: string,
): string {
  return join(
    getCronDaemonSessionNotificationDir(sessionId),
    `${notificationId}.json`,
  )
}

export function getSessionScheduledTasksPath(projectRoot: string): string {
  return join(resolve(projectRoot), '.claude', 'session_scheduled_tasks.json')
}
