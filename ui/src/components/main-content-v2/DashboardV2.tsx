import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  DollarSign,
  FolderOpen,
  Loader2,
  RefreshCw,
  Sigma,
  TrendingUp,
} from 'lucide-react';
import { useRoutingDashboard } from '../../hooks/useRoutingDashboard';
import type {
  DashboardData,
  DashboardProject,
  DashboardSession,
  ProjectAggregated,
  RequestLogEntry,
} from '../../hooks/useRoutingDashboard';
import { cn } from '../../lib/utils.js';

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatCost(n: number): string {
  if (!n) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatTime(iso?: string | null, fallback?: number): string {
  let value: number | null = null;
  if (typeof iso === 'string' && iso) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) value = parsed;
  }
  if (value === null && typeof fallback === 'number' && fallback > 0) {
    value = fallback;
  }
  if (value === null) return '—';
  const d = new Date(value);
  return d.toLocaleTimeString([], { hour12: false });
}

type RecentRoute = {
  key: string;
  timeLabel: string;
  provider: string;
  model: string;
  tokens: number;
  projectName?: string;
};

function collectRecentRoutes(
  projects: DashboardProject[],
  unmatchedSessions?: DashboardData['unmatchedSessions'],
): RecentRoute[] {
  const sessions: Array<{ project: DashboardProject; session: DashboardSession }> = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.routing) continue;
      sessions.push({ project, session });
    }
  }

  if (unmatchedSessions) {
    const placeholder = {
      name: 'unmatched',
      displayName: 'General',
      fullPath: '',
      sessions: [],
      aggregated: {},
    } as unknown as DashboardProject;
    for (const u of unmatchedSessions) {
      sessions.push({
        project: placeholder,
        session: {
          sessionId: u.sessionId,
          title: u.sessionId,
          provider: Object.keys(u.byScenario || {})[0] || 'routed',
          lastActivity: new Date(u.lastActiveAt).toISOString(),
          routing: {
            total: u.total,
            byTier: u.byTier,
            byScenario: u.byScenario,
            byRole: u.byRole,
            byModel: u.byModel,
            firstSeenAt: u.firstSeenAt,
            lastActiveAt: u.lastActiveAt,
          },
        },
      });
    }
  }

  sessions.sort((a, b) => {
    const aTime = a.session.routing?.lastActiveAt ?? 0;
    const bTime = b.session.routing?.lastActiveAt ?? 0;
    return bTime - aTime;
  });

  const out: RecentRoute[] = [];
  for (const { project, session } of sessions.slice(0, 10)) {
    const routing = session.routing!;
    const modelEntries = Object.entries(routing.byModel || {});
    if (modelEntries.length === 0) continue;
    modelEntries.sort((a, b) => (b[1]?.totalTokens ?? 0) - (a[1]?.totalTokens ?? 0));
    for (const [model, bucket] of modelEntries) {
      out.push({
        key: `${session.sessionId}:${model}`,
        timeLabel: formatTime(session.lastActivity, routing.lastActiveAt),
        provider: session.provider || '—',
        model,
        tokens: bucket?.totalTokens ?? 0,
        projectName: project.displayName || project.name,
      });
      if (out.length >= 10) return out;
    }
  }
  return out;
}

// ─── Project group helpers ───

type ProjectGroup = {
  name: string;
  displayName: string;
  fullPath: string;
  aggregated: ProjectAggregated;
  allSessions: DashboardSession[];
};

