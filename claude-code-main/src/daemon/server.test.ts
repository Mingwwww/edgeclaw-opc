import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { CronDaemonServer } from './server.js'
import { ProjectRuntime } from './projectRuntime.js'

test('shutdown request invokes the daemon shutdown callback after responding', async () => {
  const calls: string[] = []
  const server = new CronDaemonServer(async () => {
    calls.push('shutdown')
  })
  let response = ''
  const socket = {
    end(chunk: string, callback?: () => void) {
      response += chunk
      callback?.()
    },
  }

  await (server as any).dispatchLine(JSON.stringify({ type: 'shutdown' }), socket)
  await new Promise(resolve => setImmediate(resolve))

  expect(JSON.parse(response)).toEqual({
    ok: true,
    data: { type: 'shutdown' },
  })
  expect(calls).toEqual(['shutdown'])
})

test('client lease IPC tracks clients and shuts down after the last unregister', async () => {
  const calls: string[] = []
  const server = new CronDaemonServer(async () => {
    calls.push('shutdown')
  })

  const registerResponse = await (server as any).handleRequest({
    type: 'register_client',
    clientId: 'web-ui:1',
    clientType: 'web-ui',
    processId: 1,
    ttlMs: 30_000,
  })
  expect(registerResponse).toEqual({
    ok: true,
    data: {
      type: 'register_client',
      registered: true,
      leaseExpiresAt: expect.any(Number),
    },
  })

  const heartbeatResponse = await (server as any).handleRequest({
    type: 'heartbeat_client',
    clientId: 'web-ui:1',
  })
  expect(heartbeatResponse).toEqual({
    ok: true,
    data: {
      type: 'heartbeat_client',
      accepted: true,
      leaseExpiresAt: expect.any(Number),
    },
  })

  let response = ''
  const socket = {
    end(chunk: string, callback?: () => void) {
      response += chunk
      callback?.()
    },
  }
  await (server as any).dispatchLine(
    JSON.stringify({ type: 'unregister_client', clientId: 'web-ui:1' }),
    socket,
  )
  await new Promise(resolve => setImmediate(resolve))

  expect(JSON.parse(response)).toEqual({
    ok: true,
    data: {
      type: 'unregister_client',
      remainingClients: 0,
    },
  })
  expect(calls).toEqual(['shutdown'])
})

async function writeScheduledTasks(projectRoot: string, tasks: unknown[]) {
  const configDir = join(projectRoot, '.claude')
  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, 'scheduled_tasks.json'),
    JSON.stringify({ tasks }, null, 2),
    'utf-8',
  )
}

