import { CLAUDE_MODELS } from '../../../../shared/modelConstants';
import type { Project, ProjectSession } from '../../../types/app';
import type { ClaudeSettings, PermissionMode } from '../types/types';
import { getClaudeSettings, safeLocalStorage } from './chatStorage';

type StartClaudeSessionOptions = {
  sendMessage: (message: unknown) => void;
  selectedProject: Project;
  command: string;
  sessionId?: string | null;
  temporarySessionId?: string;
  permissionMode?: PermissionMode | string;
  claudeModel?: string;
  sessionSummary?: string | null;
  toolsSettings?: ClaudeSettings;
  images?: unknown[];
  alwaysOnPlanId?: string;
  alwaysOnExecutionToken?: string;
  executionWorkspacePath?: string;
};

const VALID_PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]);

export const isTemporarySessionId = (sessionId: string | null | undefined) =>
  Boolean(sessionId && sessionId.startsWith('new-session-'));

export function createTemporarySessionId(): string {
  return `new-session-${Date.now()}`;
}

export function getNotificationSessionSummary(
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null {
  const sessionSummary =
    selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80
      ? `${normalized.slice(0, 77)}...`
      : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80
    ? `${normalizedFallback.slice(0, 77)}...`
    : normalizedFallback;
}

export function getStoredClaudePermissionMode(
  selectedSession: ProjectSession | null,
): PermissionMode {
  if (!selectedSession?.id) {
    return 'default';
  }

  const stored = safeLocalStorage.getItem(`permissionMode-${selectedSession.id}`);
  if (stored && VALID_PERMISSION_MODES.has(stored as PermissionMode)) {
    return stored as PermissionMode;
  }

  return 'default';
}

export function getSelectedProjectPath(selectedProject: Project): string {
  return selectedProject.fullPath || selectedProject.path || '';
}

export function startClaudeSessionCommand({
  sendMessage,
  selectedProject,
  command,
  sessionId,
  temporarySessionId,
  permissionMode = 'default',
  claudeModel,
  sessionSummary,
  toolsSettings = getClaudeSettings(),
  images,
  alwaysOnPlanId,
  alwaysOnExecutionToken,
  executionWorkspacePath,
}: StartClaudeSessionOptions): string {
  const sessionToActivate =
    sessionId || temporarySessionId || createTemporarySessionId();
  const resolvedProjectPath = executionWorkspacePath || getSelectedProjectPath(selectedProject);

  safeLocalStorage.setItem('selected-provider', 'claude');

  sendMessage({
    type: 'claude-command',
    command,
    options: {
      ...(sessionId ? { sessionId, resume: true } : {}),
      projectPath: resolvedProjectPath,
      cwd: resolvedProjectPath,
      toolsSettings,
      permissionMode,
      model: claudeModel || safeLocalStorage.getItem('claude-model') || CLAUDE_MODELS.DEFAULT,
      sessionSummary,
      ...(alwaysOnPlanId ? { alwaysOnPlanId } : {}),
      ...(alwaysOnExecutionToken ? { alwaysOnExecutionToken } : {}),
      ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
    },
  });

  return sessionToActivate;
}
