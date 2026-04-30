import type { SettingsProject } from '../components/settings/types/types';

type EdgeClawConfigLike = Record<string, any>;

export function getAlwaysOnProjectRoot(project: SettingsProject): string {
  const root = project.fullPath || project.path || '';
  return typeof root === 'string' ? root.trim().replace(/[\\/]+$/, '') : '';
}

export function isAlwaysOnProjectEnabled(
  config: EdgeClawConfigLike,
  project: SettingsProject,
): boolean {
  const root = getAlwaysOnProjectRoot(project);
  return Boolean(root && config.alwaysOn?.discovery?.projects?.[root]?.enabled === true);
}

export function setAlwaysOnProjectEnabled<T extends EdgeClawConfigLike>(
  config: T,
  project: SettingsProject,
  enabled: boolean,
): T {
  const root = getAlwaysOnProjectRoot(project);
  if (!root) return config;

  return {
    ...config,
    alwaysOn: {
      ...config.alwaysOn,
      discovery: {
        ...config.alwaysOn?.discovery,
        projects: {
          ...config.alwaysOn?.discovery?.projects,
          [root]: {
            ...config.alwaysOn?.discovery?.projects?.[root],
            enabled,
          },
        },
      },
    },
  };
}