function buildProjectGroups(
  data: DashboardData,
): { groups: ProjectGroup[]; generalGroup: ProjectGroup | null } {
  const groups: ProjectGroup[] = [];

  for (const proj of data.projects) {
    const sorted = [...proj.sessions].sort((a, b) => {
      // Sessions with routing first
      const aHas = a.routing ? 1 : 0;
      const bHas = b.routing ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      // Then by last activity (newest first)
      const aTime = a.routing?.lastActiveAt ?? (a.lastActivity ? new Date(a.lastActivity).getTime() : 0);
      const bTime = b.routing?.lastActiveAt ?? (b.lastActivity ? new Date(b.lastActivity).getTime() : 0);
      return bTime - aTime;
    });
    groups.push({
      name: proj.name,
      displayName: proj.displayName || proj.name,
      fullPath: proj.fullPath,
      aggregated: proj.aggregated,
      allSessions: sorted,
    });
  }

  let generalGroup: ProjectGroup | null = null;
  const unmatched = data.unmatchedSessions || [];
  if (unmatched.length > 0) {
    const aggTotal = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, requestCount: 0, estimatedCost: 0 };
    const aggByTier: Record<string, any> = {};
    const aggByRole: Record<string, any> = {};
    const sessions: DashboardSession[] = [];

    for (const u of unmatched) {
      aggTotal.inputTokens += u.total?.inputTokens || 0;
      aggTotal.outputTokens += u.total?.outputTokens || 0;
      aggTotal.cacheReadTokens += u.total?.cacheReadTokens || 0;
      aggTotal.totalTokens += u.total?.totalTokens || 0;
      aggTotal.requestCount += u.total?.requestCount || 0;
      aggTotal.estimatedCost += u.total?.estimatedCost || 0;

      for (const [k, v] of Object.entries(u.byTier || {})) {
        if (!aggByTier[k]) aggByTier[k] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, requestCount: 0, estimatedCost: 0 };
        aggByTier[k].totalTokens += v?.totalTokens || 0;
        aggByTier[k].requestCount += v?.requestCount || 0;
        aggByTier[k].estimatedCost += v?.estimatedCost || 0;
      }

      sessions.push({
        sessionId: u.sessionId,
        title: u.sessionId,
        provider: Object.keys(u.byScenario || {})[0] || 'routed',
        lastActivity: u.lastActiveAt ? new Date(u.lastActiveAt).toISOString() : null,
        routing: {
          total: u.total,
          byTier: u.byTier,
          byScenario: u.byScenario,
          byRole: u.byRole,
          byModel: u.byModel,
          firstSeenAt: u.firstSeenAt,
          lastActiveAt: u.lastActiveAt,
        },
      });
    }

    generalGroup = {
      name: '__general__',
      displayName: 'General / Other',
      fullPath: '',
      aggregated: {
        total: aggTotal,
        byTier: aggByTier,
        byRole: aggByRole,
        sessionCount: sessions.length,
        routedSessionCount: sessions.length,
      },
      allSessions: sessions,
    };
  }

  return { groups, generalGroup };
}

// ─── Component ───

export type DashboardV2Props = {
  projectFilter?: string | null;
  onSelectProject?: (projectName: string) => void;
  onDeselectProject?: () => void;
};

