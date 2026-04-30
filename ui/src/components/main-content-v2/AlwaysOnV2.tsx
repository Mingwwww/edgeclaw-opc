import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertCircle,
  ArrowLeft,
  Eye,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  AlwaysOnSessionTarget,
  AlwaysOnRunHistoryDetail,
  AlwaysOnRunHistoryEntry,
  AlwaysOnRunHistoryStatus,
  AlwaysOnRunLogResponse,
  CronJobOverview,
  DiscoveryPlanOverview,
  Project,
  ProjectAlwaysOnRunHistoryDetailResponse,
  ProjectAlwaysOnRunHistoryResponse,
  ProjectCronJobsResponse,
  ProjectDiscoveryPlansResponse,
} from '../../types/app';
import { MarkdownContent } from '../chat/tools/components/ContentRenderers/MarkdownContent';
import { api } from '../../utils/api';
import { cn } from '../../lib/utils.js';

type AlwaysOnV2Props = {
  selectedProject: Project | null;
  onStartDiscoverySession: () => void | Promise<void>;
  onExecuteDiscoveryPlan: (planId: string, source?: 'manual' | 'auto') => void | Promise<void>;
  onOpenCronSession: (job: CronJobOverview) => void;
  onOpenSession: (target: AlwaysOnSessionTarget) => void | Promise<void>;
};

const POLL_INTERVAL_MS = 15_000;
const LOG_POLL_INTERVAL_MS = 2_000;
const CRON_TITLE_MAX_LENGTH = 56;
const TABLE_GRID_COLUMNS =
  'grid-cols-[minmax(280px,1.8fr)_minmax(120px,0.8fr)_88px_112px_96px_96px_196px]';
const HISTORY_TABLE_GRID_COLUMNS =
  'grid-cols-[minmax(280px,1.8fr)_96px_96px_128px_minmax(160px,0.8fr)_112px]';

type AlwaysOnSubTab = 'items' | 'history';

type AlwaysOnRow =
  | {
      kind: 'plan';
      id: string;
      title: string;
      typeLabel: string;
      statusLabel: string;
      createdAt?: string;
      triggeredAt?: string;
      completedAt?: string;
      sortAt: string;
      plan: DiscoveryPlanOverview;
    }
  | {
      kind: 'cron';
      id: string;
      title: string;
      typeLabel: string;
      statusLabel: string;
      createdAt?: string;
      triggeredAt?: string;
      completedAt?: string;
      sortAt: string;
      cronJob: CronJobOverview;
    };

function formatRelative(iso: string | undefined, t: TFunction<'alwaysOn'>): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  const diff = Date.now() - parsed;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return t('relative.justNow', { defaultValue: 'just now' });
  const min = Math.round(sec / 60);
  if (min < 60) return t('relative.minutes', { count: min, defaultValue: `${min}m ago` });
  const hr = Math.round(min / 60);
  if (hr < 24) return t('relative.hours', { count: hr, defaultValue: `${hr}h ago` });
  const day = Math.round(hr / 24);
  return t('relative.days', { count: day, defaultValue: `${day}d ago` });
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  return new Date(parsed).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function toIsoFromMs(value?: number): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function getPlanFileName(plan: DiscoveryPlanOverview): string {
  const filePath = plan.planFilePath?.trim();
  const fileName = filePath ? filePath.split(/[\\/]/).filter(Boolean).pop() : '';
  return (fileName || plan.title).replace(/\.md$/i, '');
}

export function getPlanRowTitle(plan: DiscoveryPlanOverview): string {
  return plan.title || getPlanFileName(plan);
}

