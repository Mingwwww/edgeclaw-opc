export type SessionProvider = 'claude' | 'cursor' | 'codex' | 'gemini';
export type ProjectSessionKind = 'background_task';

export type AppTab = 'home' | 'chat' | 'always-on' | 'files' | 'shell' | 'git' | 'tasks' | 'memory' | 'skills' | 'preview' | 'dashboard' | `plugin:${string}`;

export type CronJobOverviewStatus = 'scheduled' | 'running' | 'completed' | 'failed';
export type CronJobLatestRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface CronJobLatestRun {
  status?: CronJobLatestRunStatus;
  runId?: string;
  startedAt?: string;
  sessionId?: string;
  summary?: string;
  lastActivity?: string;
  taskId?: string;
  outputFile?: string;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
  transcriptKey?: string;
}

export interface CronJobOverview {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  durable?: boolean;
  lastFiredAt?: number;
  recurring?: boolean;
  permanent?: boolean;
  manualOnly?: boolean;
  originSessionId?: string;
  transcriptKey?: string;
  status: CronJobOverviewStatus;
  latestRun?: CronJobLatestRun | null;
}

export type AlwaysOnSessionTarget =
  | {
      kind: 'origin';
      sessionId: string;
    }
  | {
      kind: 'background';
      sessionId: string;
      parentSessionId: string;
      relativeTranscriptPath: string;
      title?: string;
      summary?: string;
      lastActivity?: string;
      transcriptKey?: string;
      taskId?: string;
      taskStatus?: string;
      outputFile?: string;
    };

export interface ProjectCronJobsResponse {
  jobs: CronJobOverview[];
}

export interface DeleteProjectCronJobResponse {
  deleted: boolean;
}

export type CronJobRunNowReason = 'already_running' | 'not_found';

export interface RunProjectCronJobNowResponse {
  started: boolean;
  reason?: CronJobRunNowReason;
}

export type AlwaysOnRunHistoryStatus = 'queued' | 'running' | 'completed' | 'failed' | 'unknown';
export type AlwaysOnRunHistoryKind = 'plan' | 'cron';

export interface AlwaysOnRunHistorySession {
  sessionId?: string;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
}

export interface AlwaysOnRunHistoryEntry {
  runId: string;
  title: string;
  kind: AlwaysOnRunHistoryKind;
  status: AlwaysOnRunHistoryStatus;
  startedAt?: string;
  sourceId: string;
  session?: AlwaysOnRunHistorySession;
}

export interface AlwaysOnRunHistoryDetail extends AlwaysOnRunHistoryEntry {
  outputLog: string;
  metadata: Record<string, unknown>;
}

export interface ProjectAlwaysOnRunHistoryResponse {
  runs: AlwaysOnRunHistoryEntry[];
}

export interface ProjectAlwaysOnRunHistoryDetailResponse {
  run: AlwaysOnRunHistoryDetail;
}

export type AlwaysOnRunLogSource = 'log-file' | 'session' | 'history';

export interface AlwaysOnRunLogResponse {
  runId: string;
  content: string;
  truncated: boolean;
  updatedAt?: string;
  size: number;
  source: AlwaysOnRunLogSource;
}

export type DiscoveryPlanApprovalMode = 'auto' | 'manual';
export type DiscoveryPlanStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'superseded';
export type DiscoveryPlanExecutionStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface DiscoveryPlanContextRefs {
  workingDirectory: string[];
  memory: string[];
  existingPlans: string[];
  cronJobs: string[];
  recentChats: string[];
}

export interface DiscoveryPlanOverview {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  approvalMode: DiscoveryPlanApprovalMode;
  status: DiscoveryPlanStatus;
  summary: string;
  rationale: string;
  dedupeKey: string;
  sourceDiscoverySessionId: string;
  executionSessionId?: string;
  executionStartedAt?: string;
  executionLastActivityAt?: string;
  executionStatus?: DiscoveryPlanExecutionStatus;
  latestSummary?: string;
  contextRefs: DiscoveryPlanContextRefs;
  planFilePath: string;
  structureVersion: number;
  content: string;
}

export interface ProjectDiscoveryPlansResponse {
  plans: DiscoveryPlanOverview[];
}

export interface DiscoveryContextMemoryItem {
  path: string;
  modifiedAt: string;
  summary: string;
}

export interface DiscoveryContextPlanItem {
  id: string;
  title: string;
  status: DiscoveryPlanStatus;
  approvalMode: DiscoveryPlanApprovalMode;
  updatedAt: string;
  summary: string;
}

export interface DiscoveryContextCronItem {
  id: string;
  status: CronJobOverviewStatus;
  cron: string;
  recurring: boolean;
  manualOnly: boolean;
  prompt: string;
  latestRunSummary?: string;
}

export interface DiscoveryContextChatItem {
  id: string;
  summary: string;
  lastActivity: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
}

export interface ProjectDiscoveryContextResponse {
  generatedAt: string;
  lookbackDays: number;
  workspace: {
    projectName: string;
    projectRoot: string;
    signals: string[];
  };
  memory: DiscoveryContextMemoryItem[];
  existingPlans: DiscoveryContextPlanItem[];
  cronJobs: DiscoveryContextCronItem[];
  recentChats: DiscoveryContextChatItem[];
}

export interface ExecuteDiscoveryPlanResponse {
  plan: DiscoveryPlanOverview;
  sessionSummary: string;
  command: string;
  executionToken: string;
}

export interface UpdateDiscoveryPlanExecutionResponse {
  plan: DiscoveryPlanOverview;
}

export interface ArchiveDiscoveryPlanResponse {
  archived: boolean;
}

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  sessionKind?: ProjectSessionKind;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
  transcriptKey?: string;
  taskId?: string;
  taskStatus?: string;
  outputFile?: string;
  isReadOnly?: boolean;
  __provider?: SessionProvider;
  __projectName?: string;
  [key: string]: unknown;
}

export type SessionRequestParams = {
  sessionKind?: ProjectSessionKind;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
};

export function isBackgroundTaskSession(
  session: ProjectSession | null | undefined,
): session is ProjectSession & {
  sessionKind: 'background_task';
  parentSessionId: string;
  relativeTranscriptPath: string;
} {
  return (
    session?.sessionKind === 'background_task' &&
    typeof session.parentSessionId === 'string' &&
    session.parentSessionId.length > 0 &&
    typeof session.relativeTranscriptPath === 'string' &&
    session.relativeTranscriptPath.length > 0
  );
}

export function getSessionRequestParams(
  session: ProjectSession | null | undefined,
): SessionRequestParams {
  if (!isBackgroundTaskSession(session)) {
    return {};
  }

  return {
    sessionKind: session.sessionKind,
    parentSessionId: session.parentSessionId,
    relativeTranscriptPath: session.relativeTranscriptPath,
  };
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface ProjectTaskmasterInfo {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProjectAlwaysOnInfo {
  discovery?: {
    triggerEnabled?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Project {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
  sessions?: ProjectSession[];
  cursorSessions?: ProjectSession[];
  codexSessions?: ProjectSession[];
  geminiSessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  alwaysOn?: ProjectAlwaysOnInfo;
  [key: string]: unknown;
}

export interface LoadingProgress {
  type?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}

export interface ProjectsUpdatedMessage {
  type: 'projects_updated';
  projects: Project[];
  changedFile?: string;
  [key: string]: unknown;
}

export interface LoadingProgressMessage extends LoadingProgress {
  type: 'loading_progress';
}

export type AppSocketMessage =
  | LoadingProgressMessage
  | ProjectsUpdatedMessage
  | { type?: string;[key: string]: unknown };
