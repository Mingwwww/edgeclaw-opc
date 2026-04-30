import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEdgeClawConfig } from './edgeclawConfig.js';

test('normalizeEdgeClawConfig exposes default top-level alwaysOn config', () => {
  const config = normalizeEdgeClawConfig({});

  assert.equal(config.alwaysOn.discovery.trigger.enabled, false);
  assert.equal(config.alwaysOn.discovery.trigger.tickIntervalMinutes, 5);
  assert.deepEqual(config.alwaysOn.discovery.projects, {});
  assert.equal(config.agents.alwaysOn, undefined);
});

test('normalizeEdgeClawConfig migrates legacy agents.alwaysOn trigger when top-level config is absent', () => {
  const config = normalizeEdgeClawConfig({
    agents: {
      alwaysOn: {
        discovery: {
          trigger: {
            enabled: true,
            tickIntervalMinutes: 15,
          },
        },
      },
    },
  });

  assert.equal(config.alwaysOn.discovery.trigger.enabled, true);
  assert.equal(config.alwaysOn.discovery.trigger.tickIntervalMinutes, 15);
  assert.equal(config.agents.alwaysOn, undefined);
});

test('normalizeEdgeClawConfig prefers top-level alwaysOn over legacy agents.alwaysOn', () => {
  const config = normalizeEdgeClawConfig({
    agents: {
      alwaysOn: {
        discovery: {
          trigger: {
            enabled: true,
            tickIntervalMinutes: 15,
          },
        },
      },
    },
    alwaysOn: {
      discovery: {
        trigger: {
          enabled: false,
          tickIntervalMinutes: 3,
        },
        projects: {
          '/workspace/a': { enabled: true },
        },
      },
    },
  });

  assert.equal(config.alwaysOn.discovery.trigger.enabled, false);
  assert.equal(config.alwaysOn.discovery.trigger.tickIntervalMinutes, 3);
  assert.equal(config.alwaysOn.discovery.projects['/workspace/a'].enabled, true);
});
