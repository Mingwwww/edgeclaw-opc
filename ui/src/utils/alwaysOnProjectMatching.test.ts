import { describe, expect, it } from 'vitest';
import { findAlwaysOnProjectByRoot } from './alwaysOnProjectMatching';
import type { Project } from '../types/app';

describe('findAlwaysOnProjectByRoot', () => {
  it('matches only opted-in projects by normalized root', () => {
    const projects: Project[] = [
      {
        name: 'not-opted-in',
        displayName: 'Not opted in',
        fullPath: '/workspace/a',
      },
      {
        name: 'opted-in',
        displayName: 'Opted in',
        fullPath: '/workspace/b/',
        alwaysOn: { discovery: { triggerEnabled: true } },
      },
    ];

    expect(findAlwaysOnProjectByRoot(projects, '/workspace/a')).toBeUndefined();
    expect(findAlwaysOnProjectByRoot(projects, '/workspace/b')?.name).toBe('opted-in');
  });
});
