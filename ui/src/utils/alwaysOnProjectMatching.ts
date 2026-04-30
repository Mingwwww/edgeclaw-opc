import type { Project } from '../types/app';

export function normalizeProjectRootForCompare(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/[\\/]+$/, '') : '';
}

export function findAlwaysOnProjectByRoot(
  projects: Project[],
  projectRoot: unknown,
): Project | undefined {
  const targetRoot = normalizeProjectRootForCompare(projectRoot);
  if (!targetRoot) return undefined;

  return projects.find(project => {
    const root = normalizeProjectRootForCompare(project.fullPath || project.path);
    return root === targetRoot && project.alwaysOn?.discovery?.triggerEnabled === true;
  });
}
