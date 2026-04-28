export type AlwaysOnDiscoveryTriggerConfig = {
  enabled: boolean
  tickIntervalMinutes: number
  cooldownMinutes: number
  dailyBudget: number
  heartbeatStaleSeconds: number
  recentUserMsgMinutes: number
  preferClient: 'webui' | 'tui'
}

export type DiscoveryHeartbeatWriterKind = 'tui' | 'webui'

export type DiscoveryHeartbeat = {
  schemaVersion: 1
  writerKind: DiscoveryHeartbeatWriterKind
  writerId: string
  writtenAt: string
  agentBusy?: boolean
  processingSessionIds?: string[]
  lastUserMsgAt?: string
}

export type FreshDiscoveryHeartbeat = {
  fileName: string
  filePath: string
  mtimeMs: number
  ageMs: number
  body: DiscoveryHeartbeat
}

export type DiscoveryState = {
  schemaVersion: 1
  lastFireStartedAt: string | null
  lastFireCompletedAt: string | null
  lastFireResult: 'started' | 'failed' | null
  consecutiveNoPlanRuns: number
  todayRunCount: number
  todayRunDate: string
}

export type DiscoveryLockHandle = {
  projectRoot: string
  lockPath: string
  requestId: string
  createdAt: string
}

export type DiscoveryFireRequest = {
  type: 'discovery_fire_request'
  requestId: string
  projectRoot: string
  targetWriterKind: DiscoveryHeartbeatWriterKind
  targetWriterId: string
  createdAt: string
}

export type DiscoveryFireCompleteRequest = {
  type: 'discovery_fire_complete'
  projectRoot: string
  requestId: string
  result: 'started' | 'failed'
  errorMessage?: string
}

export type DiscoveryGateBlockedAt = 0 | 1 | 2 | 3

export type DiscoveryGateResult =
  | {
      fire: false
      blockedAt: DiscoveryGateBlockedAt
      reason: string
    }
  | {
      fire: true
      lockHandle: DiscoveryLockHandle
      target: FreshDiscoveryHeartbeat
    }
