/**
 * Claude provider adapter.
 *
 * Normalizes Claude Code SDK events and JSONL session history into the
 * provider-neutral NormalizedMessage format used by the UI.
 *
 * @module adapters/claude
 */

import { getSessionMessages } from '../../projects.js';
import { createNormalizedMessage, generateMessageId } from '../types.js';
import { extractSlashCommandInvocation, isInternalContent } from '../utils.js';

const PROVIDER = 'claude';
const TASK_NOTIFICATION_REGEX = /<task-notification>\s*<task-id>([\s\S]*?)<\/task-id>\s*<output-file>([\s\S]*?)<\/output-file>\s*<status>([\s\S]*?)<\/status>\s*<summary>([\s\S]*?)<\/summary>\s*<\/task-notification>/i;

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

function getTimestamp(raw) {
  return raw?.timestamp || raw?.created_at || raw?.createdAt || new Date().toISOString();
}

function getBaseId(raw, suffix = '') {
  const id = raw?.uuid || raw?.id || raw?.message?.id || generateMessageId('claude');
  return suffix ? `${id}_${suffix}` : id;
}

function stringifyContent(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (typeof part?.text === 'string') {
          return part.text;
        }
        if (typeof part?.content === 'string') {
          return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (typeof value.text === 'string') {
    return value.text;
  }
  if (typeof value.content === 'string') {
    return value.content;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseTaskNotification(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return null;
  }

  const match = content.match(TASK_NOTIFICATION_REGEX);
  if (!match) {
    return null;
  }

  const [, taskId = '', outputFile = '', status = '', summary = ''] = match;
  return {
    taskId: taskId.trim(),
    outputFile: outputFile.trim(),
    status: status.trim(),
    summary: summary.trim(),
  };
}

function createTextMessage({ id, sessionId, timestamp, role, content }) {
  const taskNotification = parseTaskNotification(content);
  if (taskNotification) {
    return createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'task_notification',
      status: taskNotification.status || 'completed',
      summary: taskNotification.summary || 'Background task update',
      taskId: taskNotification.taskId,
      outputFile: taskNotification.outputFile,
    });
  }

  if (role === 'user') {
    const slashCommand = extractSlashCommandInvocation(content);
    if (slashCommand) {
      content = slashCommand;
    } else if (isInternalContent(content)) {
      return null;
    }
  }

  if (!content.trim()) {
    return null;
  }

  return createNormalizedMessage({
    id,
    sessionId,
    timestamp,
    provider: PROVIDER,
    kind: 'text',
    role,
    content,
  });
}

function normalizeContentPart(part, raw, sessionId, partIndex, options) {
  const timestamp = getTimestamp(raw);
  const id = getBaseId(raw, partIndex);
  const isStreamingPart = Boolean(raw?.delta || raw?.isPartial || raw?.partial);

  if (typeof part === 'string') {
    if (options.skipStreamedText && !isStreamingPart) {
      return [];
    }

    const content = part;
    if (!content.trim()) {
      return [];
    }

    return [createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: isStreamingPart ? 'stream_delta' : 'text',
      role: 'assistant',
      content,
    })];
  }

  switch (part?.type) {
    case 'text': {
      if (options.skipStreamedText && !isStreamingPart) {
        return [];
      }

      const content = stringifyContent(part.text);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: isStreamingPart ? 'stream_delta' : 'text',
        role: 'assistant',
        content,
      })];
    }

    case 'thinking':
    case 'redacted_thinking': {
      if (options.skipStreamedText && !isStreamingPart) {
        return [];
      }

      const content = stringifyContent(part.thinking || part.text || part.content);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        content,
      })];
    }

    case 'tool_use': {
      return [createNormalizedMessage({
        id,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: part.name || 'UnknownTool',
        toolInput: part.input ?? {},
        toolId: part.id || id,
        toolUseResult: raw?.toolUseResult,
        subagentTools: raw?.subagentTools,
      })];
    }

    case 'tool_result': {
      return [createNormalizedMessage({
        id,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: part.tool_use_id || part.id || '',
        content: stringifyContent(part.content),
        isError: Boolean(part.is_error),
      })];
    }

    default:
      return [];
  }
}

function normalizeUserMessage(raw, sessionId, options) {
  if (options.includeUserText === false) {
    return [];
  }

  const timestamp = getTimestamp(raw);
  const content = raw?.message?.content ?? raw?.content ?? '';
  const normalized = [];

  if (Array.isArray(content)) {
    content.forEach((part, index) => {
      if (part?.type === 'tool_result') {
        normalized.push(...normalizeContentPart(part, raw, sessionId, index, options));
        return;
      }

      const text = stringifyContent(part);
      const message = createTextMessage({
        id: getBaseId(raw, index),
        sessionId,
        timestamp,
        role: 'user',
        content: text,
      });
      if (message) {
        normalized.push(message);
      }
    });
    return normalized;
  }

  const message = createTextMessage({
    id: getBaseId(raw),
    sessionId,
    timestamp,
    role: 'user',
    content: stringifyContent(content),
  });
  return message ? [message] : [];
}

