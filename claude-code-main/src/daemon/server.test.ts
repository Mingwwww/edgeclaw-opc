import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { CronDaemonServer } from './server.js'
import { ProjectRuntime } from './projectRuntime.js'

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

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

    isTaskRunningSpy.mockImplementation((taskId: string) => taskId === durableTaskId)

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

describe('CronDaemonServer client leases', () => {
  test('keeps the daemon alive until the last client unregisters', async () => {
    const server = new CronDaemonServer(5)
    const stopSpy = spyOn(server, 'stop').mockResolvedValue(undefined)

    const first = await (server as any).handleRequest({
      type: 'register_client',
      clientId: 'webui-1',
      clientKind: 'webui',
    })
    const second = await (server as any).handleRequest({
      type: 'register_client',
      clientId: 'tui-1',
      clientKind: 'tui',
      processId: 123,
    })
    const unregisterFirst = await (server as any).handleRequest({
      type: 'unregister_client',
      clientId: 'webui-1',
    })

    await sleep(10)
    expect(stopSpy).not.toHaveBeenCalled()

    const unregisterSecond = await (server as any).handleRequest({
      type: 'unregister_client',
      clientId: 'tui-1',
    })
    await sleep(10)

    expect(first).toMatchObject({
      ok: true,
      data: { type: 'register_client', activeClients: 1 },
    })
    expect(second).toMatchObject({
      ok: true,
      data: { type: 'register_client', activeClients: 2 },
    })
    expect(unregisterFirst).toEqual({
      ok: true,
      data: { type: 'unregister_client', activeClients: 1 },
    })
    expect(unregisterSecond).toEqual({
      ok: true,
      data: { type: 'unregister_client', activeClients: 0 },
    })
    expect(stopSpy).toHaveBeenCalledTimes(1)

    stopSpy.mockRestore()
  })

  test('cancels pending empty-client shutdown when a client reconnects', async () => {
    const server = new CronDaemonServer(20)
    const stopSpy = spyOn(server, 'stop').mockResolvedValue(undefined)

    await (server as any).handleRequest({
      type: 'register_client',
      clientId: 'webui-1',
      clientKind: 'webui',
    })
    await (server as any).handleRequest({
      type: 'unregister_client',
      clientId: 'webui-1',
    })
    await (server as any).handleRequest({
      type: 'register_client',
      clientId: 'webui-2',
      clientKind: 'webui',
    })
    await sleep(30)

    expect(stopSpy).not.toHaveBeenCalled()

    stopSpy.mockRestore()
    await (server as any).handleRequest({
      type: 'unregister_client',
      clientId: 'webui-2',
    })
    await server.stop()
  })

  test('ping includes active client lease summaries', async () => {
    const server = new CronDaemonServer(20)
    const leaseProjectRoot = '/tmp/cron-daemon-lease-summary'
    await (server as any).handleRequest({
      type: 'register_client',
      clientId: 'tui-summary',
      clientKind: 'tui',
      processId: 42,
      projectRoots: [leaseProjectRoot],
    })

    const response = await (server as any).handleRequest({ type: 'ping' })

    expect(response).toMatchObject({
      ok: true,
      data: {
        type: 'pong',
        clients: [
          expect.objectContaining({
            clientId: 'tui-summary',
            clientKind: 'tui',
            processId: 42,
            projectRoots: [leaseProjectRoot],
          }),
        ],
      },
    })

    await (server as any).handleRequest({
      type: 'unregister_client',
      clientId: 'tui-summary',
    })
    await server.stop()
  })

  test('register_project schedules discovery for multiple project roots', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const configDir = await mkdtemp(
      join(tmpdir(), 'cron-daemon-server-config-multi-'),
    )
    const firstProjectRoot = await mkdtemp(
      join(tmpdir(), 'cron-daemon-server-project-first-'),
    )
    const secondProjectRoot = await mkdtemp(
      join(tmpdir(), 'cron-daemon-server-project-second-'),
    )
    const server = new CronDaemonServer()
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const firstResponse = await (server as any).handleRequest({
        type: 'register_project',
        projectRoot: firstProjectRoot,
      })
      const secondResponse = await (server as any).handleRequest({
        type: 'register_project',
        projectRoot: secondProjectRoot,
      })

      expect(firstResponse.ok).toBe(true)
      expect(secondResponse.ok).toBe(true)
      const timers = (server as any).discoveryScheduler.timers
      expect(timers.has(resolve(firstProjectRoot))).toBe(true)
      expect(timers.has(resolve(secondProjectRoot))).toBe(true)
      expect(timers.size).toBe(2)
    } finally {
      await server.stop()
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      await rm(configDir, { recursive: true, force: true })
      await rm(firstProjectRoot, { recursive: true, force: true })
      await rm(secondProjectRoot, { recursive: true, force: true })
    }
  })
})
