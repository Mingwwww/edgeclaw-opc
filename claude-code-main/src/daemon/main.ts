import {
  assertCronDaemonOk,
  sendCronDaemonRequest,
  waitForCronDaemonShutdown,
} from './ipc.js'
import { CronDaemonServer } from './server.js'

export async function daemonMain(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'serve'

  switch (subcommand) {
    case 'serve': {
      let server: CronDaemonServer | null = null
      let shutdownPromise: Promise<void> | null = null
      const shutdown = async () => {
        if (!server) return
        if (!shutdownPromise) {
          shutdownPromise = (async () => {
            await server!.stop()
            process.exit(0)
          })()
        }
        await shutdownPromise
      }
      server = new CronDaemonServer(shutdown)
      await server.start()
      process.on('SIGINT', () => {
        void shutdown()
      })
      process.on('SIGTERM', () => {
        void shutdown()
      })
      return
    }
    case 'status': {
      const response = await sendCronDaemonRequest({ type: 'ping' })
      assertCronDaemonOk(response)
      if (response.data.type !== 'pong') {
        throw new Error('Unexpected Cron daemon status response')
      }
      const { runtimes } = response.data
      if (runtimes.length === 0) {
        console.log('Cron daemon is running with no active project runtimes.')
        return
      }
      for (const runtime of runtimes) {
        console.log(
          `${runtime.projectRoot} durable=${runtime.durableCount} session_only=${runtime.sessionOnlyCount} active_workers=${runtime.activeWorkers}`,
        )
      }
      return
    }
    case 'stop': {
      const response = await sendCronDaemonRequest({ type: 'shutdown' })
      assertCronDaemonOk(response)
      const stopped = await waitForCronDaemonShutdown()
      if (!stopped) {
        throw new Error('Timed out waiting for Cron daemon to shut down')
      }
      console.log('Cron daemon shut down.')
      return
    }
    default:
      throw new Error(
        `Unknown daemon subcommand "${subcommand}". Expected serve, status, or stop.`,
      )
  }
}