export default function DashboardV2({ projectFilter, onSelectProject, onDeselectProject }: DashboardV2Props = {}) {
  const { t } = useTranslation('routing');
  const { data, loading, error, refresh } = useRoutingDashboard();

  const { groups, generalGroup, recent, filteredOverall } = useMemo(() => {
    if (!data)
      return { groups: [] as ProjectGroup[], generalGroup: null, recent: [] as RecentRoute[], filteredOverall: null };

    const { groups: g, generalGroup: gg } = buildProjectGroups(data);

    let filteredGroups = g;
    let filteredGeneral = gg;
    let computedOverall = data.overall;

    if (projectFilter) {
      filteredGroups = g.filter(
        (grp) => grp.name === projectFilter || grp.displayName === projectFilter,
      );
      filteredGeneral = null;

      if (filteredGroups.length > 0) {
        const agg = filteredGroups[0].aggregated;
        computedOverall = {
          total: agg.total,
          byTier: agg.byTier,
          byRole: agg.byRole,
          projectCount: 1,
          sessionCount: agg.sessionCount,
        };
      }
    }

    const recentProjects = projectFilter
      ? data.projects.filter((p) => p.name === projectFilter || p.displayName === projectFilter)
      : data.projects;
    const recentUnmatched = projectFilter ? undefined : data.unmatchedSessions;

    return {
      groups: filteredGroups,
      generalGroup: filteredGeneral,
      recent: collectRecentRoutes(recentProjects, recentUnmatched),
      filteredOverall: computedOverall,
    };
  }, [data, projectFilter]);

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
        <span className="ml-2 text-[13px]">
          {t('dashboard.loading', { defaultValue: 'Loading dashboard…' })}
        </span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-white text-center dark:bg-neutral-950">
        <AlertCircle className="h-8 w-8 text-red-500" strokeWidth={1.75} />
        <p className="text-[13px] text-neutral-600 dark:text-neutral-400">{error}</p>
        <button
          onClick={refresh}
          className="text-xxs rounded-md bg-neutral-900 px-3 py-1.5 text-white transition hover:opacity-90 dark:bg-neutral-50 dark:text-neutral-900"
        >
          {t('dashboard.retry', { defaultValue: 'Retry' })}
        </button>
      </div>
    );
  }

  if (!data || !filteredOverall) return null;

  const overall = filteredOverall;
  const totalRequests = overall.total.requestCount || 0;
  const totalTokens = overall.total.totalTokens || 0;
  const inputTokens = overall.total.inputTokens || 0;
  const outputTokens = overall.total.outputTokens || 0;
  const totalCost = overall.total.estimatedCost || 0;

  const routedSessionCount =
    groups.reduce((sum, g) => sum + g.aggregated.routedSessionCount, 0) +
    (generalGroup?.aggregated.routedSessionCount ?? 0);

  const projectDisplayName = projectFilter && groups.length > 0
    ? groups[0].displayName
    : projectFilter;
  const subtitle = projectFilter
    ? `Routing stats for ${projectDisplayName}.`
    : t('dashboard.subtitle', { defaultValue: 'Usage across all projects and sessions.' });

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-neutral-950">
      <div className="mx-auto w-full max-w-[960px] px-8 py-8">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            {projectFilter && onDeselectProject ? (
              <button
                type="button"
                onClick={onDeselectProject}
                className="mb-1 inline-flex items-center gap-1 text-[13px] text-neutral-500 transition hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
              >
                <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>Overview</span>
              </button>
            ) : null}
            <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
              {t('dashboard.title', { defaultValue: 'Dashboard' })}
            </h2>
            <p className="mt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="text-xxs inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
            <span>{t('dashboard.refresh', { defaultValue: 'Refresh' })}</span>
          </button>
        </div>

        {/* Overall stat cards */}
        <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
          <StatCard
            icon={<Activity className="h-3.5 w-3.5" strokeWidth={1.75} />}
            label={t('dashboard.stats.requests', { defaultValue: 'Requests' })}
            value={totalRequests.toLocaleString()}
            sub={
              routedSessionCount > 0
                ? `${routedSessionCount} routed sessions`
                : undefined
            }
            hint={
              !projectFilter && overall.projectCount
                ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <TrendingUp className="h-3 w-3" strokeWidth={1.75} />
                      <span>
                        {t('dashboard.stats.activeProjects', {
                          count: overall.projectCount,
                          defaultValue: `${overall.projectCount} active projects`,
                        })}
                      </span>
                    </span>
                  )
                : undefined
            }
          />
          <StatCard
            icon={<Sigma className="h-3.5 w-3.5" strokeWidth={1.75} />}
            label={t('dashboard.stats.tokens', { defaultValue: 'Tokens' })}
            value={formatTokens(totalTokens)}
            sub={
              t('dashboard.stats.inOut', {
                in: formatTokens(inputTokens),
                out: formatTokens(outputTokens),
                defaultValue: `${formatTokens(inputTokens)} in · ${formatTokens(outputTokens)} out`,
              }) as string
            }
          />
          <StatCard
            icon={<DollarSign className="h-3.5 w-3.5" strokeWidth={1.75} />}
            label={t('dashboard.stats.cost', { defaultValue: 'Cost' })}
            value={formatCost(totalCost)}
            sub={
              totalRequests > 0
                ? (t('dashboard.stats.perRequest', {
                    value: formatCost(totalCost / totalRequests),
                    defaultValue: `≈ ${formatCost(totalCost / totalRequests)} / request`,
                  }) as string)
                : undefined
            }
          />
        </div>

        {/* Project-filtered: flat session list */}
        {projectFilter && (
          <div className="mt-6 space-y-2">
            <div className="text-xxs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Sessions
            </div>
            {groups.length > 0 && groups[0].allSessions.length > 0 ? (
              <div className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
                <div className="divide-y divide-neutral-100 dark:divide-neutral-800/50">
                  {groups[0].allSessions.map((session) => (
                    <SessionRow key={session.sessionId} session={session} />
                  ))}
                </div>
              </div>
            ) : (
              <p className="py-6 text-center text-[13px] text-neutral-400 dark:text-neutral-500">
                No sessions yet.
              </p>
            )}
          </div>
        )}

        {/* Global view: project cost cards grid + recent routes */}
        {!projectFilter && (
          <>
            {(groups.length > 0 || generalGroup) && (
              <div className="mt-6 space-y-3">
                <div className="text-xxs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                  {t('dashboard.projects.title', { defaultValue: 'By project' })}
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {groups.map((grp) => (
                    <ProjectCostCard key={grp.name} group={grp} onClick={onSelectProject ? () => onSelectProject(grp.name) : undefined} />
                  ))}
                  {generalGroup && <ProjectCostCard group={generalGroup} />}
                </div>
              </div>
            )}

            <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
              <div className="text-xxs mb-4 uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {t('dashboard.recent.title', { defaultValue: 'Recent routes' })}
              </div>
              {recent.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
                  {t('dashboard.recent.empty', {
                    defaultValue:
                      'No routing activity yet. Start a conversation to see stats here.',
                  })}
                </p>
              ) : (
                <table className="w-full text-[13px]">
                  <thead className="text-xxs text-neutral-500 dark:text-neutral-400">
                    <tr className="text-left">
                      <th className="pb-2 font-normal">
                        {t('dashboard.recent.columns.time', { defaultValue: 'Time' })}
                      </th>
                      <th className="pb-2 font-normal">
                        {t('dashboard.recent.columns.project', { defaultValue: 'Project' })}
                      </th>
                      <th className="pb-2 font-normal">
                        {t('dashboard.recent.columns.model', { defaultValue: 'Model' })}
                      </th>
                      <th className="pb-2 text-right font-normal">
                        {t('dashboard.recent.columns.tokens', { defaultValue: 'Tokens' })}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                    {recent.map((row) => (
                      <tr key={row.key}>
                        <td className="text-xxs py-2 font-mono text-neutral-500 dark:text-neutral-400">
                          {row.timeLabel}
                        </td>
                        <td className="py-2 text-neutral-600 dark:text-neutral-400">
                          {row.projectName || '—'}
                        </td>
                        <td className="py-2 text-neutral-700 dark:text-neutral-300">{row.model}</td>
                        <td className="py-2 text-right font-mono text-neutral-800 dark:text-neutral-200">
                          {row.tokens.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───

function ProjectGroupCard({
  group,
  defaultOpen = false,
}: {
  group: ProjectGroup;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const agg = group.aggregated;
  const hasData = agg.total.requestCount > 0;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition hover:bg-neutral-50 dark:hover:bg-neutral-900"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" strokeWidth={1.75} />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" strokeWidth={1.75} />
        )}
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
        <span className="flex-1 truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
          {group.displayName}
        </span>
        <span className="text-xxs shrink-0 tabular-nums text-neutral-500 dark:text-neutral-400">
          {agg.sessionCount} sessions{agg.routedSessionCount > 0 ? ` · ${agg.routedSessionCount} routed` : ''} · {formatTokens(agg.total.totalTokens || 0)} tokens · {formatCost(agg.total.estimatedCost || 0)}
        </span>
      </button>

      {open && (
        <div className="border-t border-neutral-100 px-5 pb-4 pt-3 dark:border-neutral-800/50">
          {/* Tier breakdown */}
          {Object.keys(agg.byTier || {}).length > 0 && (
            <div className="mb-3">
              <div className="text-xxs mb-2 text-neutral-400 dark:text-neutral-500">Tier breakdown</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(agg.byTier).map(([tier, bucket]) => (
                  <span
                    key={tier}
                    className="text-xxs inline-flex items-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
                  >
                    <span className="font-medium">{tier}</span>
                    <span className="text-neutral-400 dark:text-neutral-500">·</span>
                    <span>{formatTokens(bucket?.totalTokens || 0)}</span>
                    <span className="text-neutral-400 dark:text-neutral-500">·</span>
                    <span>{formatCost(bucket?.estimatedCost || 0)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Session list — show all sessions */}
          {group.allSessions.length > 0 ? (
            <div>
              <div className="text-xxs mb-2 text-neutral-400 dark:text-neutral-500">Sessions</div>
              <div className="space-y-1">
                {group.allSessions.map((session) => (
                  <SessionRow key={session.sessionId} session={session} />
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xxs text-neutral-400 dark:text-neutral-500">No sessions yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

const TIER_COLORS: Record<string, string> = {
  SIMPLE: 'bg-emerald-400 dark:bg-emerald-500',
  MEDIUM: 'bg-blue-400 dark:bg-blue-500',
  COMPLEX: 'bg-amber-400 dark:bg-amber-500',
  REASONING: 'bg-purple-400 dark:bg-purple-500',
  HARD: 'bg-red-400 dark:bg-red-500',
};

function TierBar({ byTier }: { byTier: Record<string, { estimatedCost?: number; requestCount?: number }> }) {
  const entries = Object.entries(byTier).filter(([, b]) => (b?.requestCount ?? 0) > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, b]) => s + (b?.estimatedCost ?? 0), 0) || 1;

  return (
    <div className="mt-2.5 space-y-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
        {entries.map(([tier, b]) => {
          const pct = ((b?.estimatedCost ?? 0) / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={tier}
              className={cn('h-full', TIER_COLORS[tier] || 'bg-neutral-400')}
              style={{ width: `${pct}%` }}
              title={`${tier}: ${formatCost(b?.estimatedCost ?? 0)}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {entries.map(([tier, b]) => (
          <span key={tier} className="inline-flex items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400">
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', TIER_COLORS[tier] || 'bg-neutral-400')} />
            <span>{tier}</span>
            <span className="tabular-nums">{formatCost(b?.estimatedCost ?? 0)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function ProjectCostCard({ group, onClick }: { group: ProjectGroup; onClick?: () => void }) {
  const agg = group.aggregated;
  const cost = agg.total.estimatedCost || 0;
  const requests = agg.total.requestCount || 0;
  const tokens = agg.total.totalTokens || 0;
  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex flex-col rounded-xl border border-neutral-200 bg-white p-4 text-left dark:border-neutral-800 dark:bg-neutral-950',
        onClick && 'cursor-pointer transition hover:border-neutral-300 hover:shadow-sm dark:hover:border-neutral-700',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.75} />
            <span className="truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-200">{group.displayName}</span>
          </div>
          <div className="text-xxs mt-1 text-neutral-500 dark:text-neutral-400">
            {requests} requests · {formatTokens(tokens)} tokens · {agg.sessionCount} sessions
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[18px] font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">{formatCost(cost)}</div>
        </div>
      </div>
      <TierBar byTier={agg.byTier || {}} />
    </Tag>
  );
}

function buildPerQueryTiers(
  queries: string[],
  routing: DashboardSession['routing'],
): string[] {
  if (!routing) return queries.map(() => '');
  const tierEntries = Object.entries(routing.byTier || {})
    .sort((a, b) => (b[1]?.requestCount ?? 0) - (a[1]?.requestCount ?? 0));
  if (tierEntries.length === 0) return queries.map(() => '');
  if (tierEntries.length === 1) return queries.map(() => tierEntries[0][0]);
  const labels: string[] = [];
  for (const [tier, bucket] of tierEntries) {
    const count = bucket?.requestCount ?? 0;
    for (let j = 0; j < count; j++) labels.push(tier);
  }
  return queries.map((_, i) => labels[i] || labels[labels.length - 1] || '');
}

const NOISE_PATTERNS = [
  /^\[Request interrupted/i,
  /^Base directory for this skill/i,
  /^<CCR-SUBAGENT/,
  /^You are a/,
  /^#+\s/,
];

function filterUserQueries(queries: string[]): string[] {
  return queries.filter((q) => {
    if (!q || q.length < 2) return false;
    return !NOISE_PATTERNS.some((p) => p.test(q));
  });
}

function RequestLogRow({ entry, variant }: { entry: RequestLogEntry; variant: 'main' | 'sub' }) {
  const isSub = variant === 'sub';
  return (
    <div className={cn(
      'flex items-start gap-2 rounded-md px-2.5 py-1.5 text-[12px]',
      isSub
        ? 'bg-violet-50/40 dark:bg-violet-900/10'
        : 'bg-neutral-50 dark:bg-neutral-900/30',
    )}>
      <span className={cn(
        'text-xxs mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-medium',
        isSub
          ? 'bg-violet-100 text-violet-600 dark:bg-violet-800/40 dark:text-violet-400'
          : 'bg-neutral-200/70 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400',
      )}>
        {entry.tier || '—'}
      </span>
      <span className={cn(
        'text-xxs mt-0.5 shrink-0 rounded px-1 py-0.5',
        isSub
          ? 'bg-violet-50 text-violet-500 dark:bg-violet-900/20 dark:text-violet-400'
          : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500',
      )}>
        {isSub ? 'sub' : 'main'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-neutral-700 dark:text-neutral-300">
          {entry.query || <span className="italic text-neutral-400">(no content)</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xxs text-neutral-400 dark:text-neutral-500">
          <span className="truncate">{entry.model}</span>
          <span className="tabular-nums">{formatTokens(entry.tokens)}</span>
          <span className="tabular-nums">{formatCost(entry.cost)}</span>
        </div>
      </div>
    </div>
  );
}

function SessionRow({ session }: { session: DashboardSession }) {
  const [open, setOpen] = useState(false);
  const routing = session.routing;
  const rawQueries = session.userQueries || [];
  const queries = filterUserQueries(rawQueries);
  const queryCount = queries.length;
  const perQueryTiers = buildPerQueryTiers(queries, routing);

  const mainRole = routing?.byRole?.main;
  const subRole = routing?.byRole?.sub;
  const isOrchestrated = !!(subRole && subRole.requestCount > 0);
  const log = routing?.requestLog || [];
  const hasLog = log.length > 0;

  // Group sub-agent requests under the preceding main request by timestamp
  const groupedLog: { main: RequestLogEntry; subs: RequestLogEntry[] }[] = [];
  if (hasLog) {
    let currentGroup: { main: RequestLogEntry; subs: RequestLogEntry[] } | null = null;
    for (const entry of log) {
      if (entry.role === 'main') {
        currentGroup = { main: entry, subs: [] };
        groupedLog.push(currentGroup);
      } else if (currentGroup) {
        currentGroup.subs.push(entry);
      } else {
        // Sub before any main — create a placeholder
        groupedLog.push({ main: { ...entry, role: 'main' as const, query: entry.query || '(orchestrator)' }, subs: [] });
      }
    }
  }

  return (
    <div>
      {/* Collapsed row */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-neutral-400" strokeWidth={1.75} />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-neutral-400" strokeWidth={1.75} />
        )}
        <div className="min-w-0 flex-1 truncate text-[13px] text-neutral-700 dark:text-neutral-300">
          {session.title || session.sessionId}
        </div>
        {routing ? (
          <div className="flex shrink-0 items-center gap-2">
            {isOrchestrated && (
              <span className="text-xxs rounded bg-violet-100 px-1.5 py-0.5 font-medium text-violet-600 dark:bg-violet-900/40 dark:text-violet-400">
                orchestrated
              </span>
            )}
            {Object.keys(routing.byTier || {}).map((tier) => (
              <span key={tier} className="text-xxs rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
                {tier}
              </span>
            ))}
            <span className="text-xxs tabular-nums text-neutral-500 dark:text-neutral-400">
              {routing.total.requestCount} req
            </span>
            <span className="text-xxs tabular-nums text-neutral-600 dark:text-neutral-400">
              {formatTokens(routing.total.totalTokens || 0)}
            </span>
            <span className="text-xxs tabular-nums text-neutral-500 dark:text-neutral-400">
              {formatCost(routing.total.estimatedCost || 0)}
            </span>
          </div>
        ) : (
          <span className="text-xxs shrink-0 text-neutral-300 dark:text-neutral-700">
            {queryCount > 0 ? `${queryCount} queries` : '—'}
          </span>
        )}
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="border-t border-neutral-100 bg-neutral-50/50 px-5 pb-3 pt-2 dark:border-neutral-800/50 dark:bg-neutral-900/30">
          {hasLog ? (
            <>
              {/* Orchestration summary header */}
              {isOrchestrated && (
                <div className="mb-2.5 grid grid-cols-2 gap-2">
                  {mainRole && (
                    <div className="rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-700/60">
                      <div className="text-xxs font-medium text-neutral-700 dark:text-neutral-300">Main Agent</div>
                      <div className="mt-0.5 text-xxs tabular-nums text-neutral-500 dark:text-neutral-400">
                        {mainRole.requestCount} req · {formatTokens(mainRole.totalTokens || 0)} · {formatCost(mainRole.estimatedCost || 0)}
                      </div>
                    </div>
                  )}
                  {subRole && (
                    <div className="rounded-lg border border-violet-200/60 bg-violet-50/30 px-3 py-2 dark:border-violet-700/30 dark:bg-violet-900/10">
                      <div className="text-xxs font-medium text-violet-700 dark:text-violet-300">Sub-agents</div>
                      <div className="mt-0.5 text-xxs tabular-nums text-violet-600 dark:text-violet-400">
                        {subRole.requestCount} req · {formatTokens(subRole.totalTokens || 0)} · {formatCost(subRole.estimatedCost || 0)}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Grouped: main request → its sub-agent requests */}
              <div className="space-y-2">
                {groupedLog.map((group, gi) => (
                  <div key={gi}>
                    <RequestLogRow entry={group.main} variant="main" />
                    {group.subs.length > 0 && (
                      <div className="ml-5 mt-1 space-y-1 border-l-2 border-violet-200/60 pl-3 dark:border-violet-700/30">
                        {group.subs.map((sub, si) => (
                          <RequestLogRow key={si} entry={sub} variant="sub" />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              {/* Orchestration summary for legacy sessions */}
              {isOrchestrated && routing && (
                <div className="mb-2.5 grid grid-cols-2 gap-2">
                  {mainRole && (
                    <div className="rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-700/60">
                      <div className="text-xxs font-medium text-neutral-700 dark:text-neutral-300">Main Agent</div>
                      <div className="mt-0.5 text-xxs tabular-nums text-neutral-500 dark:text-neutral-400">
                        {mainRole.requestCount} req · {formatTokens(mainRole.totalTokens || 0)} · {formatCost(mainRole.estimatedCost || 0)}
                      </div>
                    </div>
                  )}
                  {subRole && (
                    <div className="rounded-lg border border-violet-200/60 bg-violet-50/30 px-3 py-2 dark:border-violet-700/30 dark:bg-violet-900/10">
                      <div className="text-xxs font-medium text-violet-700 dark:text-violet-300">Sub-agents</div>
                      <div className="mt-0.5 text-xxs tabular-nums text-violet-600 dark:text-violet-400">
                        {subRole.requestCount} req · {formatTokens(subRole.totalTokens || 0)} · {formatCost(subRole.estimatedCost || 0)}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {/* Fallback: show userQueries with inferred tiers */}
              {queries.length > 0 ? (
                <div className="space-y-1.5">
                  {queries.map((q, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px]">
                      {perQueryTiers[i] ? (
                        <span className="text-xxs shrink-0 rounded bg-neutral-200/70 px-1.5 py-0.5 font-medium text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400">
                          {perQueryTiers[i]}
                        </span>
                      ) : (
                        <span className="text-xxs shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-600">
                          —
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-neutral-600 dark:text-neutral-400">{q}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xxs text-neutral-400 dark:text-neutral-600">No user queries recorded.</p>
              )}
            </>
          )}

          {/* Footer: models as pills */}
          {routing && Object.keys(routing.byModel || {}).length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-xxs text-neutral-400 dark:text-neutral-500">Models:</span>
              {Object.entries(routing.byModel || {}).map(([model, bucket]) => (
                <span key={model} className="text-xxs rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {model} <span className="tabular-nums text-neutral-400 dark:text-neutral-500">×{bucket?.requestCount ?? 0}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: string;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="text-xxs flex items-center gap-2 uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 text-[28px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
        {value}
      </div>
      <div className="text-xxs mt-1 text-neutral-500 dark:text-neutral-400">{sub ?? ' '}</div>
      {hint ? <div className="text-xxs mt-1">{hint}</div> : null}
    </div>
  );
}