function normalizeAssistantMessage(raw, sessionId, options) {
  const content = raw?.message?.content ?? raw?.content ?? '';

  if (Array.isArray(content)) {
    return content.flatMap((part, index) => normalizeContentPart(part, raw, sessionId, index, options));
  }

  return normalizeContentPart(content, raw, sessionId, 0, options);
}

function normalizeDirectEvent(raw, sessionId, options) {
  const timestamp = getTimestamp(raw);
  const id = getBaseId(raw);

  if (raw.type === 'stream_delta' || raw.type === 'content_block_delta' || raw.type === 'assistant_delta') {
    const content = stringifyContent(raw.text ?? raw.delta?.text ?? raw.delta ?? raw.content);
    if (!content.trim()) {
      return [];
    }
    return [createNormalizedMessage({ id, sessionId, timestamp, provider: PROVIDER, kind: 'stream_delta', content })];
  }

  if (raw.type === 'tool_use') {
    return [createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName: raw.name || raw.toolName || 'UnknownTool',
      toolInput: raw.input ?? raw.toolInput ?? {},
      toolId: raw.tool_use_id || raw.toolId || raw.id || id,
      toolUseResult: raw.toolUseResult,
      subagentTools: raw.subagentTools,
    })];
  }

  if (raw.type === 'tool_result') {
    return [createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: raw.tool_use_id || raw.toolId || '',
      content: stringifyContent(raw.content ?? raw.output),
      isError: Boolean(raw.is_error || raw.isError),
    })];
  }

  if (raw.type === 'result') {
    return [createNormalizedMessage({ id, sessionId, timestamp, provider: PROVIDER, kind: 'stream_end' })];
  }

  if (raw.type === 'error') {
    return [createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'error',
      content: raw.error?.message || raw.message || 'Unknown Claude error',
    })];
  }

  return [];
}

function attachToolResults(messages) {
  const toolResultMap = new Map();

  for (const message of messages) {
    if (message.kind === 'tool_result' && message.toolId) {
      toolResultMap.set(message.toolId, message);
    }
  }

  for (const message of messages) {
    if (message.kind === 'tool_use' && message.toolId && toolResultMap.has(message.toolId)) {
      const toolResult = toolResultMap.get(message.toolId);
      message.toolResult = {
        content: toolResult.content,
        isError: toolResult.isError,
        toolUseResult: toolResult.toolUseResult,
      };
    }
  }

  return messages;
}

/**
 * Normalize a raw Claude event or JSONL entry into NormalizedMessage(s).
 * @param {object} raw
 * @param {string} sessionId
 * @param {{includeUserText?: boolean, skipStreamedText?: boolean}} [options]
 * @returns {import('../types.js').NormalizedMessage[]}
 */
export function normalizeMessage(raw, sessionId, options = {}) {
  if (!raw || typeof raw !== 'object') {
    return [];
  }

  const role = raw.message?.role || raw.role;
  if (role === 'user') {
    return normalizeUserMessage(raw, sessionId, options);
  }

  if (role === 'assistant' || raw.type === 'assistant') {
    return normalizeAssistantMessage(raw, sessionId, options);
  }

  return normalizeDirectEvent(raw, sessionId, options);
}

/**
 * @type {import('../types.js').ProviderAdapter}
 */
export const claudeAdapter = {
  normalizeMessage,

  /**
   * Fetch session history from Claude JSONL files.
   */
  async fetchHistory(sessionId, opts = {}) {
    const {
      projectName = '',
      limit = null,
      offset = 0,
      sessionKind = null,
      parentSessionId = null,
      relativeTranscriptPath = null,
    } = opts;

    if (!projectName) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit };
    }

    let result;
    try {
      result = await getSessionMessages(projectName, sessionId, {
        limit,
        offset,
        sessionKind,
        parentSessionId,
        relativeTranscriptPath,
      });
    } catch (error) {
      console.warn(`[ClaudeAdapter] Failed to load session ${sessionId}:`, error.message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);
    const total = Array.isArray(result) ? rawMessages.length : (result.total || rawMessages.length);
    const hasMore = Array.isArray(result) ? false : Boolean(result.hasMore);
    const normalized = [];

    for (const raw of rawMessages) {
      normalized.push(...normalizeMessage(raw, sessionId));
    }

    return {
      messages: attachToolResults(normalized),
      total,
      hasMore,
      offset: Array.isArray(result) ? 0 : (result.offset ?? offset),
      limit: Array.isArray(result) ? null : (result.limit ?? limit),
      tokenUsage: result?.tokenUsage || null,
    };
  },
};
