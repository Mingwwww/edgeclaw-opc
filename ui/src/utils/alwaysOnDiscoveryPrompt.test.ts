import { describe, expect, it } from 'vitest';
import type {
  Project,
  ProjectDiscoveryContextResponse,
} from '../types/app';
import {
  buildAlwaysOnDiscoveryPrompt,
  normalizeDiscoveryPromptLanguage,
} from './alwaysOnDiscoveryPrompt';

const project: Project = {
  name: 'edgeclaw-opc',
  displayName: 'Edgeclaw OPC',
  fullPath: '/Users/test/edgeclaw-opc',
};

const context: ProjectDiscoveryContextResponse = {
  generatedAt: '2026-04-29T00:00:00.000Z',
  lookbackDays: 7,
  workspace: {
    projectName: 'edgeclaw-opc',
    projectRoot: '/Users/test/edgeclaw-opc',
    signals: ['package.json changed recently'],
  },
  memory: [],
  existingPlans: [],
  cronJobs: [],
  recentChats: [
    {
      id: 'chat-1',
      summary: '用户要求用中文整理 Always-On 计划。',
      lastActivity: '2026-04-29T00:00:00.000Z',
      lastUserMessage: '请用中文规划这个任务',
    },
  ],
};

describe('alwaysOnDiscoveryPrompt', () => {
  it('normalizes unsupported languages to English', () => {
    expect(normalizeDiscoveryPromptLanguage('zh-CN')).toBe('zh-CN');
    expect(normalizeDiscoveryPromptLanguage('en')).toBe('en');
    expect(normalizeDiscoveryPromptLanguage('de')).toBe('en');
    expect(normalizeDiscoveryPromptLanguage(undefined)).toBe('en');
  });

  it('builds an English prompt by default', () => {
    const prompt = buildAlwaysOnDiscoveryPrompt(project, context);

    expect(prompt).toContain('Always-On discovery planning for project "Edgeclaw OPC"');
    expect(prompt).toContain('recent chats win');
    expect(prompt).toContain('"recentChats"');
    expect(prompt).not.toContain('主动发现规划');
  });

  it('builds a Simplified Chinese prompt for zh-CN', () => {
    const prompt = buildAlwaysOnDiscoveryPrompt(project, context, 'zh-CN');

    expect(prompt).toContain('Always-On 主动发现规划');
    expect(prompt).toContain('近期聊天语言为准');
    expect(prompt).toContain('结构化 discovery context');
    expect(prompt).toContain('## To-Do List');
    expect(prompt).toContain('- [ ] 检查当前行为');
  });
});
