/**
 * Provider connectivity & capability test dialog.
 *
 * UX contract (see plan in chat/2026-04-30):
 *   - Always tests the *currently-edited* provider draft, not whatever's on
 *     disk. The backend merges ******** placeholders against the on-disk
 *     copy so users who only changed baseUrl don't have to re-enter their key.
 *   - On overall=ok the footer shows a primary "Save config" button that
 *     calls back into the parent's save() — the same path Save & reload uses.
 *     This is what makes "test, then save" a one-click workflow.
 *   - On overall=error we deliberately do NOT offer to save: prevents users
 *     from clobbering a working config with a broken one.
 *   - All checks have backend timeouts; the dialog itself never spins forever.
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCopy,
  Info,
  Loader2,
  XCircle,
} from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import { authenticatedFetch } from '../../../utils/api';
import { cn } from '../../../lib/utils';

type CheckLevel = 'ok' | 'warning' | 'error' | 'skipped';

type Check = {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
  hint?: string;
  durationMs?: number;
};

type ProviderTestResult = {
  endpoint: string;
  overall: 'ok' | 'warning' | 'error';
  checks: Check[];
  startedAt: string;
  finishedAt: string;
};

type ProviderDraft = {
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

type Props = {
  /** Stable id from config.models.providers; used by backend to merge masked secrets. */
  providerId?: string;
  /** Optional model entry id; presence enables the toolUse check. */
  modelEntryId?: string;
  /** The user's in-memory draft. apiKey may be plaintext (new) or "********" (unchanged). */
  provider: ProviderDraft;
  /** Closes the dialog. */
  onClose: () => void;
  /** Called when the user clicks "Save config" after a passing test. */
  onSave?: () => Promise<void> | void;
  /** Whether there are unsaved edits at the form level (drives "save" button copy). */
  isDirty?: boolean;
};

// Reuse the same palette as Subsystem reload status so the dialog feels
// native to the rest of the EdgeClaw config tab.
function badgeClasses(level: CheckLevel): string {
  if (level === 'ok')      return 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300';
  if (level === 'warning') return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (level === 'error')   return 'border-destructive/40 bg-destructive/10 text-destructive';
  return 'border-border bg-muted text-muted-foreground';
}

function CheckIcon({ level }: { level: CheckLevel }) {
  if (level === 'ok')      return <CheckCircle2 className="h-4 w-4" />;
  if (level === 'warning') return <AlertCircle className="h-4 w-4" />;
  if (level === 'error')   return <XCircle className="h-4 w-4" />;
  return <Info className="h-4 w-4 opacity-50" />;
}

function overallHeader(overall: ProviderTestResult['overall'] | 'pending', running: boolean) {
  if (running)             return { icon: <Loader2 className="h-5 w-5 animate-spin" />, text: '正在测试…',  color: 'text-foreground' };
  if (overall === 'ok')    return { icon: <CheckCircle2 className="h-5 w-5" />,         text: '配置可用',     color: 'text-green-600 dark:text-green-400' };
  if (overall === 'warning') return { icon: <AlertCircle className="h-5 w-5" />,        text: '可用（有警告）', color: 'text-amber-600 dark:text-amber-400' };
  if (overall === 'error') return { icon: <XCircle className="h-5 w-5" />,              text: '配置异常',     color: 'text-destructive' };
  return { icon: <Info className="h-5 w-5" />, text: '准备测试…', color: 'text-muted-foreground' };
}

