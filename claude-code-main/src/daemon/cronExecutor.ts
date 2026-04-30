import { randomUUID } from 'crypto'
import { chdir } from 'process'
import { getCommands } from '../commands.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { buildSideQuestionFallbackParams } from '../utils/queryContext.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import { createStore } from '../state/store.js'
import { getTools } from '../tools.js'
import {
  CRON_BACKGROUND_QUERY_SOURCE,
  startCronBackgroundTask,
} from '../tasks/CronBackgroundTask.js'
import { asSessionId } from '../types/ids.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { initializeToolPermissionContext } from '../utils/permissions/permissionSetup.js'
import { getAgentDefinitionsWithOverrides } from '../tools/AgentTool/loadAgentsDir.js'
import { appendCronRunHistoryEvent, appendCronRunLog } from './projectRuntime.js'
import {
  setClientType,
  setCwdState,
  setIsInteractive,
  setOriginalCwd,
  setProjectRoot,
  setSessionPersistenceDisabled,
  setSessionSource,
  switchSession,
} from '../bootstrap/state.js'
import { enqueueCronDaemonNotification } from './notificationInbox.js'
import type { CronWorkerPayload } from './types.js'

function filterHeadlessCommands(
  commands: Awaited<ReturnType<typeof getCommands>>,
) {
  return commands.filter(
    command =>
      (command.type === 'prompt' && !command.disableNonInteractive) ||
      (command.type === 'local' && command.supportsNonInteractive),
  )
}

function configureWorkerBootstrap(
  projectRoot: string,
  originSessionId?: string,
): void {
  chdir(projectRoot)
  setOriginalCwd(projectRoot)
  setProjectRoot(projectRoot)
  setCwdState(projectRoot)
  setIsInteractive(false)
  setClientType('cron-daemon-worker')
  setSessionSource('cron-daemon')
  setSessionPersistenceDisabled(true)
  switchSession(asSessionId(originSessionId ?? randomUUID()))
}

async function createWorkerStore(projectRoot: string) {
  applyConfigEnvironmentVariables()
  const initResult = await initializeToolPermissionContext({
    allowedToolsCli: [],
    disallowedToolsCli: [],
    baseToolsCli: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    addDirs: [],
  })
  const toolPermissionContext = {
    ...initResult.toolPermissionContext,
    shouldAvoidPermissionPrompts: true,
  }
  const tools = getTools(toolPermissionContext)
  const [commands, agentDefinitions] = await Promise.all([
    getCommands(projectRoot),
    getAgentDefinitionsWithOverrides(projectRoot),
  ])
  const defaultState = getDefaultAppState()
  const initialState: AppState = {
    ...defaultState,
    toolPermissionContext,
    ...(typeof defaultState.kairosEnabled === 'boolean'
      ? { kairosEnabled: true }
      : {}),
  }
  const store = createStore(initialState, onChangeAppState)
  return {
    store,
    tools,
    commands: filterHeadlessCommands(commands),
    agents: agentDefinitions.activeAgents,
  }
}

export async function runCronWorker(payload: CronWorkerPayload): Promise<void> {
  const runId = payload.runId ?? payload.task.id
  await appendCronRunLog(
    payload.projectRoot,
    payload.task.id,
    runId,
    'executor_bootstrap',
    'Configuring cron worker bootstrap',
  )
  configureWorkerBootstrap(payload.projectRoot, payload.task.originSessionId)

  const readFileState = createFileStateCacheWithSizeLimit(100)
  const { store, tools, commands, agents } = await createWorkerStore(
    payload.projectRoot,
  )

  const canUseTool: CanUseToolFn = async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) =>
    forceDecision ??
    (await hasPermissionsToUseTool(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
    ))

  await appendCronRunLog(
    payload.projectRoot,
    payload.task.id,
    runId,
    'executor_start',
    'Starting background task',
  )

  const result = await startCronBackgroundTask({
    task: payload.task,
    setAppState: store.setState,
    dir: payload.task.durable ? payload.projectRoot : undefined,
    notificationSink: payload.task.originSessionId
      ? message =>
          enqueueCronDaemonNotification(payload.task.originSessionId!, message).then(
            () => undefined,
          )
      : undefined,
    createQueryParams: async ({ messages, abortController, querySource }) => {
      const appState = store.getState()
      const fallback = await buildSideQuestionFallbackParams({
        tools,
        commands,
        mcpClients: appState.mcp.clients,
        messages,
        readFileState,
        getAppState: store.getState,
        setAppState: store.setState,
        customSystemPrompt: undefined,
        appendSystemPrompt: undefined,
        thinkingConfig: undefined,
        agents,
      })
      return {
        systemPrompt: fallback.systemPrompt,
        userContext: fallback.userContext,
        systemContext: fallback.systemContext,
        canUseTool,
        querySource,
        toolUseContext: {
          ...fallback.toolUseContext,
          abortController,
          messages,
          options: {
            ...fallback.toolUseContext.options,
            tools,
            commands,
            mcpResources: appState.mcp.resources,
            querySource,
            refreshTools: () => getTools(store.getState().toolPermissionContext),
          },
        },
      }
    },
  })

  if (result.status === 'skipped') {
    await appendCronRunLog(
      payload.projectRoot,
      payload.task.id,
      runId,
      'executor_skipped',
      'Background task skipped because it is already running',
      'warn',
    )
    logForDebugging(
      `[CronDaemonWorker] skipped ${payload.task.id}: already running`,
    )
    return
  }

  await appendCronRunHistoryEvent(
    payload.projectRoot,
    payload.task,
    runId,
    'running',
    payload.startedAt,
  )

  try {
    await result.completion
  } catch (error) {
    await appendCronRunLog(
      payload.projectRoot,
      payload.task.id,
      runId,
      'executor_error',
      String(error),
      'error',
    )
    logError(error)
    throw error
  }

  await appendCronRunLog(
    payload.projectRoot,
    payload.task.id,
    runId,
    'executor_complete',
    `Completed ${payload.task.id} (${CRON_BACKGROUND_QUERY_SOURCE})`,
  )
  logForDebugging(
    `[CronDaemonWorker] completed ${payload.task.id} (${CRON_BACKGROUND_QUERY_SOURCE})`,
  )
}
