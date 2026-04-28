import { useEffect, useMemo, useRef } from 'react'
import { mkdir, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { getProjectRoot, getSessionId } from '../bootstrap/state.js'
import { getAlwaysOnHeartbeatPath } from '../utils/alwaysOnPaths.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { sendCronDaemonRequest } from '../daemon/ipc.js'

function hasBusyTask(tasks: Record<string, unknown>): boolean {
  return Object.values(tasks).some(task => {
    if (!task || typeof task !== 'object' || !('status' in task)) {
      return false
    }
    const status = (task as { status?: unknown }).status
    return status === 'running' || status === 'pending'
  })
}

async function writeHeartbeat(args: {
  agentBusy: boolean
  lastUserMsgAt: string | null
}): Promise<void> {
  const projectRoot = getProjectRoot()
  const filePath = getAlwaysOnHeartbeatPath(projectRoot, `tui-${process.pid}.beat`)
  await mkdir(dirname(filePath), { recursive: true })
  void sendCronDaemonRequest({ type: 'register_project', projectRoot }).catch(
    () => undefined,
  )
  await writeFile(
    filePath,
    jsonStringify(
      {
        schemaVersion: 1,
        writerKind: 'tui',
        writerId: String(process.pid),
        writtenAt: new Date().toISOString(),
        agentBusy: args.agentBusy,
        processingSessionIds: args.agentBusy ? [getSessionId()] : [],
        ...(args.lastUserMsgAt ? { lastUserMsgAt: args.lastUserMsgAt } : {}),
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  )
}

async function removeHeartbeat(): Promise<void> {
  await rm(getAlwaysOnHeartbeatPath(getProjectRoot(), `tui-${process.pid}.beat`), {
    force: true,
  }).catch(() => undefined)
}

export function useAlwaysOnHeartbeat(tasks: Record<string, unknown>): void {
  const agentBusy = useMemo(() => hasBusyTask(tasks), [tasks])
  const lastUserMsgAtRef = useRef<string | null>(null)
  const wasBusyRef = useRef(agentBusy)

  useEffect(() => {
    if (agentBusy && !wasBusyRef.current) {
      lastUserMsgAtRef.current = new Date().toISOString()
    }
    wasBusyRef.current = agentBusy
  }, [agentBusy])

  useEffect(() => {
    let disposed = false
    const tick = () => {
      if (disposed) return
      void writeHeartbeat({
        agentBusy,
        lastUserMsgAt: lastUserMsgAtRef.current,
      })
    }

    tick()
    const interval = setInterval(tick, 30_000)
    interval.unref?.()
    return () => {
      disposed = true
      clearInterval(interval)
      void removeHeartbeat()
    }
  }, [agentBusy])
}
