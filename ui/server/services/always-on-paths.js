import path from 'path';

export function getAlwaysOnRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), '.claude', 'always-on');
}

export function getAlwaysOnHeartbeatsDir(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'heartbeats');
}

export function getAlwaysOnHeartbeatPath(projectRoot, fileName) {
  return path.join(getAlwaysOnHeartbeatsDir(projectRoot), fileName);
}
