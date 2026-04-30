/**
 * EdgeClaw provider adapter.
 *
 * Normalizes Claude Agent SDK events and JSONL session history into the
 * provider-neutral NormalizedMessage format used by the UI. The folder is
 * named `edgeclaw` to match the project, but the SessionProvider key on the
 * wire is still `'claude'` (see PROVIDER below) so renaming the folder does
 * not break protocol compatibility with the frontend.
 *
 * @module adapters/edgeclaw
 */

import { getSessionMessages } from '../../projects.js';
import { createNormalizedMessage, generateMessageId } from '../types.js';
import { extractSlashCommandInvocation, isInternalContent, isInterruptedNotice } from '../utils.js';

const PROVIDER = 'claude';
const TASK_NOTIFICATION_OUTER = /<task-notification>([\s\S]*?)<\/task-notification>/i;
const TASK_FIELD_REGEX = {
  taskId: /<task-id>([\s\S]*?)<\/task-id>/i,
  outputFile: /<output-file>([\s\S]*?)<\/output-file>/i,
  status: /<status>([\s\S]*?)<\/status>/i,
  summary: /<summary>([\s\S]*?)<\/summary>/i,
};

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

  // Defense in depth: never serialize binary attachment blocks via
  // JSON.stringify. The base64 payload is huge and should never end up in a
  // chat bubble. Callers that genuinely need a label for an attachment part
  // should use describeAttachmentPart() instead.
  if (value.type === 'image' || value.type === 'document') {
    return '';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Anthropic content blocks can carry binary attachments alongside text:
//   { type: 'image',    source: { type: 'base64', media_type, data } }
//   { type: 'document', source: { type: 'base64', media_type, data } }  // PDFs
// Without this helper, the user-message normalizer falls through to
// JSON.stringify(part) and ends up rendering raw base64 as a chat bubble.
function describeAttachmentPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type !== 'image' && part.type !== 'document') return null;

  const source = part.source || {};
  const mediaType =
    typeof source.media_type === 'string'
      ? source.media_type
      : typeof part.media_type === 'string'
        ? part.media_type
        : '';
  const filename =
    typeof part.filename === 'string'
      ? part.filename
      : typeof part.name === 'string'
        ? part.name
        : typeof part.title === 'string'
          ? part.title
          : '';
  const url =
    source.type === 'url' && typeof source.url === 'string' ? source.url : '';

  // Use type-specific glyphs so the user can tell a PDF/document attachment
  // apart from an image at a glance. The generic 📎 paperclip used previously
  // was ambiguous (it implies "attachment" in general but reads identically
  // for any kind of file).
  let icon;
  let label;
  if (part.type === 'image') {
    icon = '🖼';
    label = mediaType ? `Image (${mediaType})` : 'Image';
  } else {
    // document — most commonly application/pdf, but Claude also accepts
    // text/plain, text/markdown, etc. via the document block.
    icon = '📄';
    if (/pdf/i.test(mediaType)) {
      label = 'PDF';
    } else if (mediaType) {
      label = `Document (${mediaType})`;
    } else {
      label = 'Document';
    }
  }

  const detail = filename || url;
  return detail ? `${icon} ${label}: ${detail}` : `${icon} ${label}`;
}

function parseTaskNotification(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return null;
  }

  const outer = content.match(TASK_NOTIFICATION_OUTER);
  if (!outer) {
    return null;
  }

  const body = outer[1];
  const extract = (regex) => {
    const m = body.match(regex);
    return m ? m[1].trim() : '';
  };

  return {
    taskId: extract(TASK_FIELD_REGEX.taskId),
    outputFile: extract(TASK_FIELD_REGEX.outputFile),
    status: extract(TASK_FIELD_REGEX.status),
    summary: extract(TASK_FIELD_REGEX.summary),
  };
}

