import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  ExecuteDiscoveryPlanResponse,
  Project,
  ProjectDiscoveryContextResponse,
  ProjectDiscoveryPlansResponse,
} from '../../../types/app';
import { api } from '../../../utils/api';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import MemoryPanel from './memory/MemoryPanel';

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
};

const AUTO_EXECUTION_POLL_INTERVAL_MS = 15000;
const FILES_CHAT_DEFAULT_WIDTH = 460;
const FILES_CHAT_MIN_WIDTH = 320;
const FILES_TREE_MIN_WIDTH = 280;

function getClaudeProjectStorePath(project: Project): string {
  const projectPath = project.fullPath || project.path || '';
  const unixHomeMatch = projectPath.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  if (unixHomeMatch?.[1]) {
    return `${unixHomeMatch[1]}/.claude/projects/${project.name}`;
  }

  const windowsHomeMatch = projectPath.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  if (windowsHomeMatch?.[1]) {
    return `${windowsHomeMatch[1]}\\.claude\\projects\\${project.name}`;
  }

  return `~/.claude/projects/${project.name}`;
}

function buildAlwaysOnDiscoveryPrompt(
  project: Project,
  context: ProjectDiscoveryContextResponse,
): string {
  const workspacePath = project.fullPath || project.path || project.name;
  const claudeProjectStorePath = getClaudeProjectStorePath(project);
  const displayName = project.displayName || project.name;

  return [
    `Always-On discovery planning for project "${displayName}".`,
    '',
    'Your job is discovery only.',
    'Inspect the provided context, decide whether there are worthwhile follow-up tasks, and persist up to 3 structured discovery plans.',
    '',
    'Requirements:',
    `1. Inspect the current workspace at \`${workspacePath}\`.`,
    `2. Use the project store at \`${claudeProjectStorePath}\` as supporting context if needed.`,
    '3. Read the structured discovery context below instead of inventing your own context window.',
    '4. If there is no worthwhile follow-up work, explain why and stop without saving any plans.',
    '5. If there is worthwhile work, use `AlwaysOnDiscoveryPlan` to persist up to 3 plans.',
    '6. Every saved plan must include these markdown sections exactly:',
    '   - `## Context`',
    '   - `## Signals Reviewed`',
    '   - `## Proposed Work`',
    '   - `## Execution Steps`',
    '   - `## Verification`',
    '   - `## Approval And Execution`',
    '7. Use `approvalMode: "manual"` unless the work is clearly safe and suitable for auto-execution.',
    '8. Do not call `CronCreate`, do not execute the work now, and do not start background tasks.',
    '9. In your final reply, summarize what you reviewed and which discovery plan IDs were created or updated.',
    '',
    'Structured discovery context:',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
  ].join('\n');
}

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
  onShowSettings,
  externalMessageUpdate,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const pendingDiscoveryExecutionsRef = useRef<Map<string, PendingDiscoveryExecution>>(new Map());
  const discoveryExecutionsBySessionRef = useRef<Map<string, PendingDiscoveryExecution>>(new Map());
  const autoLaunchInFlightRef = useRef<Set<string>>(new Set());
  const handledAutoDiscoveryRequestsRef = useRef<Set<string>>(new Set());

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
    });

    startClaudeSessionCommand({
      sendMessage,
      selectedProject,
      command: payload.command,
      permissionMode: 'default',
      sessionSummary: payload.sessionSummary,
      toolsSettings: buildAlwaysOnExecutionToolsSettings(),
      alwaysOnPlanId: planId,
      alwaysOnExecutionToken: payload.executionToken,
    });

    refreshProjectsSilently();
  }, [refreshProjectsSilently, selectedProject, sendMessage]);

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

  const handleStartDiscoverySession = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    onStartNewSession(selectedProject);
    let discoveryContext: ProjectDiscoveryContextResponse = {
      generatedAt: new Date().toISOString(),
      lookbackDays: 7,
      workspace: {
        projectName: selectedProject.name,
        projectRoot: selectedProject.fullPath || selectedProject.path || selectedProject.name,
        signals: [],
      },
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    };

    try {
      const response = await api.projectDiscoveryContext(selectedProject.name);
      const payload = await readJsonPayload<ProjectDiscoveryContextResponse & { error?: string }>(response);
      if (response.ok && payload) {
        discoveryContext = payload;
      }
    } catch {
      // Fall back to a minimal context payload if the API call fails.
    }

    const discoveryPrompt = buildAlwaysOnDiscoveryPrompt(selectedProject, discoveryContext);
    const pendingSessionId = startClaudeSessionCommand({
      sendMessage,
      selectedProject,
      command: discoveryPrompt,
      permissionMode: getStoredClaudePermissionMode(selectedSession),
      sessionSummary: `Always-On discovery: ${selectedProject.displayName || selectedProject.name}`,
      toolsSettings: buildAlwaysOnDiscoveryToolsSettings(),
    });

    onSessionActive?.(pendingSessionId);
  }, [
    onSessionActive,
    onStartNewSession,
    selectedProject,
    selectedSession,
    sendMessage,
  ]);

  useEffect(() => {
    if (
      !latestMessage ||
      latestMessage.type !== 'always-on-auto-discovery-start' ||
      !latestMessage.requestId
    ) {
      return;
    }
    if (handledAutoDiscoveryRequestsRef.current.has(latestMessage.requestId)) {
      return;
    }
    handledAutoDiscoveryRequestsRef.current.add(latestMessage.requestId);

    const selectedProjectRoot = selectedProject?.fullPath || selectedProject?.path || selectedProject?.name;
    if (!selectedProject || selectedProjectRoot !== latestMessage.projectRoot) {
      sendMessage({
        type: 'always-on-auto-discovery-complete',
        requestId: latestMessage.requestId,
        projectRoot: latestMessage.projectRoot,
        result: 'failed',
        errorMessage: 'Selected project does not match discovery request project.',
      });
      return;
    }

    void handleStartDiscoverySession()
      .then(() => {
        sendMessage({
          type: 'always-on-auto-discovery-complete',
          requestId: latestMessage.requestId,
          projectRoot: latestMessage.projectRoot,
          result: 'started',
        });
      })
      .catch(error => {
        sendMessage({
          type: 'always-on-auto-discovery-complete',
          requestId: latestMessage.requestId,
          projectRoot: latestMessage.projectRoot,
          result: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
  }, [handleStartDiscoverySession, latestMessage, selectedProject, sendMessage]);

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
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SplitBody
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          shouldShowTasksTab={shouldShowTasksTab}
          tasksEnabled={tasksEnabled}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
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
          onOpenDiscoverySession={onNavigateToSession}
        />
      );
    }
    if (activeTab === 'dashboard') return <DashboardV2 />;
    if (activeTab === 'memory') return <MemoryPanel selectedProject={selectedProject} />;
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
            <FilesV2 selectedProject={selectedProject} onFileOpen={handleFileOpen} />
          </div>
        </>
      ) : null}
    </div>
  );
}

export default React.memo(MainContent);