describe('CronDaemonServer run_task_now', () => {
  let projectRoot: string
  let configDir: string
  let launchTaskSpy: ReturnType<typeof spyOn>
  let isTaskRunningSpy: ReturnType<typeof spyOn>
  let startSpy: ReturnType<typeof spyOn>
  const priorConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cron-daemon-server-project-'))
    configDir = await mkdtemp(join(tmpdir(), 'cron-daemon-server-config-'))
    process.env.CLAUDE_CONFIG_DIR = configDir

    startSpy = spyOn(ProjectRuntime.prototype, 'start').mockImplementation(() => {})
    isTaskRunningSpy = spyOn(ProjectRuntime.prototype, 'isTaskRunning').mockReturnValue(
      false,
    )
    launchTaskSpy = spyOn(ProjectRuntime.prototype, 'launchSessionTask').mockResolvedValue(
      true,
    )
  })

  afterEach(async () => {
    launchTaskSpy.mockRestore()
    isTaskRunningSpy.mockRestore()
    startSpy.mockRestore()
    if (priorConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = priorConfigDir
    }
    await rm(projectRoot, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  })

  test('starts an existing durable task immediately', async () => {
    const taskId = 'cron-durable-1234'
    await writeScheduledTasks(projectRoot, [
      {
        id: taskId,
        cron: '0 * * * *',
        prompt: 'Review the queue',
        createdAt: Date.now(),
        recurring: true,
        originSessionId: 'origin-session-durable',
      },
    ])

    const server = new CronDaemonServer()
    const response = await (server as any).handleRequest({
      type: 'run_task_now',
      projectRoot,
      taskId,
    })

    expect(response).toEqual({
      ok: true,
      data: {
        type: 'run_task_now',
        started: true,
      },
    })
    expect(launchTaskSpy).toHaveBeenCalledTimes(1)
    expect(launchTaskSpy.mock.calls[0]?.[0]).toMatchObject({
      id: taskId,
      durable: true,
      recurring: true,
    })
  })

  test('starts an existing session-scoped task immediately', async () => {
    const server = new CronDaemonServer()
    const createResponse = await (server as any).handleRequest({
      type: 'create_task',
      projectRoot,
      originSessionId: 'origin-session-session',
      cron: '* * * * *',
      prompt: 'Stretch now',
      recurring: false,
      durable: false,
    })

    expect(createResponse.ok).toBe(true)
    if (!createResponse.ok || createResponse.data.type !== 'create_task') {
      return
    }

    launchTaskSpy.mockClear()
    const response = await (server as any).handleRequest({
      type: 'run_task_now',
      projectRoot,
      taskId: createResponse.data.task.id,
    })

    expect(response).toEqual({
      ok: true,
      data: {
        type: 'run_task_now',
        started: true,
      },
    })
    expect(launchTaskSpy).toHaveBeenCalledTimes(1)
    expect(launchTaskSpy.mock.calls[0]?.[0]).toMatchObject({
      id: createResponse.data.task.id,
      durable: false,
      prompt: 'Stretch now',
    })
  })

  test('returns not_found when the task does not exist', async () => {
    const server = new CronDaemonServer()
    const response = await (server as any).handleRequest({
      type: 'run_task_now',
      projectRoot,
      taskId: 'missing-task',
    })

    expect(response).toEqual({
      ok: true,
      data: {
        type: 'run_task_now',
        started: false,
        reason: 'not_found',
      },
    })
    expect(launchTaskSpy).not.toHaveBeenCalled()
  })

  test('returns already_running when runtime refuses to launch a duplicate worker', async () => {
    const taskId = 'cron-durable-running'
    await writeScheduledTasks(projectRoot, [
      {
        id: taskId,
        cron: '*/5 * * * *',
        prompt: 'Check backlog',
        createdAt: Date.now(),
        recurring: true,
        originSessionId: 'origin-session-running',
      },
    ])
    launchTaskSpy.mockResolvedValue(false)

    const server = new CronDaemonServer()
    const response = await (server as any).handleRequest({
      type: 'run_task_now',
      projectRoot,
      taskId,
    })

    expect(response).toEqual({
      ok: true,
      data: {
        type: 'run_task_now',
        started: false,
        reason: 'already_running',
      },
    })
    expect(launchTaskSpy).toHaveBeenCalledTimes(1)
  })

  test('list_tasks includes whether each task is currently running', async () => {
    const durableTaskId = 'cron-durable-list'
    await writeScheduledTasks(projectRoot, [
      {
        id: durableTaskId,
        cron: '*/5 * * * *',
        prompt: 'Check backlog',
        createdAt: Date.now(),
        recurring: true,
        originSessionId: 'origin-session-list',
      },
    ])

    const server = new CronDaemonServer()
    const createResponse = await (server as any).handleRequest({
      type: 'create_task',
      projectRoot,
      originSessionId: 'origin-session-session',
      cron: '* * * * *',
      prompt: 'Stretch now',
      recurring: false,
      durable: false,
    })

    expect(createResponse.ok).toBe(true)
    if (!createResponse.ok || createResponse.data.type !== 'create_task') {
      return
    }

    isTaskRunningSpy.mockImplementation(taskId => taskId === durableTaskId)

    const response = await (server as any).handleRequest({
      type: 'list_tasks',
      projectRoot,
    })

    expect(response).toEqual({
      ok: true,
      data: {
        type: 'list_tasks',
        tasks: expect.arrayContaining([
          expect.objectContaining({
            id: durableTaskId,
            durable: true,
            running: true,
          }),
          expect.objectContaining({
            id: createResponse.data.task.id,
            durable: false,
            running: false,
          }),
        ]),
      },
    })
  })

  test('create_task and list_tasks preserve manual-only proposals', async () => {
    const server = new CronDaemonServer()
    const createResponse = await (server as any).handleRequest({
      type: 'create_task',
      projectRoot,
      originSessionId: 'origin-session-manual',
      cron: '0 9 * * *',
      prompt: 'Review follow-up work',
      recurring: true,
      durable: true,
      manualOnly: true,
    })

    expect(createResponse.ok).toBe(true)
    if (!createResponse.ok || createResponse.data.type !== 'create_task') {
      return
    }

    expect(createResponse.data.task).toMatchObject({
      durable: true,
      manualOnly: true,
      originSessionId: 'origin-session-manual',
    })

    const listResponse = await (server as any).handleRequest({
      type: 'list_tasks',
      projectRoot,
    })

    expect(listResponse).toEqual({
      ok: true,
      data: {
        type: 'list_tasks',
        tasks: expect.arrayContaining([
          expect.objectContaining({
            id: createResponse.data.task.id,
            durable: true,
            manualOnly: true,
            running: false,
          }),
        ]),
      },
    })
  })
})
