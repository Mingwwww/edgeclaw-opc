import { describe, expect, it } from 'vitest';
import {
  getAlwaysOnProjectRoot,
  isAlwaysOnProjectEnabled,
  setAlwaysOnProjectEnabled,
} from './alwaysOnConfigPatch';

describe('alwaysOnConfigPatch', () => {
  it('normalizes project roots and patches top-level alwaysOn project settings', () => {
    const project = {
      name: 'project-a',
      displayName: 'Project A',
      fullPath: '/workspace/a/',
      path: '/workspace/a/',
    };

    expect(getAlwaysOnProjectRoot(project)).toBe('/workspace/a');

    const config = setAlwaysOnProjectEnabled<Record<string, any>>({}, project, true);
    expect(config.alwaysOn.discovery.projects['/workspace/a'].enabled).toBe(true);
    expect(isAlwaysOnProjectEnabled(config, project)).toBe(true);

    const disabled = setAlwaysOnProjectEnabled<Record<string, any>>(config, project, false);
    expect(disabled.alwaysOn.discovery.projects['/workspace/a'].enabled).toBe(false);
    expect(isAlwaysOnProjectEnabled(disabled, project)).toBe(false);
  });
});