export default function ProviderTestDialog({
  providerId, modelEntryId, provider, onClose, onSave, isDirty,
}: Props) {
  const [running, setRunning] = useState(true);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  // The dialog kicks off the test as soon as it mounts. We capture the
  // request id with a ref so a quick close-then-reopen doesn't apply stale
  // results to a fresh dialog instance.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const id = ++requestIdRef.current;
    let aborted = false;

    (async () => {
      setRunning(true);
      setError(null);
      setResult(null);
      try {
        const response = await authenticatedFetch('/api/config/test-provider', {
          method: 'POST',
          body: JSON.stringify({ providerId, provider, modelEntryId }),
        });
        const data = await response.json();
        if (aborted || requestIdRef.current !== id) return;
        if (!response.ok) {
          throw new Error(data?.error || `HTTP ${response.status}`);
        }
        setResult(data as ProviderTestResult);
      } catch (caught) {
        if (aborted || requestIdRef.current !== id) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!aborted && requestIdRef.current === id) setRunning(false);
      }
    })();

    return () => { aborted = true; };
    // We intentionally only re-run when the inputs *identity* changes. The
    // parent should remount this component when the user picks a different
    // provider, not mutate props in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const headerInfo = overallHeader(result?.overall ?? 'pending', running);

  const canSave = !!result && result.overall !== 'error' && !!onSave;

  async function handleSave() {
    if (!onSave) return;
    setSaveError(null);
    setSaving(true);
    try {
      await onSave();
      setSaved(true);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  function handleCopy() {
    if (!result && !error) return;
    const payload = error
      ? { error, request: { providerId, modelEntryId } }
      : result;
    try {
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyHint('已复制到剪贴板');
      setTimeout(() => setCopyHint(null), 1800);
    } catch {
      setCopyHint('复制失败，请手动选取');
      setTimeout(() => setCopyHint(null), 1800);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="测试 Provider 配置"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-border bg-card text-foreground shadow-xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border p-4">
          <div className="min-w-0">
            <div className={cn('flex items-center gap-2 text-base font-semibold', headerInfo.color)}>
              {headerInfo.icon}
              <span>{headerInfo.text}</span>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {providerId ? <code className="rounded bg-muted px-1 py-0.5">{providerId}</code> : <span>新建 Provider</span>}
              {modelEntryId && <> · <code className="rounded bg-muted px-1 py-0.5">{modelEntryId}</code></>}
            </div>
            {result?.endpoint && (
              <div className="mt-1 truncate text-[11px] text-muted-foreground">
                <code>{result.endpoint}</code>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-2 overflow-auto p-4">
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              测试请求失败：{error}
            </div>
          )}

          {/* Render placeholder rows while running so the dialog doesn't
              shift around when results arrive. */}
          {(result?.checks ?? PLACEHOLDER_CHECKS).map((check) => (
            <CheckRow key={check.id} check={check} running={running && !result} />
          ))}

          {isDirty && result?.overall !== 'error' && !saved && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-300">
              提示：当前测试用的是表单里"未保存"的配置。点 "保存配置" 才会写入磁盘并热重载。
            </div>
          )}

          {saved && (
            <div className="mt-3 rounded-lg border border-green-500/30 bg-green-500/10 p-2 text-xs text-green-700 dark:text-green-300">
              已保存并热重载。
            </div>
          )}
          {saveError && (
            <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              保存失败：{saveError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-border p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            disabled={running || (!result && !error)}
            title="复制诊断 JSON"
          >
            <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" />
            {copyHint ?? '复制诊断'}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {saved ? '完成' : '关闭'}
            </Button>
            {canSave && !saved && (
              <Button size="sm" onClick={handleSave} disabled={saving || !isDirty}>
                {saving ? '保存中…' : isDirty ? '保存配置' : '已是最新'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const PLACEHOLDER_CHECKS: Check[] = [
  { id: 'network',   label: '网络连接', level: 'skipped', detail: '等待中…' },
  { id: 'apiCompat', label: 'API 兼容', level: 'skipped', detail: '等待中…' },
  { id: 'keyAuth',   label: 'Key 验证', level: 'skipped', detail: '等待中…' },
  { id: 'toolUse',   label: '模型能力', level: 'skipped', detail: '等待中…' },
  { id: 'keyFormat', label: 'Key 格式', level: 'skipped', detail: '等待中…' },
];

function CheckRow({ check, running }: { check: Check; running: boolean }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-3 py-2 text-sm', badgeClasses(check.level))}>
      <div className="mt-0.5">
        {running ? <Loader2 className="h-4 w-4 animate-spin opacity-70" /> : <CheckIcon level={check.level} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{check.label}</span>
          {typeof check.durationMs === 'number' && check.durationMs > 0 && (
            <span className="text-[10px] opacity-60">{check.durationMs}ms</span>
          )}
        </div>
        <div className="mt-0.5 break-words text-xs opacity-90">{check.detail}</div>
        {check.hint && (
          <div className="mt-1 break-words text-[11px] italic opacity-75">提示：{check.hint}</div>
        )}
      </div>
    </div>
  );
}
