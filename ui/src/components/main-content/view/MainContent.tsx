import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChatInterfaceV2 from '../../chat-v2/ChatInterfaceV2';
import AlwaysOnV2 from '../../main-content-v2/AlwaysOnV2';
import FilesV2 from '../../main-content-v2/FilesV2';
import ShellV2 from '../../main-content-v2/ShellV2';
import GitV2 from '../../main-content-v2/GitV2';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import DashboardV2 from '../../main-content-v2/DashboardV2';
import TasksV2 from '../../main-content-v2/TasksV2';
import { cn } from '../../../lib/utils.js';
import {
  getStoredClaudePermissionMode,
  startClaudeSessionCommand,
} from '../../chat/utils/claudeSessionLauncher';
import { getClaudeSettings } from '../../chat/utils/chatStorage';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import type { CodeEditorDiffInfo } from '../../code-editor/types/types';
import type {
  AlwaysOnSessionTarget,
  CronJobOverview,
  ExecuteDiscoveryPlanResponse,
  Project,
  ProjectDiscoveryContextResponse,
  ProjectDiscoveryPlansResponse,
  ProjectSession,
} from '../../../types/app';
import { api } from '../../../utils/api';
import {
  buildAlwaysOnDiscoveryPrompt,
  normalizeDiscoveryPromptLanguage,
} from '../../../utils/alwaysOnDiscoveryPrompt';
import {
  clearAlwaysOnPresence,
  sendAlwaysOnPresence,
} from '../../../utils/alwaysOnPresence';
import {
  createDiscoveryRequestDedupeStore,
  shouldProcessDiscoveryRequest,
} from '../../../utils/alwaysOnDiscoveryRequestDedupe';
import { findAlwaysOnProjectByRoot } from '../../../utils/alwaysOnProjectMatching';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import MemoryPanel from './memory/MemoryPanel';
import SkillsV2 from '../../main-content-v2/SkillsV2';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

type PendingDiscoveryExecution = {
  projectName: string;
  planId: string;
  executionToken: string;
};

type MainContentToast = { kind: 'error' | 'info'; text: string } | null;

const AUTO_EXECUTION_POLL_INTERVAL_MS = 15000;
const FILES_CHAT_DEFAULT_WIDTH = 460;
const FILES_CHAT_MIN_WIDTH = 320;
const FILES_TREE_MIN_WIDTH = 280;

async function readJsonPayload<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

function buildAlwaysOnExecutionToolsSettings() {
  const settings = getClaudeSettings();
  const disallowedTools = Array.isArray(settings.disallowedTools)
    ? [...settings.disallowedTools]
    : [];

  if (!disallowedTools.includes('EnterPlanMode')) {
    disallowedTools.push('EnterPlanMode');
  }

  return {
    ...settings,
    disallowedTools,
  };
}

function buildAlwaysOnDiscoveryToolsSettings() {
  const settings = getClaudeSettings();
  const disallowedTools = Array.isArray(settings.disallowedTools)
    ? [...settings.disallowedTools]
    : [];

  if (!disallowedTools.includes('CronCreate')) {
    disallowedTools.push('CronCreate');
  }

  return {
    ...settings,
    disallowedTools,
  };
}