function truncateText(value: string | undefined, maxLength = CRON_TITLE_MAX_LENGTH): string {
  const text = value?.trim() || '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function getCronPromptTitle(prompt: string | undefined): string {
  const firstLine = prompt?.trimStart().split(/\r?\n/, 1)[0]?.trim() || '';
  const match = firstLine.match(/^#(?!#)\s+(.+)$/);
  return match?.[1]?.replace(/\s+#+\s*$/, '').trim() || '';
}

function getCronTypeLabel(job: CronJobOverview, t: TFunction<'alwaysOn'>): string {
  const key =
    job.durable === false
      ? job.recurring
        ? 'types.cronSessionRecurring'
        : 'types.cronSessionOneShot'
      : job.recurring
        ? 'types.cronPersistentRecurring'
        : 'types.cronPersistentOneShot';
  const label = t(key, {
    defaultValue: `${job.durable === false ? 'session-scope' : 'persistent'} / ${
      job.recurring ? 'recurring' : 'one-shot'
    }`,
  });

  if (!job.manualOnly) {
    return label;
  }

  return `${label} / ${t('types.manual', { defaultValue: 'manual' })}`;
}

function getCronTriggerLabel(job: CronJobOverview, t: TFunction<'alwaysOn'>): string {
  const labels = [
    job.recurring
      ? t('detail.trigger.recurring', { defaultValue: 'Recurring' })
      : t('detail.trigger.oneShot', { defaultValue: 'One-shot' }),
  ];

  if (job.manualOnly) {
    labels.push(t('detail.trigger.manualOnly', { defaultValue: 'Manual only' }));
  }
  if (job.permanent) {
    labels.push(t('detail.trigger.permanent', { defaultValue: 'Permanent' }));
  }

  return labels.join(' / ');
}

function getCronScopeLabel(job: CronJobOverview, t: TFunction<'alwaysOn'>): string {
  return job.durable === false
    ? t('detail.scope.session', { defaultValue: 'Session-scope' })
    : t('detail.scope.persistent', { defaultValue: 'Persistent' });
}

function getDetailTitle(row: AlwaysOnRow): string {
  return row.kind === 'plan' ? row.plan.title || row.title : row.title;
}

function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const HIDDEN_RUN_METADATA_KEYS = new Set([
  'source',
  'sourceId',
  'parentSessionId',
  'logUpdatedAt',
  'logSize',
  'logTruncated',
]);

export function getVisibleRunMetadataEntries(metadata: Record<string, unknown> | undefined) {
  return Object.entries(metadata || {}).filter(([key]) => !HIDDEN_RUN_METADATA_KEYS.has(key));
}

function getHistorySessionLabel(run: AlwaysOnRunHistoryEntry, t: TFunction<'alwaysOn'>): string {
  if (run.session?.sessionId || run.session?.relativeTranscriptPath) {
    return t('history.session.available', { defaultValue: 'Available' });
  }
  return '—';
}

function getLogSourceLabel(log: AlwaysOnRunLogResponse | null, detail: AlwaysOnRunHistoryDetail): string {
  if (log?.source) return log.source;
  const metadataSource = detail.metadata?.logSource;
  return typeof metadataSource === 'string' ? metadataSource : 'history';
}

function canRunRow(row: AlwaysOnRow): boolean {
  return row.kind === 'cron' || (row.plan.status === 'ready' && !row.plan.executionSessionId);
}

function canArchiveOrDeleteRow(row: AlwaysOnRow): boolean {
  return (
    row.kind === 'cron' ||
    (row.plan.executionStatus !== 'running' &&
      row.plan.executionStatus !== 'queued' &&
      row.plan.status !== 'running' &&
      row.plan.status !== 'queued')
  );
}

export function isActivePlan(plan: DiscoveryPlanOverview): boolean {
  return plan.status !== 'completed' && plan.status !== 'superseded' && plan.executionStatus !== 'completed';
}

export function isActiveCronJob(job: CronJobOverview): boolean {
  return job.status !== 'completed' && job.status !== 'unknown';
}

export function isVisibleRunHistoryEntry(run: AlwaysOnRunHistoryEntry): boolean {
  return run.status !== 'unknown';
}

export function shouldPollRunLog(status: AlwaysOnRunHistoryStatus | undefined): boolean {
  return status === 'queued' || status === 'running';
}

function DetailSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-neutral-200 p-4 dark:border-neutral-800', className)}>
      <h3 className="mb-3 text-xxs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {title}
      </h3>
      {children}
    </section>
  );
}

function DetailMetaItem({
  label,
  value,
  children,
  onClick,
  mono = false,
}: {
  label: string;
  value?: string | number;
  children?: ReactNode;
  onClick?: () => void;
  mono?: boolean;
}) {
  const hasValue = value !== null && value !== undefined && value !== '';
  const displayValue = hasValue ? value : '—';
  const valueClassName = cn(
    'break-words text-[13px] text-neutral-800 dark:text-neutral-200',
    mono && 'font-mono text-[12px]',
  );

  return (
    <div className="space-y-1">
      <div className="text-xxs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-500">
        {label}
      </div>
      {children ? (
        <div className={valueClassName}>{children}</div>
      ) : onClick && hasValue ? (
        <button
          type="button"
          onClick={onClick}
          className={cn(
            valueClassName,
            'rounded-sm text-left text-blue-600 outline-none transition hover:text-blue-700 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400 dark:hover:text-blue-300',
          )}
        >
          {displayValue}
        </button>
      ) : (
        <div className={valueClassName}>{displayValue}</div>
      )}
    </div>
  );
}

function getRows(
  plans: DiscoveryPlanOverview[],
  cronJobs: CronJobOverview[],
  t: TFunction<'alwaysOn'>,
): AlwaysOnRow[] {
  const planRows: AlwaysOnRow[] = plans.filter(isActivePlan).map((plan) => {
    const completed =
      plan.status === 'completed' || plan.executionStatus === 'completed'
        ? plan.executionLastActivityAt || plan.updatedAt
        : undefined;

    return {
      kind: 'plan',
      id: `plan:${plan.id}`,
      title: getPlanRowTitle(plan),
      typeLabel: t('types.plan', { defaultValue: 'plan' }),
      statusLabel: plan.executionStatus || plan.status,
      createdAt: plan.createdAt,
      triggeredAt: plan.executionStartedAt,
      completedAt: completed,
      sortAt: plan.updatedAt,
      plan,
    };
  });

  const cronRows: AlwaysOnRow[] = cronJobs.filter(isActiveCronJob).map((job) => {
    const createdAt = toIsoFromMs(job.createdAt);
    const lastFiredAt = toIsoFromMs(job.lastFiredAt);
    const latestActivity = job.latestRun?.lastActivity || undefined;
    const triggeredAt = lastFiredAt || latestActivity;
    const completedAt = job.status === 'completed' ? latestActivity : undefined;

    return {
      kind: 'cron',
      id: `cron:${job.id}`,
      title: truncateText(getCronPromptTitle(job.prompt) || job.prompt) || job.cron,
      typeLabel: getCronTypeLabel(job, t),
      statusLabel: job.status,
      createdAt,
      triggeredAt,
      completedAt,
      sortAt: triggeredAt || createdAt || '',
      cronJob: job,
    };
  });

  return [...planRows, ...cronRows].sort((a, b) => b.sortAt.localeCompare(a.sortAt));
}

