import {
  initializeCronDaemonOwnerEnv,
  persistCurrentCronDaemonOwner
} from './cron-daemon-owner.js';
import { startCronDaemonClientLease } from './cron-daemon-client-lease.js';
import { ensureCronDaemonForUiStartup } from './cron-daemon-startup.js';

export async function runServerStartupBeforeListen({
  initializeCronDaemonOwnerEnvFn = initializeCronDaemonOwnerEnv,
  persistCurrentCronDaemonOwnerFn = persistCurrentCronDaemonOwner,
  ensureCronDaemonForUiStartupFn = ensureCronDaemonForUiStartup,
  startCronDaemonClientLeaseFn = startCronDaemonClientLease,
  initializeDatabaseFn,
  ensureLocalUserWhenAuthDisabledFn,
  configureWebPushFn
}) {
  if (typeof initializeDatabaseFn !== 'function') {
    throw new TypeError('initializeDatabaseFn is required');
  }
  if (typeof ensureLocalUserWhenAuthDisabledFn !== 'function') {
    throw new TypeError('ensureLocalUserWhenAuthDisabledFn is required');
  }
  if (typeof configureWebPushFn !== 'function') {
    throw new TypeError('configureWebPushFn is required');
  }

  initializeCronDaemonOwnerEnvFn();
  try {
    const cronDaemonStartup = await ensureCronDaemonForUiStartupFn();
    if (cronDaemonStartup?.started) {
      await persistCurrentCronDaemonOwnerFn();
    }
    await startCronDaemonClientLeaseFn();
  } catch (err) {
    console.warn('[server-startup] Cron daemon unavailable, continuing without it:', err.message);
  }
  await initializeDatabaseFn();
  await ensureLocalUserWhenAuthDisabledFn();
  configureWebPushFn();
}

export async function startServerAfterStartup({
  startupFn,
  listenFn
}) {
  if (typeof startupFn !== 'function') {
    throw new TypeError('startupFn is required');
  }
  if (typeof listenFn !== 'function') {
    throw new TypeError('listenFn is required');
  }

  await startupFn();
  return await listenFn();
}
