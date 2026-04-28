import { join, resolve } from 'path'

export function getAlwaysOnRoot(projectRoot: string): string {
  return join(resolve(projectRoot), '.claude', 'always-on')
}

export function getAlwaysOnHeartbeatsDir(projectRoot: string): string {
  return join(getAlwaysOnRoot(projectRoot), 'heartbeats')
}

export function getAlwaysOnHeartbeatPath(
  projectRoot: string,
  fileName: string,
): string {
  return join(getAlwaysOnHeartbeatsDir(projectRoot), fileName)
}

export function getAlwaysOnDiscoveryLockPath(projectRoot: string): string {
  return join(getAlwaysOnRoot(projectRoot), 'discovery.lock')
}

export function getAlwaysOnDiscoveryStatePath(projectRoot: string): string {
  return join(getAlwaysOnRoot(projectRoot), 'discovery-state.json')
}
