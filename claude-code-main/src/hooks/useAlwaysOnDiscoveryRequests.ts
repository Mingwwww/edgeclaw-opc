import { useEffect } from 'react'
import { readdir, readFile, rm } from 'fs/promises'
import {
  getCronDaemonDiscoveryRequestDir,
  getCronDaemonDiscoveryRequestPath,
} from '../daemon/paths.js'
import { sendCronDaemonRequest } from '../daemon/ipc.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { safeParseJSON } from '../utils/json.js'
import { buildAlwaysOnDiscoveryPrompt } from '../utils/alwaysOnDiscoveryPrompt.js'

type SubmitPrompt = (content: string, options?: { isMeta?: boolean }) => boolean

export function useAlwaysOnDiscoveryRequests(
  onSubmitMessage: SubmitPrompt,
): void {
  useEffect(() => {
    let disposed = false

    const poll = async () => {
      let names: string[] = []
      try {
        names = (await readdir(getCronDaemonDiscoveryRequestDir()))
          .filter(name => name.endsWith('.json'))
          .sort((a, b) => a.localeCompare(b))
      } catch {
        return
      }

      for (const name of names) {
        if (disposed) return
        const path = getCronDaemonDiscoveryRequestPath(name)
        let request: any
        try {
          request = safeParseJSON(await readFile(path, 'utf-8'), false)
        } catch {
          continue
        }
        if (
          request?.type !== 'discovery_fire_request' ||
          request.targetWriterKind !== 'tui' ||
          request.targetWriterId !== String(process.pid) ||
          request.projectRoot !== getProjectRoot()
        ) {
          continue
        }

        const submitted = onSubmitMessage(
          buildAlwaysOnDiscoveryPrompt(request.projectRoot),
          { isMeta: true },
        )
        await rm(path, { force: true }).catch(() => undefined)
        await sendCronDaemonRequest({
          type: 'discovery_fire_complete',
          requestId: request.requestId,
          projectRoot: request.projectRoot,
          result: submitted ? 'started' : 'failed',
          ...(submitted ? {} : { errorMessage: 'TUI main loop is busy' }),
        })
      }
    }

    void poll()
    const interval = setInterval(() => {
      void poll()
    }, 1000)
    interval.unref?.()
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [onSubmitMessage])
}