export default function AlwaysOnV2({
  selectedProject,
  onStartDiscoverySession,
  onExecuteDiscoveryPlan,
  onOpenCronSession,
  onOpenSession,
}: AlwaysOnV2Props) {
  const { t } = useTranslation('alwaysOn');
  const [activeSubTab, setActiveSubTab] = useState<AlwaysOnSubTab>('items');
  const [plans, setPlans] = useState<DiscoveryPlanOverview[]>([]);
  const [cronJobs, setCronJobs] = useState<CronJobOverview[]>([]);
  const [runHistory, setRunHistory] = useState<AlwaysOnRunHistoryEntry[]>([]);
  const [historyDetailRunId, setHistoryDetailRunId] = useState<string | null>(null);
  const [historyDetail, setHistoryDetail] = useState<AlwaysOnRunHistoryDetail | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyLog, setHistoryLog] = useState<AlwaysOnRunLogResponse | null>(null);
  const [historyLogLoading, setHistoryLogLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [runningRowId, setRunningRowId] = useState<string | null>(null);
  const [deletingRowId, setDeletingRowId] = useState<string | null>(null);
  const [detailRowId, setDetailRowId] = useState<string | null>(null);

  const projectName = selectedProject?.name ?? null;

  const openSession = useCallback((target: AlwaysOnSessionTarget | null) => {
    if (!target) return;
    void onOpenSession(target);
  }, [onOpenSession]);

  const refresh = useCallback(async () => {
    if (!projectName) {
      setPlans([]);
      setCronJobs([]);
      setRunHistory([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [plansResponse, cronJobsResponse, runHistoryResponse] = await Promise.all([
        api.projectDiscoveryPlans(projectName),
        api.projectCronJobs(projectName),
        api.projectAlwaysOnRunHistory(projectName),
      ]);

      if (!plansResponse.ok) {
        const body = (await plansResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${plansResponse.status}`);
      }
      if (!cronJobsResponse.ok) {
        const body = (await cronJobsResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${cronJobsResponse.status}`);
      }
      if (!runHistoryResponse.ok) {
        const body = (await runHistoryResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${runHistoryResponse.status}`);
      }

      const plansPayload = (await plansResponse.json()) as ProjectDiscoveryPlansResponse;
      const cronJobsPayload = (await cronJobsResponse.json()) as ProjectCronJobsResponse;
      const runHistoryPayload = (await runHistoryResponse.json()) as ProjectAlwaysOnRunHistoryResponse;
      setPlans(Array.isArray(plansPayload.plans) ? plansPayload.plans : []);
      setCronJobs(Array.isArray(cronJobsPayload.jobs) ? cronJobsPayload.jobs : []);
      setRunHistory(
        Array.isArray(runHistoryPayload.runs)
          ? runHistoryPayload.runs.filter(isVisibleRunHistoryEntry)
          : [],
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    void refresh();
    if (!projectName) return undefined;
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [projectName, refresh]);

  useEffect(() => {
    setDetailRowId(null);
    setHistoryDetailRunId(null);
    setHistoryDetail(null);
    setHistoryLog(null);
  }, [projectName]);

  useEffect(() => {
    setDetailRowId(null);
    setHistoryDetailRunId(null);
    setHistoryDetail(null);
    setHistoryLog(null);
  }, [activeSubTab]);

  const refreshHistoryLog = useCallback(async (runId: string) => {
    if (!projectName) return;
    setHistoryLogLoading(true);
    try {
      const response = await api.projectAlwaysOnRunLog(projectName, runId);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as AlwaysOnRunLogResponse;
      setHistoryLog(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setHistoryLogLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    if (!historyDetailRunId || !historyDetail) return undefined;
    if (!shouldPollRunLog(historyDetail.status)) return undefined;

    const timer = window.setInterval(() => {
      void refreshHistoryLog(historyDetailRunId);
    }, LOG_POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [historyDetail, historyDetailRunId, refreshHistoryLog]);

  const runningPlans = plans.filter(
    (plan) => plan.status === 'running' || plan.executionStatus === 'running',
  );
  const isRunning = runningPlans.length > 0;
  const rows = getRows(plans, cronJobs, t);
  const detailRow = detailRowId ? rows.find((row) => row.id === detailRowId) || null : null;
  const projectRoot = selectedProject?.fullPath || selectedProject?.path || selectedProject?.name || '';
  const claudeDirectory = projectRoot ? `${projectRoot.replace(/\/$/, '')}/.claude` : '.claude';

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t('emptyProject', { defaultValue: 'Pick a project to view Always-On.' })}
      </div>
    );
  }

  const handleLaunchDiscovery = async () => {
    setLaunching(true);
    try {
      await onStartDiscoverySession();
    } finally {
      setLaunching(false);
    }
  };

  const handleExecutePlan = async (planId: string) => {
    const rowId = `plan:${planId}`;
    setRunningRowId(rowId);
    try {
      await onExecuteDiscoveryPlan(planId, 'manual');
      void refresh();
    } finally {
      setRunningRowId(null);
    }
  };

  const handleArchivePlan = async (planId: string) => {
    if (!projectName) return;
    const rowId = `plan:${planId}`;
    setDeletingRowId(rowId);
    setError(null);
    try {
      const response = await api.archiveProjectDiscoveryPlan(projectName, planId);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeletingRowId(null);
    }
  };

  const handleRunCronJob = async (taskId: string) => {
    if (!projectName) return;
    const rowId = `cron:${taskId}`;
    setRunningRowId(rowId);
    setError(null);
    try {
      const response = await api.runProjectCronJobNow(projectName, taskId);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningRowId(null);
    }
  };

  const handleDeleteCronJob = async (taskId: string) => {
    if (!projectName) return;
    const rowId = `cron:${taskId}`;
    setDeletingRowId(rowId);
    setError(null);
    try {
      const response = await api.deleteProjectCronJob(projectName, taskId);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeletingRowId(null);
    }
  };

  const handleOpenHistoryDetail = async (runId: string) => {
    if (!projectName) return;
    setHistoryDetailRunId(runId);
    setHistoryDetail(null);
    setHistoryLog(null);
    setHistoryDetailLoading(true);
    setError(null);
    try {
      const response = await api.projectAlwaysOnRunHistoryDetail(projectName, runId);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as ProjectAlwaysOnRunHistoryDetailResponse;
      setHistoryDetail(payload.run);
      setHistoryLog({
        runId,
        content: payload.run.outputLog || '',
        truncated: Boolean(payload.run.metadata?.logTruncated),
        updatedAt: typeof payload.run.metadata?.logUpdatedAt === 'string'
          ? payload.run.metadata.logUpdatedAt
          : undefined,
        size: typeof payload.run.metadata?.logSize === 'number' ? payload.run.metadata.logSize : 0,
        source: payload.run.metadata?.logSource === 'log-file' ||
          payload.run.metadata?.logSource === 'session'
          ? payload.run.metadata.logSource
          : 'history',
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setHistoryDetailLoading(false);
    }
  };

  const renderRowActions = (
    row: AlwaysOnRow,
    { includeCronSessionView = true }: { includeCronSessionView?: boolean } = {},
  ) => {
    const isBusyRunning = runningRowId === row.id;
    const isBusyDeleting = deletingRowId === row.id;
    const canRun = canRunRow(row);
    const canArchiveOrDelete = canArchiveOrDeleteRow(row);
    const canOpenCronSession = Boolean(
      row.kind === 'cron' &&
        row.cronJob.latestRun?.sessionId &&
        row.cronJob.latestRun?.parentSessionId &&
        row.cronJob.latestRun?.relativeTranscriptPath,
    );

    return (
      <>
        {includeCronSessionView && row.kind === 'cron' ? (
          <button
            type="button"
            onClick={() => onOpenCronSession(row.cronJob)}
            disabled={!canOpenCronSession || isBusyRunning || isBusyDeleting}
            title={
              canOpenCronSession
                ? undefined
                : t('actions.openDisabled', {
                    defaultValue: 'This cron job has not produced a session yet.',
                  })
            }
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xxs text-neutral-600 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            <Eye className="h-3 w-3" strokeWidth={1.75} />
            {t('actions.view', { defaultValue: 'View' })}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() =>
            row.kind === 'plan'
              ? void handleExecutePlan(row.plan.id)
              : void handleRunCronJob(row.cronJob.id)
          }
          disabled={!canRun || isBusyRunning || isBusyDeleting}
          title={
            canRun
              ? undefined
              : t('actions.runDisabled', { defaultValue: 'This item cannot be run now.' })
          }
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-neutral-900 px-2 text-xxs text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-50 dark:text-neutral-900"
        >
          {isBusyRunning ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
          ) : (
            <Sparkles className="h-3 w-3" strokeWidth={1.75} />
          )}
          {t('actions.run', { defaultValue: 'Run' })}
        </button>
        <button
          type="button"
          onClick={() =>
            row.kind === 'plan'
              ? void handleArchivePlan(row.plan.id)
              : void handleDeleteCronJob(row.cronJob.id)
          }
          disabled={!canArchiveOrDelete || isBusyDeleting || isBusyRunning}
          title={
            canArchiveOrDelete
              ? undefined
              : t('actions.archiveDeleteDisabled', {
                  defaultValue: 'Running items cannot be archived or deleted.',
                })
          }
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xxs text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          {isBusyDeleting ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
          ) : (
            <Trash2 className="h-3 w-3" strokeWidth={1.75} />
          )}
          {row.kind === 'plan'
            ? t('actions.archive', { defaultValue: 'Archive' })
            : t('actions.delete', { defaultValue: 'Delete' })}
        </button>
      </>
    );
  };

  const renderDetailHeader = (row: AlwaysOnRow) => (
    <div className="mb-5 flex flex-col gap-4 border-b border-neutral-200 pb-4 dark:border-neutral-800 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => setDetailRowId(null)}
          className="mb-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xxs text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          {t('actions.back', { defaultValue: 'Back' })}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="break-words text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {getDetailTitle(row)}
          </h2>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {renderRowActions(row, { includeCronSessionView: false })}
      </div>
    </div>
  );

  const renderContextRefs = (plan: DiscoveryPlanOverview) => {
    const contextRefEntries = [
      ['workingDirectory', t('detail.context.workingDirectory', { defaultValue: 'Working Directory' })],
      ['memory', t('detail.context.memory', { defaultValue: 'Memory' })],
      ['cronJobs', t('detail.context.cronJobs', { defaultValue: 'Cron Jobs' })],
      ['recentChats', t('detail.context.recentChats', { defaultValue: 'Recent Chats' })],
    ] as const;

    const visibleGroups = contextRefEntries
      .map(([key, label]) => ({ key, label, values: plan.contextRefs?.[key] || [] }))
      .filter((group) => group.values.length > 0);

    if (visibleGroups.length === 0) {
      return (
        <p className="text-[13px] text-neutral-500 dark:text-neutral-400">
          {t('detail.none', { defaultValue: 'None' })}
        </p>
      );
    }

    return (
      <div className="min-w-0 space-y-4">
        {visibleGroups.map((group) => (
          <div key={group.key} className="min-w-0">
            <h4 className="mb-2 text-xxs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-500">
              {group.label}
            </h4>
            <ul className="min-w-0 space-y-1.5">
              {group.values.map((value) => (
                <li
                  key={value}
                  className="min-w-0 overflow-hidden whitespace-normal break-words rounded-md bg-neutral-50 px-2 py-1.5 font-mono text-[12px] text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                >
                  {value}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  };

  const renderPlanDetail = (row: Extract<AlwaysOnRow, { kind: 'plan' }>) => {
    const { plan } = row;

    return (
      <>
        {renderDetailHeader(row)}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            {plan.summary || plan.rationale ? (
              <DetailSection title={t('detail.sections.summary', { defaultValue: 'Summary' })}>
                {plan.summary ? (
                  <p className="text-[13px] leading-6 text-neutral-800 dark:text-neutral-200">
                    {plan.summary}
                  </p>
                ) : null}
                {plan.rationale ? (
                  <p className="mt-3 text-[13px] leading-6 text-neutral-600 dark:text-neutral-400">
                    {plan.rationale}
                  </p>
                ) : null}
              </DetailSection>
            ) : null}
            <DetailSection title={t('detail.sections.planMarkdown', { defaultValue: 'Plan Markdown' })}>
              {plan.content?.trim() ? (
                <MarkdownContent
                  content={plan.content}
                  className="prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:font-semibold prose-p:leading-6"
                />
              ) : (
                <p className="text-[13px] text-neutral-500 dark:text-neutral-400">
                  {t('detail.emptyContent', { defaultValue: 'No plan markdown content.' })}
                </p>
              )}
            </DetailSection>
          </div>
          <aside className="space-y-4">
            <DetailSection title={t('detail.sections.planFile', { defaultValue: 'Plan File' })}>
              <div className="space-y-4">
                <DetailMetaItem label={t('detail.fields.claudeDirectory', { defaultValue: '.claude directory' })} value={claudeDirectory} mono />
                <DetailMetaItem label={t('detail.fields.createdAt', { defaultValue: 'Created' })} value={formatTime(plan.createdAt)} mono />
                <DetailMetaItem label={t('detail.fields.updatedAt', { defaultValue: 'Updated' })} value={formatTime(plan.updatedAt)} mono />
              </div>
            </DetailSection>
            <DetailSection title={t('detail.sections.contextRefs', { defaultValue: 'Context Refs' })}>
              {renderContextRefs(plan)}
            </DetailSection>
          </aside>
        </div>
      </>
    );
  };

  const renderCronDetail = (row: Extract<AlwaysOnRow, { kind: 'cron' }>) => {
    const { cronJob } = row;
    const latestRun = cronJob.latestRun;
    const latestRunTarget =
      latestRun?.sessionId && latestRun.parentSessionId && latestRun.relativeTranscriptPath
        ? {
            kind: 'background' as const,
            sessionId: latestRun.sessionId,
            parentSessionId: latestRun.parentSessionId,
            relativeTranscriptPath: latestRun.relativeTranscriptPath,
            title: latestRun.summary || cronJob.prompt || cronJob.cron,
            summary: latestRun.summary || cronJob.prompt || cronJob.cron,
            lastActivity: latestRun.lastActivity,
            transcriptKey: latestRun.transcriptKey || cronJob.transcriptKey,
            taskId: latestRun.taskId,
            taskStatus: cronJob.status,
            outputFile: latestRun.outputFile,
          }
        : null;

    return (
      <>
        {renderDetailHeader(row)}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <DetailSection title={t('detail.sections.prompt', { defaultValue: 'Prompt' })}>
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-neutral-50 p-4 text-[13px] leading-6 text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
                {cronJob.prompt}
              </pre>
            </DetailSection>
          </div>
          <aside className="space-y-4">
            <DetailSection title={t('detail.sections.schedule', { defaultValue: 'Schedule' })}>
              <div className="space-y-4">
                <DetailMetaItem label={t('detail.fields.cronExpression', { defaultValue: 'Cron expression' })} value={cronJob.cron} mono />
                <DetailMetaItem label={t('detail.fields.currentStatus', { defaultValue: 'Current status' })} value={cronJob.status} />
                <DetailMetaItem label={t('detail.fields.triggerType', { defaultValue: 'Trigger type' })} value={getCronTriggerLabel(cronJob, t)} />
                <DetailMetaItem label={t('detail.fields.scope', { defaultValue: 'Scope' })} value={getCronScopeLabel(cronJob, t)} />
                <DetailMetaItem label={t('detail.fields.createdAt', { defaultValue: 'Created' })} value={formatTime(toIsoFromMs(cronJob.createdAt))} mono />
                <DetailMetaItem label={t('detail.fields.lastFiredAt', { defaultValue: 'Last fired' })} value={formatTime(toIsoFromMs(cronJob.lastFiredAt))} mono />
              </div>
            </DetailSection>
            <DetailSection title={t('detail.sections.createdFrom', { defaultValue: 'Created From' })}>
              <div className="space-y-4">
                <DetailMetaItem
                  label={t('detail.fields.originSessionId', { defaultValue: 'Origin session' })}
                  value={cronJob.originSessionId}
                  onClick={cronJob.originSessionId ? () => openSession({ kind: 'origin', sessionId: cronJob.originSessionId! }) : undefined}
                  mono
                />
                <DetailMetaItem
                  label={t('detail.fields.sessionId', { defaultValue: 'Session ID' })}
                  value={latestRun?.sessionId}
                  onClick={latestRunTarget ? () => openSession(latestRunTarget) : undefined}
                  mono
                />
                <DetailMetaItem label={t('detail.fields.transcriptKey', { defaultValue: 'Transcript key' })} value={cronJob.transcriptKey} mono />
              </div>
            </DetailSection>
          </aside>
        </div>
      </>
    );
  };

  const renderHistoryDetail = () => {
    if (!historyDetailRunId) return null;
    const metadataEntries = historyDetail ? getVisibleRunMetadataEntries(historyDetail.metadata) : [];
    const historySession = historyDetail?.session;
    const historySessionId =
      typeof historyDetail?.metadata?.sessionId === 'string'
        ? historyDetail.metadata.sessionId
        : historySession?.sessionId;
    const originSessionId =
      typeof historyDetail?.metadata?.originSessionId === 'string'
        ? historyDetail.metadata.originSessionId
        : historySession?.parentSessionId;
    const historySessionTarget =
      historyDetail &&
      historySessionId &&
      historySession?.parentSessionId &&
      historySession.relativeTranscriptPath
        ? {
            kind: 'background' as const,
            sessionId: historySessionId,
            parentSessionId: historySession.parentSessionId,
            relativeTranscriptPath: historySession.relativeTranscriptPath,
            title: historyDetail.title,
            summary: historyDetail.title,
          }
        : null;

    return (
      <div>
        <div className="mb-5 flex flex-col gap-4 border-b border-neutral-200 pb-4 dark:border-neutral-800 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => {
                setHistoryDetailRunId(null);
                setHistoryDetail(null);
              }}
              className="mb-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xxs text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t('actions.back', { defaultValue: 'Back' })}
            </button>
            <h2 className="break-words text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
              {historyDetail?.title || t('history.detailTitle', { defaultValue: 'Run detail' })}
            </h2>
          </div>
        </div>

        {historyDetailLoading ? (
          <div className="flex items-center gap-2 text-[13px] text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t('history.loadingDetail', { defaultValue: 'Loading run detail…' })}</span>
          </div>
        ) : historyDetail ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <DetailSection title={t('history.sections.outputLog', { defaultValue: 'Output Log' })}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xxs text-neutral-500 dark:text-neutral-400">
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    {t('history.log.source', { defaultValue: 'Source' })}: {getLogSourceLabel(historyLog, historyDetail)}
                  </span>
                  <span>
                    {t('history.log.updatedAt', { defaultValue: 'Last updated' })}: {formatTime(historyLog?.updatedAt)}
                  </span>
                  {historyLog?.truncated ? (
                    <span>{t('history.log.truncated', { defaultValue: 'truncated' })}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => historyDetailRunId ? void refreshHistoryLog(historyDetailRunId) : undefined}
                  disabled={historyLogLoading}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xxs text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
                >
                  <RefreshCw className={cn('h-3 w-3', historyLogLoading && 'animate-spin')} strokeWidth={1.75} />
                  {t('actions.refresh', { defaultValue: 'Refresh' })}
                </button>
              </div>
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-neutral-50 p-4 text-[12px] leading-6 text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
                {historyLog?.content || historyDetail.outputLog || t('history.emptyLog', { defaultValue: 'No output log was captured for this run.' })}
              </pre>
            </DetailSection>
            <aside>
              <DetailSection title={t('history.sections.metadata', { defaultValue: 'Metadata' })}>
                {metadataEntries.length > 0 ? (
                  <div className="space-y-4">
                    {metadataEntries.map(([key, value]) => {
                      const formattedValue = formatMetadataValue(value);
                      return (
                        <DetailMetaItem
                          key={key}
                          label={key}
                          value={formattedValue}
                          onClick={
                            key === 'sessionId' && historySessionTarget
                              ? () => openSession(historySessionTarget)
                              : key === 'originSessionId' && originSessionId
                                ? () => openSession({ kind: 'origin', sessionId: originSessionId })
                                : undefined
                          }
                          mono
                        />
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[13px] text-neutral-500 dark:text-neutral-400">
                    {t('detail.none', { defaultValue: 'None' })}
                  </p>
                )}
              </DetailSection>
            </aside>
          </div>
        ) : (
          <p className="text-[13px] text-neutral-500 dark:text-neutral-400">
            {t('history.missing', { defaultValue: 'This run history entry is no longer available.' })}
          </p>
        )}
      </div>
    );
  };

  const renderHistory = () => {
    if (historyDetailRunId) {
      return renderHistoryDetail();
    }

    if (loading && runHistory.length === 0) {
      return (
        <div className="flex items-center gap-2 text-[13px] text-neutral-500 dark:text-neutral-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          <span>{t('history.loading', { defaultValue: 'Loading run history…' })}</span>
        </div>
      );
    }

    if (runHistory.length === 0) {
      return (
        <div className="text-[13px] text-neutral-500 dark:text-neutral-400">
          {t('history.empty', { defaultValue: 'No Always-On runs have been recorded yet.' })}
        </div>
      );
    }

    return (
      <div className="overflow-x-auto">
        <div className="min-w-[880px] text-[13px]">
          <div
            className={cn(
              'text-xxs grid gap-3 border-b border-neutral-200 pb-2 font-medium text-neutral-500 dark:border-neutral-800 dark:text-neutral-400',
              HISTORY_TABLE_GRID_COLUMNS,
            )}
          >
            <span>{t('history.table.title', { defaultValue: 'Title' })}</span>
            <span>{t('history.table.kind', { defaultValue: 'Kind' })}</span>
            <span>{t('history.table.status', { defaultValue: 'Status' })}</span>
            <span>{t('history.table.started', { defaultValue: 'Started' })}</span>
            <span>{t('history.table.source', { defaultValue: 'Source' })}</span>
            <span>{t('history.table.session', { defaultValue: 'Session' })}</span>
          </div>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-900">
            {runHistory.map((run) => (
              <div key={run.runId} className={cn('grid gap-3 py-3', HISTORY_TABLE_GRID_COLUMNS)}>
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => void handleOpenHistoryDetail(run.runId)}
                    className="block max-w-full truncate rounded-sm text-left font-medium text-blue-600 outline-none transition hover:text-blue-700 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    {run.title}
                  </button>
                </div>
                <div className="self-center text-xxs capitalize text-neutral-600 dark:text-neutral-300">
                  {run.kind}
                </div>
                <div className="self-center text-xxs text-neutral-600 dark:text-neutral-300">
                  {run.status}
                </div>
                <div className="self-center font-mono text-xxs text-neutral-500 dark:text-neutral-400">
                  {formatTime(run.startedAt)}
                </div>
                <div className="self-center truncate font-mono text-xxs text-neutral-500 dark:text-neutral-400">
                  {run.sourceId}
                </div>
                <div className="self-center text-xxs text-neutral-600 dark:text-neutral-300">
                  {getHistorySessionLabel(run, t)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderDetail = () => {
    if (!detailRowId) return null;
    if (!detailRow) {
      return (
        <div>
          <button
            type="button"
            onClick={() => setDetailRowId(null)}
            className="mb-4 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xxs text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
            {t('actions.back', { defaultValue: 'Back' })}
          </button>
          <p className="text-[13px] text-neutral-500 dark:text-neutral-400">
            {t('detail.missing', { defaultValue: 'This Always-On item is no longer available.' })}
          </p>
        </div>
      );
    }

    return detailRow.kind === 'plan' ? renderPlanDetail(detailRow) : renderCronDetail(detailRow);
  };

  return (
    <div className="h-full bg-white dark:bg-neutral-950">
      <div
        role="tablist"
        aria-label={t('tabs.ariaLabel', { defaultValue: 'Always-On sections' })}
        className="scrollbar-thin flex h-9 items-center gap-1 overflow-x-auto border-b border-neutral-200 px-4 dark:border-neutral-800"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeSubTab === 'items'}
          onClick={() => setActiveSubTab('items')}
          className={cn(
            'inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-[13px] transition-colors',
            activeSubTab === 'items'
              ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
              : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
          )}
        >
          {t('tabs.plansCron', { defaultValue: 'Plans & Cron Jobs' })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSubTab === 'history'}
          onClick={() => setActiveSubTab('history')}
          className={cn(
            'inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-[13px] transition-colors',
            activeSubTab === 'history'
              ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
              : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
          )}
        >
          {t('tabs.runHistory', { defaultValue: 'Run History' })}
        </button>
      </div>

      <div className="h-[calc(100%-2.25rem)] overflow-y-auto">
        <div className="w-full space-y-4 px-8 py-5">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
                {t('title', { defaultValue: 'Always-On' })}
              </h2>
              <p className="mt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
                {t('subtitle', { defaultValue: 'Background discovery agent for this project.' })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-xxs text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
                <span>{t('actions.refresh', { defaultValue: 'Refresh' })}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleLaunchDiscovery()}
                disabled={launching}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-xxs text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
              >
                {launching ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                ) : isRunning ? (
                  <Pause className="h-3.5 w-3.5" strokeWidth={1.75} />
                ) : (
                  <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
                )}
                <span>
                  {isRunning
                    ? t('status.running', { defaultValue: 'Running' })
                    : t('actions.discover', { defaultValue: 'Discover' })}
                </span>
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
            {error ? (
              <div className="mb-4 flex items-center gap-2 text-xxs text-red-500">
                <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>{error}</span>
              </div>
            ) : null}

          {activeSubTab === 'history' ? (
            renderHistory()
          ) : detailRowId ? (
            renderDetail()
          ) : loading && rows.length === 0 ? (
            <div className="flex items-center gap-2 text-[13px] text-neutral-500 dark:text-neutral-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              <span>{t('loading.items', { defaultValue: 'Loading items…' })}</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="text-[13px] text-neutral-500 dark:text-neutral-400">
              {t('empty.items', {
                defaultValue: 'No active plans or cron jobs. Completed runs are available in Run History.',
              })}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[980px] text-[13px]">
                <div
                  className={cn(
                    'text-xxs grid gap-3 border-b border-neutral-200 pb-2 font-medium text-neutral-500 dark:border-neutral-800 dark:text-neutral-400',
                    TABLE_GRID_COLUMNS,
                  )}
                >
                  <span>{t('table.title', { defaultValue: 'Title' })}</span>
                  <span>{t('table.type', { defaultValue: 'Type' })}</span>
                  <span>{t('table.status', { defaultValue: 'Status' })}</span>
                  <span>{t('table.created', { defaultValue: 'Created' })}</span>
                  <span>{t('table.triggered', { defaultValue: 'Triggered' })}</span>
                  <span>{t('table.completed', { defaultValue: 'Completed' })}</span>
                  <span aria-hidden="true" />
                </div>
                <div className="divide-y divide-neutral-100 dark:divide-neutral-900">
                  {rows.map((row) => {
                    return (
                      <div
                        key={row.id}
                        className={cn('grid gap-3 py-3', TABLE_GRID_COLUMNS)}
                      >
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => setDetailRowId(row.id)}
                            className="block max-w-full truncate rounded-sm text-left font-medium text-blue-600 outline-none transition hover:text-blue-700 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
                          >
                            {row.title}
                          </button>
                        </div>
                        <div className="self-center text-xxs text-neutral-600 dark:text-neutral-300">
                          {row.typeLabel}
                        </div>
                        <div className="self-center text-xxs text-neutral-600 dark:text-neutral-300">
                          {row.statusLabel}
                        </div>
                        <div className="self-center font-mono text-xxs text-neutral-500 dark:text-neutral-400">
                          {formatTime(row.createdAt)}
                        </div>
                        <div className="self-center font-mono text-xxs text-neutral-500 dark:text-neutral-400">
                          {formatTime(row.triggeredAt)}
                        </div>
                        <div className="self-center font-mono text-xxs text-neutral-500 dark:text-neutral-400">
                          {formatTime(row.completedAt)}
                        </div>
                        <div className="flex items-center justify-end gap-1.5">
                          {renderRowActions(row)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {plans.length > 0 ? (
          <p className="text-center text-xxs text-neutral-500 dark:text-neutral-500">
            {t('updatedAt', {
              relative: formatRelative(plans[0]?.updatedAt, t),
              defaultValue: `Updated ${formatRelative(plans[0]?.updatedAt, t)}`,
            })}
          </p>
        ) : null}
        </div>
      </div>
    </div>
  );
}
