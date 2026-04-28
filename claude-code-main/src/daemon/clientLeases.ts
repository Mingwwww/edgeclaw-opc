export type CronDaemonClientType = 'web-ui' | 'tui'

export type ClientLease = {
  clientId: string
  clientType: CronDaemonClientType
  processId?: number
  leaseExpiresAt: number
  lastSeenAt: number
}

export type ClientLeaseSummary = {
  total: number
  byType: Record<CronDaemonClientType, number>
}

export const DEFAULT_CLIENT_LEASE_TTL_MS = 30_000
export const DEFAULT_CLIENT_LEASE_PRUNE_INTERVAL_MS = 5_000

type ClientLeaseRegistryOptions = {
  onEmpty?: () => void | Promise<void>
  now?: () => number
  defaultTtlMs?: number
  pruneIntervalMs?: number
  noClientGraceMs?: number
}

export class ClientLeaseRegistry {
  private readonly leases = new Map<string, ClientLease>()
  private readonly now: () => number
  private readonly defaultTtlMs: number
  private readonly pruneIntervalMs: number
  private readonly noClientGraceMs: number
  private readonly onEmpty?: () => void | Promise<void>
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private startedAt: number | null = null
  private hasEverRegisteredClient = false
  private emptyNotified = false

  constructor(options: ClientLeaseRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_CLIENT_LEASE_TTL_MS
    this.pruneIntervalMs =
      options.pruneIntervalMs ?? DEFAULT_CLIENT_LEASE_PRUNE_INTERVAL_MS
    this.noClientGraceMs = options.noClientGraceMs ?? this.defaultTtlMs
    this.onEmpty = options.onEmpty
  }

  start(): void {
    if (this.pruneTimer) return
    this.startedAt = this.now()
    this.pruneTimer = setInterval(() => {
      this.pruneExpired()
      this.notifyEmptyIfNeeded()
    }, this.pruneIntervalMs)
    this.pruneTimer.unref?.()
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
  }

  register({
    clientId,
    clientType,
    processId,
    ttlMs,
  }: {
    clientId: string
    clientType: CronDaemonClientType
    processId?: number
    ttlMs?: number
  }): ClientLease {
    const now = this.now()
    const lease: ClientLease = {
      clientId,
      clientType,
      ...(typeof processId === 'number' ? { processId } : {}),
      lastSeenAt: now,
      leaseExpiresAt: now + this.normalizeTtl(ttlMs),
    }
    this.leases.set(clientId, lease)
    this.hasEverRegisteredClient = true
    this.emptyNotified = false
    return lease
  }

  heartbeat(clientId: string, ttlMs?: number): ClientLease | null {
    this.pruneExpired()
    const existing = this.leases.get(clientId)
    if (!existing) return null
    const now = this.now()
    const next: ClientLease = {
      ...existing,
      lastSeenAt: now,
      leaseExpiresAt: now + this.normalizeTtl(ttlMs),
    }
    this.leases.set(clientId, next)
    return next
  }

  unregister(clientId: string): number {
    this.leases.delete(clientId)
    return this.leases.size
  }

  pruneExpired(): number {
    const now = this.now()
    let removed = 0
    for (const [clientId, lease] of this.leases) {
      if (lease.leaseExpiresAt <= now) {
        this.leases.delete(clientId)
        removed += 1
      }
    }
    return removed
  }

  hasActiveClients(): boolean {
    this.pruneExpired()
    return this.leases.size > 0
  }

  summarize(): ClientLeaseSummary {
    this.pruneExpired()
    const byType: Record<CronDaemonClientType, number> = {
      'web-ui': 0,
      tui: 0,
    }
    for (const lease of this.leases.values()) {
      byType[lease.clientType] += 1
    }
    return {
      total: this.leases.size,
      byType,
    }
  }

  private normalizeTtl(ttlMs?: number): number {
    return typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
      ? ttlMs
      : this.defaultTtlMs
  }

  private shouldNotifyEmpty(): boolean {
    if (this.leases.size > 0 || this.emptyNotified) return false
    if (this.hasEverRegisteredClient) return true
    if (this.startedAt === null) return false
    return this.now() - this.startedAt >= this.noClientGraceMs
  }

  private notifyEmptyIfNeeded(): void {
    if (!this.shouldNotifyEmpty()) return
    this.emptyNotified = true
    void this.onEmpty?.()
  }
}