function MainContent({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onStartNewSession,
  onSelectSession,
  onShowSettings,
  externalMessageUpdate,
}: MainContentProps) {
  const { i18n } = useTranslation();
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;
  const discoveryPromptLanguage = normalizeDiscoveryPromptLanguage(i18n.language);

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const pendingDiscoveryExecutionsRef = useRef<Map<string, PendingDiscoveryExecution>>(new Map());
  const discoveryExecutionsBySessionRef = useRef<Map<string, PendingDiscoveryExecution>>(new Map());
  const autoLaunchInFlightRef = useRef<Set<string>>(new Set());
  const processedDiscoveryRequestsRef = useRef(createDiscoveryRequestDedupeStore());
  const lastUserMsgAtRef = useRef<string | null>(null);
  const [toast, setToast] = useState<MainContentToast>(null);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  useEffect(() => {
    const selectedProjectName = selectedProject?.name;
    const currentProjectName = currentProject?.name;

    if (selectedProject && selectedProjectName !== currentProjectName) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.name, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  const refreshProjectsSilently = useCallback(() => {
    if (window.refreshProjects) {
      void window.refreshProjects();
    }
  }, []);

  const trackedSendMessage = useCallback((message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      ['claude-command', 'cursor-command', 'codex-command', 'gemini-command'].includes(
        String((message as { type?: unknown }).type),
      )
    ) {
      lastUserMsgAtRef.current = new Date().toISOString();
    }
    sendMessage(message);
  }, [sendMessage]);

  const publishPresence = useCallback(() => {
    const alwaysOnProjects = projects.filter(project =>
      project.alwaysOn?.discovery?.triggerEnabled === true
    );
    if (!selectedProject && alwaysOnProjects.length === 0) {
      return;
    }
    sendAlwaysOnPresence(sendMessage, {
      selectedProject,
      alwaysOnProjects,
      processingSessionIds: Array.from(processingSessions),
      lastUserMsgAt: lastUserMsgAtRef.current,
    });
  }, [processingSessions, projects, selectedProject, sendMessage]);

  useEffect(() => {
    const hasAlwaysOnProject = projects.some(project =>
      project.alwaysOn?.discovery?.triggerEnabled === true
    );
    if (!ws || (!selectedProject && !hasAlwaysOnProject)) {
      return undefined;
    }

    publishPresence();
    const timer = window.setInterval(publishPresence, 30000);
    return () => {
      window.clearInterval(timer);
      clearAlwaysOnPresence(sendMessage);
    };
  }, [projects, publishPresence, selectedProject, sendMessage, ws]);

  const updateDiscoveryExecution = useCallback(async (
    projectName: string,
    planId: string,
    body: Record<string, unknown>,
  ) => {
    const response = await api.updateProjectDiscoveryPlanExecution(projectName, planId, body);
    if (!response.ok) {
      const payload = await readJsonPayload<{ error?: string }>(response);
      throw new Error(payload?.error || 'Failed to update discovery plan execution');
    }
  }, []);

  const launchQueuedDiscoveryPlanExecution = useCallback(async (
    payload: ExecuteDiscoveryPlanResponse,
  ) => {
    if (!selectedProject) {
      return;
    }

    const planId = payload?.plan?.id;
    if (!planId) {
      throw new Error('Missing discovery plan id in execution payload');
    }

    pendingDiscoveryExecutionsRef.current.set(payload.executionToken, {
      projectName: selectedProject.name,
      planId,
      executionToken: payload.executionToken,
    });

    startClaudeSessionCommand({
      sendMessage: trackedSendMessage,
      selectedProject,
      command: payload.command,
      permissionMode: 'default',
      sessionSummary: payload.sessionSummary,
      toolsSettings: buildAlwaysOnExecutionToolsSettings(),
      alwaysOnPlanId: planId,
      alwaysOnExecutionToken: payload.executionToken,
    });

    refreshProjectsSilently();
  }, [refreshProjectsSilently, selectedProject, trackedSendMessage]);

  const handleExecuteDiscoveryPlan = useCallback(async (
    planId: string,
    source: 'manual' | 'auto' = 'manual',
  ) => {
    if (!selectedProject) {
      return;
    }

    autoLaunchInFlightRef.current.add(planId);

    const response = await api.executeProjectDiscoveryPlan(selectedProject.name, planId, { source });
    const payload = await readJsonPayload<ExecuteDiscoveryPlanResponse & { error?: string }>(response);
    if (!response.ok || !payload) {
      autoLaunchInFlightRef.current.delete(planId);
      throw new Error(payload?.error || 'Failed to queue discovery plan execution');
    }

    await launchQueuedDiscoveryPlanExecution(payload);
  }, [launchQueuedDiscoveryPlanExecution, selectedProject]);

  const flashToast = useCallback((toastValue: MainContentToast, ms = 2400) => {
    setToast(toastValue);
    if (toastValue) {
      window.setTimeout(() => setToast(null), ms);
    }
  }, []);

  const getProjectSessions = useCallback((project: Project): ProjectSession[] => [
    ...(project.sessions ?? []),
    ...(project.codexSessions ?? []),
    ...(project.cursorSessions ?? []),
    ...(project.geminiSessions ?? []),
  ], []);

  const findSessionInProject = useCallback((project: Project, sessionId: string) => (
    getProjectSessions(project).find((session) => session.id === sessionId)
  ), [getProjectSessions]);

  const loadClaudeSession = useCallback(async (projectName: string, sessionId: string) => {
    const response = await api.sessions(projectName, Number.MAX_SAFE_INTEGER, 0);
    if (!response.ok) {
      return null;
    }
    const payload = await readJsonPayload<{ sessions?: ProjectSession[] }>(response);
    return payload?.sessions?.find((session) => session.id === sessionId) ?? null;
  }, []);

  const handleOpenAlwaysOnSession = useCallback(async (target: AlwaysOnSessionTarget) => {
    if (!selectedProject) {
      return;
    }

    const missingMessage = i18n.t('alwaysOn:sessionMissing', {
      defaultValue: 'This chat record no longer exists.',
    });

    if (target.kind === 'origin') {
      const existingSession =
        findSessionInProject(selectedProject, target.sessionId) ??
        await loadClaudeSession(selectedProject.name, target.sessionId);

      if (!existingSession) {
        flashToast({ kind: 'error', text: missingMessage });
        return;
      }

      const fallbackSession: ProjectSession = {
        ...existingSession,
        __provider: existingSession.__provider ?? 'claude',
        __projectName: selectedProject.name,
      };

      setActiveTab('chat');
      if (onSelectSession) {
        onSelectSession(selectedProject, target.sessionId, fallbackSession);
        return;
      }
      onNavigateToSession(target.sessionId);
      return;
    }

    const existingSession =
      findSessionInProject(selectedProject, target.sessionId) ??
      await loadClaudeSession(selectedProject.name, target.sessionId);

    if (!existingSession) {
      flashToast({ kind: 'error', text: missingMessage });
      return;
    }

    const fallbackSession: ProjectSession = {
      ...existingSession,
      id: target.sessionId,
      title: target.title || existingSession.title || existingSession.summary || target.summary,
      summary: target.summary || existingSession.summary || existingSession.title || target.title,
      lastActivity: target.lastActivity || existingSession.lastActivity,
      sessionKind: 'background_task',
      parentSessionId: target.parentSessionId,
      relativeTranscriptPath: target.relativeTranscriptPath,
      transcriptKey: target.transcriptKey || existingSession.transcriptKey,
      taskId: target.taskId || existingSession.taskId,
      taskStatus: target.taskStatus || existingSession.taskStatus,
      outputFile: target.outputFile || existingSession.outputFile,
      isReadOnly: true,
      __provider: 'claude',
      __projectName: selectedProject.name,
    };

    setActiveTab('chat');
    if (onSelectSession) {
      onSelectSession(selectedProject, target.sessionId, fallbackSession);
      return;
    }
    onNavigateToSession(target.sessionId);
  }, [
    findSessionInProject,
    flashToast,
    i18n,
    loadClaudeSession,
    onNavigateToSession,
    onSelectSession,
    selectedProject,
    setActiveTab,
  ]);

  const handleOpenCronSession = useCallback((job: CronJobOverview) => {
    const latestRun = job.latestRun;
    if (
      !latestRun?.sessionId ||
      !latestRun.parentSessionId ||
      !latestRun.relativeTranscriptPath
    ) {
      return;
    }

    void handleOpenAlwaysOnSession({
      kind: 'background',
      sessionId: latestRun.sessionId,
      parentSessionId: latestRun.parentSessionId,
      relativeTranscriptPath: latestRun.relativeTranscriptPath,
      title: latestRun.summary || job.prompt || job.cron,
      summary: latestRun.summary || job.prompt || job.cron,
      lastActivity: latestRun.lastActivity,
      transcriptKey: latestRun.transcriptKey || job.transcriptKey,
      taskId: latestRun.taskId,
      taskStatus: job.status,
      outputFile: latestRun.outputFile,
    });
  }, [handleOpenAlwaysOnSession]);

  useEffect(() => {
    const message = latestMessage as {
      kind?: string;
      sessionId?: string;
      newSessionId?: string;
      content?: string;
      exitCode?: number;
      aborted?: boolean;
      alwaysOnPlanId?: string | null;
      alwaysOnExecutionToken?: string | null;
    } | null;

    if (!message || typeof message !== 'object') {
      return;
    }

    const executionToken = typeof message.alwaysOnExecutionToken === 'string'
      ? message.alwaysOnExecutionToken
      : '';
    const explicitPlanId = typeof message.alwaysOnPlanId === 'string'
      ? message.alwaysOnPlanId
      : '';

    if (message.kind === 'session_created' && executionToken) {
      const pending = pendingDiscoveryExecutionsRef.current.get(executionToken);
      const newSessionId = typeof message.newSessionId === 'string'
        ? message.newSessionId
        : '';
      if (!pending || !newSessionId) {
        return;
      }

      pendingDiscoveryExecutionsRef.current.delete(executionToken);
      discoveryExecutionsBySessionRef.current.set(newSessionId, pending);
      autoLaunchInFlightRef.current.delete(pending.planId);

      void updateDiscoveryExecution(pending.projectName, pending.planId, {
        executionSessionId: newSessionId,
        status: 'running',
        executionStartedAt: new Date().toISOString(),
        executionToken: pending.executionToken,
      }).finally(() => {
        refreshProjectsSilently();
      });
      return;
    }

    if (message.kind !== 'complete' && message.kind !== 'error') {
      return;
    }

    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
    const trackedExecution = sessionId
      ? discoveryExecutionsBySessionRef.current.get(sessionId)
      : null;
    const fallbackTrackedExecution = explicitPlanId && selectedProject
      ? {
          projectName: selectedProject.name,
          planId: explicitPlanId,
          executionToken,
        }
      : null;
    const execution = trackedExecution || fallbackTrackedExecution;

    if (!execution) {
      return;
    }

    if (sessionId) {
      discoveryExecutionsBySessionRef.current.delete(sessionId);
    }
    autoLaunchInFlightRef.current.delete(execution.planId);

    const status = message.kind === 'error'
      ? 'failed'
      : (message.aborted || (typeof message.exitCode === 'number' && message.exitCode !== 0))
        ? 'failed'
        : 'completed';

    void updateDiscoveryExecution(execution.projectName, execution.planId, {
      executionSessionId: sessionId || undefined,
      status,
      executionLastActivityAt: new Date().toISOString(),
      latestSummary: typeof message.content === 'string' ? message.content : undefined,
      executionToken: execution.executionToken,
    }).finally(() => {
      refreshProjectsSilently();
    });
  }, [latestMessage, refreshProjectsSilently, selectedProject, updateDiscoveryExecution]);

  const pollAutoExecutablePlans = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    const response = await api.projectDiscoveryPlans(selectedProject.name);
    const payload = await readJsonPayload<ProjectDiscoveryPlansResponse & { error?: string }>(response);
    if (!response.ok || !payload) {
      return;
    }

    const autoReadyPlans = Array.isArray(payload.plans)
      ? payload.plans.filter((plan) =>
          plan.approvalMode === 'auto' &&
          plan.status === 'ready' &&
          !plan.executionSessionId &&
          !autoLaunchInFlightRef.current.has(plan.id),
        )
      : [];

    for (const plan of autoReadyPlans) {
      try {
        await handleExecuteDiscoveryPlan(plan.id, 'auto');
      } catch {
        autoLaunchInFlightRef.current.delete(plan.id);
      }
    }
  }, [handleExecuteDiscoveryPlan, selectedProject]);

  useEffect(() => {
    if (!selectedProject) {
      return undefined;
    }

    void pollAutoExecutablePlans();
    const timer = window.setInterval(() => {
      void pollAutoExecutablePlans();
    }, AUTO_EXECUTION_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [pollAutoExecutablePlans, selectedProject]);

  const handleStartDiscoverySession = useCallback(async (targetProject = selectedProject) => {
    if (!targetProject) {
      return;
    }

    onStartNewSession(targetProject);
    let discoveryContext: ProjectDiscoveryContextResponse = {
      generatedAt: new Date().toISOString(),
      lookbackDays: 7,
      workspace: {
        projectName: targetProject.name,
        projectRoot: targetProject.fullPath || targetProject.path || targetProject.name,
        signals: [],
      },
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    };

    try {
      const response = await api.projectDiscoveryContext(targetProject.name);
      const payload = await readJsonPayload<ProjectDiscoveryContextResponse & { error?: string }>(response);
      if (response.ok && payload) {
        discoveryContext = payload;
      }
    } catch {
      // Fall back to a minimal context payload if the API call fails.
    }

    const discoveryPrompt = buildAlwaysOnDiscoveryPrompt(
      targetProject,
      discoveryContext,
      discoveryPromptLanguage,
    );
    const pendingSessionId = startClaudeSessionCommand({
      sendMessage: trackedSendMessage,
      selectedProject: targetProject,
      command: discoveryPrompt,
      permissionMode: getStoredClaudePermissionMode(selectedSession),
      sessionSummary: `Always-On discovery: ${targetProject.displayName || targetProject.name}`,
      toolsSettings: buildAlwaysOnDiscoveryToolsSettings(),
    });

    onSessionActive?.(pendingSessionId);
  }, [
    onSessionActive,
    onStartNewSession,
    discoveryPromptLanguage,
    selectedProject,
    selectedSession,
    trackedSendMessage,
  ]);

  useEffect(() => {
    const message = latestMessage as {
      type?: string;
      requestId?: string;
      projectRoot?: string;
    } | null;
    if (message?.type !== 'always-on-auto-discovery-start') {
      return;
    }

    if (!message.requestId) {
      sendMessage({
        type: 'always-on-auto-discovery-complete',
        projectRoot: message.projectRoot,
        status: 'failed',
      });
      return;
    }
    if (!shouldProcessDiscoveryRequest(processedDiscoveryRequestsRef.current, message.requestId)) {
      return;
    }

    const targetProject = findAlwaysOnProjectByRoot(projects, message.projectRoot);
    if (!targetProject) {
      sendMessage({
        type: 'always-on-auto-discovery-complete',
        projectRoot: message.projectRoot,
        status: 'failed',
      });
      return;
    }

    void handleStartDiscoverySession(targetProject)
      .then(() => {
        sendMessage({
          type: 'always-on-auto-discovery-complete',
          projectRoot: message.projectRoot,
          status: 'started',
        });
      })
      .catch(() => {
        sendMessage({
          type: 'always-on-auto-discovery-complete',
          projectRoot: message.projectRoot,
          status: 'failed',
        });
      });
  }, [handleStartDiscoverySession, latestMessage, projects, sendMessage]);

  if (isLoading) {
    return (
      <MainContentStateView
        mode="loading"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />
    );
  }

  if (!selectedProject) {
    return (
      <MainContentStateView
        mode="empty"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />
    );
  }

  return (
    <div className="relative flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SplitBody
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          shouldShowTasksTab={shouldShowTasksTab}
          tasksEnabled={tasksEnabled}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={trackedSendMessage}
          latestMessage={latestMessage}
          handleFileOpen={handleFileOpen}
          onInputFocusChange={onInputFocusChange}
          onSessionActive={onSessionActive}
          onSessionInactive={onSessionInactive}
          onSessionProcessing={onSessionProcessing}
          onSessionNotProcessing={onSessionNotProcessing}
          processingSessions={processingSessions}
          onReplaceTemporarySession={onReplaceTemporarySession}
          onNavigateToSession={onNavigateToSession}
          onShowSettings={onShowSettings}
          externalMessageUpdate={externalMessageUpdate}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          autoScrollToBottom={autoScrollToBottom}
          sendByCtrlEnter={sendByCtrlEnter}
          launchQueuedDiscoveryPlanExecution={launchQueuedDiscoveryPlanExecution}
          handleStartDiscoverySession={handleStartDiscoverySession}
          handleExecuteDiscoveryPlan={handleExecuteDiscoveryPlan}
          handleOpenCronSession={handleOpenCronSession}
          handleOpenAlwaysOnSession={handleOpenAlwaysOnSession}
          editorExpanded={editorExpanded}
        />

        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={selectedProject.path}
          fillSpace={activeTab === 'files'}
        />
      </div>
      {toast ? (
        <div
          className={cn(
            'pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md px-3 py-1.5 text-[12px] shadow-lg',
            toast.kind === 'error' && 'bg-red-600 text-white',
            toast.kind === 'info' && 'bg-neutral-800 text-white',
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

// V2 split body: the Agent surface owns both the new-session welcome state
// and existing transcripts. Files can pair with Agent in split view; focused
// tools such as Always-On, Dashboard, Tasks, and Memory render full-screen.
type SplitBodyProps = {
  selectedProject: Project;
  selectedSession: any;
  activeTab: string;
  shouldShowTasksTab: boolean;
  tasksEnabled: boolean;
  setActiveTab: (tab: any) => void;
  ws: any;
  sendMessage: any;
  latestMessage: any;
  handleFileOpen: (filePath: string, diffInfo?: CodeEditorDiffInfo | null) => void;
  onInputFocusChange: any;
  onSessionActive: any;
  onSessionInactive: any;
  onSessionProcessing: any;
  onSessionNotProcessing: any;
  processingSessions: any;
  onReplaceTemporarySession: any;
  onNavigateToSession: (sessionId: string) => void;
  onShowSettings: any;
  externalMessageUpdate: any;
  autoExpandTools: any;
  showRawParameters: any;
  showThinking: any;
  autoScrollToBottom: any;
  sendByCtrlEnter: any;
  launchQueuedDiscoveryPlanExecution: any;
  handleStartDiscoverySession: any;
  handleExecuteDiscoveryPlan: any;
  handleOpenCronSession: (job: CronJobOverview) => void;
  handleOpenAlwaysOnSession: (target: AlwaysOnSessionTarget) => void | Promise<void>;
  editorExpanded: boolean;
};

function SplitBody(props: SplitBodyProps) {
  const {
    selectedProject,
    selectedSession,
    activeTab,
    shouldShowTasksTab,
    tasksEnabled,
    setActiveTab,
    ws,
    sendMessage,
    latestMessage,
    handleFileOpen,
    onInputFocusChange,
    onSessionActive,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    processingSessions,
    onReplaceTemporarySession,
    onNavigateToSession,
    onShowSettings,
    externalMessageUpdate,
    autoExpandTools,
    showRawParameters,
    showThinking,
    autoScrollToBottom,
    sendByCtrlEnter,
    launchQueuedDiscoveryPlanExecution,
    handleStartDiscoverySession,
    handleExecuteDiscoveryPlan,
    handleOpenCronSession,
    handleOpenAlwaysOnSession,
    editorExpanded,
  } = props;

  // Render-mode taxonomy:
  //   - 'chat':    Agent surface. No session shows the welcome composer;
  //                existing sessions show the transcript.
  //   - 'split':   Files tab only. Chat on the left, file tree/editor on right.
  //   - 'tool':    Always-On / Dashboard / Memory / Tasks / Shell / Git /
  //                plugin tabs. Tool fills the whole main area, no chat
  //                alongside — matches the legacy single-pane layout users
  //                expect when they tab into a focused tool.
  //
  // Note: Shell + Git aren't surfaced in the V2 top tab bar (see TABS in
  // MainAreaV2.tsx) but plugins / programmatic activeTab values still hit
  // those code paths, so we keep them here as full-screen tool views.
  const isPlugin = typeof activeTab === 'string' && activeTab.startsWith('plugin:');
  const fullScreenToolTabs = new Set([
    'shell',
    'git',
    'always-on',
    'dashboard',
    'memory',
    'skills',
    'tasks',
  ]);
  const isFullScreenTool = fullScreenToolTabs.has(activeTab) || isPlugin;
  // Tasks tab is conditional — fall back to chat if the project hasn't
  // enabled it yet so we don't render a black hole.
  const renderTasksAsTool = activeTab === 'tasks' && shouldShowTasksTab;
  const isFiles = activeTab === 'files';
  const filesSplitContainerRef = useRef<HTMLDivElement | null>(null);
  const [filesChatWidth, setFilesChatWidth] = useState(FILES_CHAT_DEFAULT_WIDTH);
  const [isFilesSplitResizing, setIsFilesSplitResizing] = useState(false);

  const clampFilesChatWidth = useCallback((width: number, containerWidth: number) => {
    const maxWidth = Math.max(FILES_CHAT_MIN_WIDTH, containerWidth - FILES_TREE_MIN_WIDTH);
    return Math.min(Math.max(width, FILES_CHAT_MIN_WIDTH), maxWidth);
  }, []);

  const handleFilesSplitResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!isFiles) {
      return;
    }

    setIsFilesSplitResizing(true);
    event.preventDefault();
  }, [isFiles]);

  useEffect(() => {
    if (!isFilesSplitResizing) {
      return undefined;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const container = filesSplitContainerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      setFilesChatWidth(clampFilesChatWidth(event.clientX - rect.left, rect.width));
    };

    const handleMouseUp = () => {
      setIsFilesSplitResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [clampFilesChatWidth, isFilesSplitResizing]);

  const renderTool = () => {
    if (activeTab === 'shell') {
      return (
        <ShellV2
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          isActive
        />
      );
    }
    if (activeTab === 'git') {
      return <GitV2 selectedProject={selectedProject} onFileOpen={handleFileOpen} />;
    }
    if (activeTab === 'always-on') {
      return (
        <AlwaysOnV2
          selectedProject={selectedProject}
          onStartDiscoverySession={handleStartDiscoverySession}
          onExecuteDiscoveryPlan={handleExecuteDiscoveryPlan}
          onOpenCronSession={handleOpenCronSession}
          onOpenSession={handleOpenAlwaysOnSession}
        />
      );
    }
    if (activeTab === 'dashboard') return <DashboardV2 projectFilter={selectedProject?.name} />;
    if (activeTab === 'memory') return <MemoryPanel selectedProject={selectedProject} />;
    if (activeTab === 'skills') return <SkillsV2 selectedProject={selectedProject} />;
    if (renderTasksAsTool) return <TasksV2 isVisible />;
    if (isPlugin) {
      return (
        <PluginTabContent
          pluginName={activeTab.replace('plugin:', '')}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
        />
      );
    }
    return null;
  };

  // Full-screen tools branch out before the chat surface so we don't
  // mount ChatInterfaceV2 at all on those tabs — that drops the websocket
  // listeners + composer from the tree, which is what makes Memory's iframe
  // and the dashboards feel "back to legacy" full-screen.
  if (isFullScreenTool && (activeTab !== 'tasks' || shouldShowTasksTab)) {
    return (
      <div className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden', editorExpanded && 'hidden')}>
        <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
          {renderTool()}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={isFiles ? filesSplitContainerRef : undefined}
      className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden', editorExpanded && 'hidden')}
    >
      {/* Agent surface. Left half when split (files), full width otherwise.
          With no selected session, ChatInterfaceV2 shows the welcome composer. */}
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-col',
          isFiles ? 'flex-shrink-0' : 'flex-1',
        )}
        style={isFiles
          ? {
              minWidth: `${FILES_CHAT_MIN_WIDTH}px`,
              width: `min(${filesChatWidth}px, calc(100% - ${FILES_TREE_MIN_WIDTH}px))`,
            }
          : undefined}
      >
        <ErrorBoundary showDetails>
          <ChatInterfaceV2
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            ws={ws}
            sendMessage={sendMessage}
            latestMessage={latestMessage}
            onFileOpen={handleFileOpen}
            onInputFocusChange={onInputFocusChange}
            onSessionActive={onSessionActive}
            onSessionInactive={onSessionInactive}
            onSessionProcessing={onSessionProcessing}
            onSessionNotProcessing={onSessionNotProcessing}
            processingSessions={processingSessions}
            onReplaceTemporarySession={onReplaceTemporarySession}
            onNavigateToSession={onNavigateToSession}
            onShowSettings={onShowSettings}
            onLaunchAlwaysOnPlanExecution={launchQueuedDiscoveryPlanExecution}
            autoExpandTools={autoExpandTools}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            autoScrollToBottom={autoScrollToBottom}
            sendByCtrlEnter={sendByCtrlEnter}
            externalMessageUpdate={externalMessageUpdate}
            onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
            forceWelcome={false}
            onExitWelcome={() => setActiveTab('chat')}
          />
        </ErrorBoundary>
      </div>

      {/* Right half — only mounted when the user is on Files (chat-paired
          file tree + editor). All other tools render in the full-screen
          branch above. */}
      {isFiles ? (
        <>
          <div
            onMouseDown={handleFilesSplitResizeStart}
            className="group relative z-10 w-px flex-shrink-0 cursor-col-resize bg-neutral-200 transition-colors hover:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600"
            title="Drag to resize"
          >
            <div className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2" />
            <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-neutral-600" />
          </div>
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            style={{ minWidth: `${FILES_TREE_MIN_WIDTH}px` }}
          >
            <FilesV2
              selectedProject={selectedProject}
              onFileOpen={handleFileOpen}
              onClose={() => setActiveTab('chat')}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

export default React.memo(MainContent);