function formatApiErrorContent(raw) {
  const errorCode =
    raw?.error?.cause?.code ||
    raw?.cause?.code ||
    raw?.error?.code ||
    raw?.code ||
    'unknown';
  const errorPath = raw?.error?.cause?.path || raw?.cause?.path || raw?.path || '';
  const retryAttempt =
    typeof raw?.retryAttempt === 'number' && typeof raw?.maxRetries === 'number'
      ? ` Retry ${raw.retryAttempt}/${raw.maxRetries}.`
      : '';
  const target = errorPath ? ` (${errorPath})` : '';
  return `API error: ${errorCode}${target}.${retryAttempt}`;
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

  // Surface SDK-injected "[Request interrupted by user]" notices as a dedicated
  // message kind so the UI can show a visible divider where the user paused.
  if (isInterruptedNotice(content)) {
    return createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'interrupted',
      content,
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

  // SDK-injected continuation messages (skill briefings, slash-command echoes,
  // PDF page rasterizations fed back to the model, etc.) carry isMeta=true.
  // They are not real user input — hide them from the chat surface, mirroring
  // how we drop synthetic assistant messages in normalizeAssistantMessage.
  if (raw?.isMeta === true && options.sessionKind !== 'background_task') {
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

      const attachmentLabel = describeAttachmentPart(part);
      if (attachmentLabel) {
        const message = createTextMessage({
          id: getBaseId(raw, index),
          sessionId,
          timestamp,
          role: 'user',
          content: attachmentLabel,
        });
        if (message) {
          normalized.push(message);
        }
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
  if (raw?.isApiErrorMessage === true) {
    const timestamp = getTimestamp(raw);
    const content = stringifyContent(raw?.message?.content ?? raw?.content);
    return [createNormalizedMessage({
      id: getBaseId(raw),
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'error',
      content: content.trim() || formatApiErrorContent(raw),
    })];
  }

  // The Claude Agent SDK uses `model: '<synthetic>'` to mark assistant
  // placeholders that it injects to keep the user/assistant turn pairing
  // valid for the API (e.g. `No response requested.` after an interrupted
  // turn, see conversationRecovery in claude-code-main). These have no real
  // model output and would otherwise render as a confusing empty/duplicate
  // assistant bubble alongside our `interrupted` divider, so drop them.
  if (raw?.message?.model === '<synthetic>') {
    return [];
  }

  const content = raw?.message?.content ?? raw?.content ?? '';

  if (Array.isArray(content)) {
    return content.flatMap((part, index) => normalizeContentPart(part, raw, sessionId, index, options));
  }

  return normalizeContentPart(content, raw, sessionId, 0, options);
}

// Claude Agent SDK wraps every Anthropic SSE delta in `{ type: 'stream_event', event }`
// when `includePartialMessages: true` is set. Without unwrapping the inner `event`
// the UI only renders the final assistant message in one shot, so we surface
// `text_delta` parts as `stream_delta` NormalizedMessages here.
function normalizeStreamEvent(raw, sessionId) {
  const inner = raw?.event;
  if (!inner || typeof inner !== 'object') return [];

  const timestamp = getTimestamp(raw);
  const baseId = getBaseId(raw);
  const blockIndex = typeof inner.index === 'number' ? inner.index : 0;

  if (inner.type === 'content_block_delta') {
    const delta = inner.delta;
    if (!delta || typeof delta !== 'object') return [];

    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
      return [createNormalizedMessage({
        id: `${baseId}_${blockIndex}_text`,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        content: delta.text,
      })];
    }
  }

  // Other inner events (message_start / content_block_start / content_block_stop /
  // message_delta / message_stop / thinking_delta / input_json_delta) are not
  // consumed by the current UI streaming path. The final SDKAssistantMessage
  // delivered after `message_stop` already carries the complete content for
  // tool_use / thinking blocks, so dropping them here is safe.
  return [];
}

function normalizeDirectEvent(raw, sessionId, options) {
  const timestamp = getTimestamp(raw);
  const id = getBaseId(raw);

  if (raw.type === 'system' && raw.subtype === 'api_error') {
    return [createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'error',
      content: formatApiErrorContent(raw),
    })];
  }

  if (raw.type === 'stream_event') {
    return normalizeStreamEvent(raw, sessionId);
  }

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
export const edgeclawAdapter = {
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
      normalized.push(...normalizeMessage(raw, sessionId, { sessionKind }));
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
