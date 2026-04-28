import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertCircle,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import type {
  DiscoveryPlanOverview,
  Project,
  ProjectDiscoveryPlansResponse,
} from '../../types/app';
import { api } from '../../utils/api';
import { cn } from '../../lib/utils.js';

type AlwaysOnV2Props = {
  selectedProject: Project | null;
  onStartDiscoverySession: () => void | Promise<void>;
  onExecuteDiscoveryPlan: (planId: string, source?: 'manual' | 'auto') => void | Promise<void>;
  onOpenDiscoverySession: (sessionId: string) => void;
};

const POLL_INTERVAL_MS = 15_000;

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
  return new Date(parsed).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function AlwaysOnV2({
  selectedProject,
  onStartDiscoverySession,
  onExecuteDiscoveryPlan,
  onOpenDiscoverySession,
}: AlwaysOnV2Props) {
  const { t } = useTranslation('alwaysOn');
  const [plans, setPlans] = useState<DiscoveryPlanOverview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [executingId, setExecutingId] = useState<string | null>(null);

  const projectName = selectedProject?.name ?? null;

  const refresh = useCallback(async () => {
    if (!projectName) {
      setPlans([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.projectDiscoveryPlans(projectName);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as ProjectDiscoveryPlansResponse;
      setPlans(Array.isArray(payload.plans) ? payload.plans : []);
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

  const runningPlans = plans.filter(
    (plan) => plan.status === 'running' || plan.executionStatus === 'running',
  );
  const readyPlans = plans.filter((plan) => plan.status === 'ready');
  const isRunning = runningPlans.length > 0;
  const recent = [...plans]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);

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
    setExecutingId(planId);
    try {
      await onExecuteDiscoveryPlan(planId, 'manual');
      void refresh();
    } finally {
      setExecutingId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-neutral-950">
      <div className="mx-auto w-full max-w-[880px] space-y-4 px-8 py-8">
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
              className="text-xxs inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
              <span>{t('actions.refresh', { defaultValue: 'Refresh' })}</span>
            </button>
            <button
              type="button"
              onClick={() => void handleLaunchDiscovery()}
              disabled={launching}
              className="text-xxs inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
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
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              {isRunning ? (
                <>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </>
              ) : (
                <span className="relative inline-flex h-2 w-2 rounded-full bg-neutral-300 dark:bg-neutral-700" />
              )}
            </span>
            <span className="text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
              {isRunning
                ? t('status.running', { defaultValue: 'Running' })
                : readyPlans.length
                  ? t('status.ready', { defaultValue: 'Ready' })
                  : t('status.idle', { defaultValue: 'Idle' })}
            </span>
            <span className="text-xxs text-neutral-500 dark:text-neutral-400">
              ·{' '}
              {runningPlans.length
                ? t('summary.running', {
                    count: runningPlans.length,
                    defaultValue: `${runningPlans.length} running`,
                  })
                : t('summary.ready', {
                    count: readyPlans.length,
                    defaultValue: `${readyPlans.length} plans ready`,
                  })}
            </span>
          </div>

          <div className="my-4 h-px bg-neutral-200 dark:bg-neutral-800" />

          {error ? (
            <div className="text-xxs flex items-center gap-2 text-red-500">
              <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>{error}</span>
            </div>
          ) : loading && plans.length === 0 ? (
            <div className="flex items-center gap-2 text-[13px] text-neutral-500 dark:text-neutral-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              <span>{t('loading.plans', { defaultValue: 'Loading plans…' })}</span>
            </div>
          ) : recent.length === 0 ? (
            <div className="text-[13px] text-neutral-500 dark:text-neutral-400">
              {t('empty.plans', {
                defaultValue:
                  'No discovery plans yet. Run Discover to let Always-On scan this project.',
              })}
            </div>
          ) : (
            <ul className="space-y-3 text-[13px]">
              {recent.map((plan) => (
                <li key={plan.id} className="flex items-start gap-3">
                  <span className="text-xxs shrink-0 pt-0.5 font-mono text-neutral-500 dark:text-neutral-400">
                    {formatTime(plan.updatedAt)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-neutral-900 dark:text-neutral-100">{plan.title}</span>
                    {plan.summary ? (
                      <span className="ml-2 text-neutral-500 dark:text-neutral-400">· {plan.summary}</span>
                    ) : null}
                    <span className="text-xxs ml-2 text-neutral-500 dark:text-neutral-500">
                      {plan.status} · {plan.approvalMode}
                    </span>
                  </span>
                  {plan.executionSessionId ? (
                    <button
                      type="button"
                      onClick={() => onOpenDiscoverySession(plan.executionSessionId!)}
                      className="text-xxs inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
                    >
                      {t('actions.open', { defaultValue: 'Open' })}
                      <ChevronRight className="h-3 w-3" strokeWidth={1.75} />
                    </button>
                  ) : plan.status === 'ready' ? (
                    <button
                      type="button"
                      onClick={() => void handleExecutePlan(plan.id)}
                      disabled={executingId === plan.id}
                      className="text-xxs inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-neutral-900 px-2 text-white transition hover:opacity-90 disabled:opacity-50 dark:bg-neutral-50 dark:text-neutral-900"
                    >
                      {executingId === plan.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                      ) : (
                        <Sparkles className="h-3 w-3" strokeWidth={1.75} />
                      )}
                      {t('actions.run', { defaultValue: 'Run' })}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {plans.length > 0 ? (
          <p className="text-xxs text-center text-neutral-500 dark:text-neutral-500">
            {t('updatedAt', {
              relative: formatRelative(plans[0]?.updatedAt, t),
              defaultValue: `Updated ${formatRelative(plans[0]?.updatedAt, t)}`,
            })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
