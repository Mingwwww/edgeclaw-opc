export type DiscoveryTriggerConfig = {
  enabled: boolean
  tickIntervalMinutes: number
  cooldownMinutes: number
  dailyBudget: number
  heartbeatStaleSeconds: number
  recentUserMsgMinutes: number
  preferClient: 'webui' | 'tui'
  projectSettings: Record<string, { enabled: boolean }>
}

export type AlwaysOnHeartbeat = {
  schemaVersion: 1
  writerKind: 'webui' | 'tui'
  writerId: string
  writtenAt: string
  agentBusy: boolean
  processingSessionIds: string[]
  lastUserMsgAt?: string | null
}

export type DiscoveryFireRequest = {
  schemaVersion: 1
  requestId: string
  projectRoot: string
  targetWriterKind: 'webui' | 'tui'
  targetWriterId: string
  createdAt: string
}

export type DiscoveryFireStatus = 'started' | 'completed' | 'failed'

export type DiscoveryState = {
  schemaVersion: 1
  lastFireStartedAt?: string
  lastFireCompletedAt?: string
  todayKey?: string
  todayRunCount: number
  consecutiveFailures: number
}

export type GateBlockReason =
  | 'disabled'
  | 'project_disabled'
  | 'project_missing'
  | 'no_fresh_heartbeat'
  | 'agent_busy'
  | 'recent_user_msg'
  | 'cooldown'
  | 'daily_budget'
  | 'lock_busy'

export type GateResult =
  | { ok: true; heartbeat: AlwaysOnHeartbeat }
  | { ok: false; reason: GateBlockReason }
