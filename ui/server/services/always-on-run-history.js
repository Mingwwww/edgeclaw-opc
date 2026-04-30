import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getAlwaysOnRoot } from './always-on-paths.js';
import { getAlwaysOnRunLog } from './always-on-run-logs.js';

const RUN_HISTORY_FILE_NAME = 'run-history.jsonl';
const RUN_HISTORY_MAX_ITEMS = 500;
const OUTPUT_LOG_MAX_CHARS = 60_000;
const RECOVERY_MATCH_WINDOW_MS = 5 * 60 * 1000;
const VALID_KINDS = new Set(['plan', 'cron']);
const VALID_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'unknown']);
const TASK_NOTIFICATION_REGEX = /<task-notification>\s*<task-id>([\s\S]*?)<\/task-id>\s*<output-file>([\s\S]*?)<\/output-file>\s*<status>([\s\S]*?)<\/status>\s*<summary>([\s\S]*?)<\/summary>\s*<\/task-notification>/i;
const CRON_TRANSCRIPT_FILENAME_REGEX = /^agent-cron[^/]*\.jsonl$/i;

function normalizeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toIsoTimestamp(value) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function getRunHistoryPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), RUN_HISTORY_FILE_NAME);
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeTranscriptFilename(value) {
  const rawName = path.basename(normalizeString(value));
  if (!rawName) {
    return '';
  }

  const withoutJsonl = rawName.replace(/\.jsonl$/i, '');
  const withAgentPrefix = withoutJsonl.startsWith('agent-')
    ? withoutJsonl
    : `agent-${withoutJsonl}`;
  return `${withAgentPrefix}.jsonl`;
}

function getRecordParentSessionId(record) {
  return record.parentSessionId || normalizeString(record.metadata?.originSessionId) || undefined;
}

function getRecordRelativeTranscriptPath(record) {
  const parentSessionId = getRecordParentSessionId(record);
  const relativeTranscriptPath = normalizeString(record.relativeTranscriptPath);
  const transcriptKey = record.transcriptKey || normalizeString(record.metadata?.transcriptKey);

  if (!parentSessionId) {
    return relativeTranscriptPath || undefined;
  }

  if (relativeTranscriptPath) {
    const dirname = path.dirname(relativeTranscriptPath);
    const normalizedFilename = normalizeTranscriptFilename(path.basename(relativeTranscriptPath));
    if (normalizedFilename) {
      return path.join(dirname === '.' ? parentSessionId : dirname, normalizedFilename);
    }
    return relativeTranscriptPath;
  }

  const transcriptFilename = normalizeTranscriptFilename(transcriptKey);
  if (!transcriptFilename) {
    return undefined;
  }

  return path.join(parentSessionId, 'subagents', transcriptFilename);
}

function createBackgroundSessionId(parentSessionId, relativeTranscriptPath) {
  const safeParent = normalizeString(parentSessionId).replace(/[^a-zA-Z0-9._-]/g, '-');
  const transcriptName = path.basename(normalizeString(relativeTranscriptPath));
  const safeTranscript = transcriptName
    .replace(/\.jsonl$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-');

  if (!safeParent || !safeTranscript) {
    return undefined;
  }

  return `background-${safeParent}-${safeTranscript}`;
}

function getRecordSessionId(record) {
  return record.sessionId || createBackgroundSessionId(
    getRecordParentSessionId(record),
    getRecordRelativeTranscriptPath(record),
  );
}

function getProjectStoreDir(projectName) {
  return projectName ? path.join(os.homedir(), '.claude', 'projects', projectName) : '';
}

function getTaskNotificationEntryContent(entry) {
  if (typeof entry?.content === 'string' && entry.content.trim()) {
    return entry.content;
  }
  return extractContentText(entry?.message?.content);
}

function parseTaskNotificationContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
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

function isRunTaskNotification(record, notification) {
  const sourceId = normalizeString(record.sourceId);
  const taskId = normalizeString(record.metadata?.taskId, sourceId);
  const haystack = [
    notification.taskId,
    notification.outputFile,
    notification.summary,
  ].join('\n');
  return Boolean((sourceId && haystack.includes(sourceId)) || (taskId && haystack.includes(taskId)));
}

function getTranscriptInfoFromPath(projectDir, transcriptPath) {
  const relativeTranscriptPath = path.relative(projectDir, transcriptPath).split(path.sep).join('/');
  const parts = relativeTranscriptPath.split('/');
  if (parts.length < 3 || parts[1] !== 'subagents') {
    return null;
  }
  const parentSessionId = parts[0];
  const transcriptFilename = parts.at(-1) || '';
  if (!parentSessionId || !CRON_TRANSCRIPT_FILENAME_REGEX.test(transcriptFilename)) {
    return null;
  }
  return {
    parentSessionId,
    relativeTranscriptPath,
    transcriptKey: transcriptFilename,
    sessionId: createBackgroundSessionId(parentSessionId, relativeTranscriptPath),
  };
}

function isWithinDirectory(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readJsonlEntries(filePath) {
  let raw = '';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function recoverFromTaskNotification(record, projectName) {
  const parentSessionId = getRecordParentSessionId(record);
  const projectDir = getProjectStoreDir(projectName);
  if (!parentSessionId || !projectDir) {
    return null;
  }

  const parentTranscriptPath = path.join(projectDir, `${parentSessionId}.jsonl`);
  const entries = await readJsonlEntries(parentTranscriptPath);
  for (const entry of entries) {
    if (entry?.sessionId !== parentSessionId) {
      continue;
    }
    const notification = parseTaskNotificationContent(getTaskNotificationEntryContent(entry));
    if (!notification || !isRunTaskNotification(record, notification) || !notification.outputFile) {
      continue;
    }

    const outputPath = path.resolve(notification.outputFile);
    let realOutputPath = outputPath;
    try {
      realOutputPath = await fs.realpath(outputPath);
    } catch {
      // Symlink targets may already be cleaned up; fall back to the requested path.
    }
    const transcriptPath = realOutputPath.endsWith('.output')
      ? realOutputPath.replace(/\.output$/i, '.jsonl')
      : realOutputPath;
    const realTranscriptPath = await fs.realpath(transcriptPath).catch(() => transcriptPath);
    if (!isWithinDirectory(projectDir, realTranscriptPath)) {
      continue;
    }
    const info = getTranscriptInfoFromPath(projectDir, realTranscriptPath);
    if (info) {
      return {
        ...info,
        taskId: notification.taskId,
        taskStatus: notification.status,
        outputFile: notification.outputFile,
      };
    }
  }

  return null;
}

function isTimestampNearRun(record, timestamps) {
  const runStart = Date.parse(record.startedAt || '');
  const runFinish = Date.parse(record.finishedAt || record.updatedAt || '');
  const anchors = [runStart, runFinish].filter(Number.isFinite);
  if (anchors.length === 0) {
    return false;
  }
  return timestamps.some(timestamp => anchors.some(anchor => Math.abs(timestamp - anchor) <= RECOVERY_MATCH_WINDOW_MS));
}

async function recoverFromSubagents(record, projectName) {
  const parentSessionId = getRecordParentSessionId(record);
  const projectDir = getProjectStoreDir(projectName);
  if (!parentSessionId || !projectDir) {
    return null;
  }

  const subagentsDir = path.join(projectDir, parentSessionId, 'subagents');
  let entries = [];
  try {
    entries = await fs.readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !CRON_TRANSCRIPT_FILENAME_REGEX.test(entry.name)) {
      continue;
    }
    const transcriptPath = path.join(subagentsDir, entry.name);
    const transcriptEntries = await readJsonlEntries(transcriptPath);
    const timestamps = transcriptEntries
      .map(item => Date.parse(item?.timestamp || ''))
      .filter(Number.isFinite);
    if (!isTimestampNearRun(record, timestamps)) {
      continue;
    }
    const info = getTranscriptInfoFromPath(projectDir, transcriptPath);
    if (info) {
      candidates.push({
        ...info,
        distance: Math.min(
          ...timestamps.map(timestamp => Math.abs(timestamp - (Date.parse(record.startedAt || '') || timestamp))),
        ),
      });
    }
  }

  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0] || null;
}

async function recoverRecordSessionInfo(record, projectName) {
  if (getRecordSessionId(record) && getRecordRelativeTranscriptPath(record)) {
    return {
      sessionId: getRecordSessionId(record),
      parentSessionId: getRecordParentSessionId(record),
      relativeTranscriptPath: getRecordRelativeTranscriptPath(record),
      transcriptKey: record.transcriptKey || normalizeString(record.metadata?.transcriptKey) || undefined,
    };
  }
  return (
    await recoverFromTaskNotification(record, projectName) ||
    await recoverFromSubagents(record, projectName) ||
    {
      sessionId: undefined,
      parentSessionId: getRecordParentSessionId(record),
      relativeTranscriptPath: getRecordRelativeTranscriptPath(record),
      transcriptKey: record.transcriptKey || normalizeString(record.metadata?.transcriptKey) || undefined,
    }
  );
}

function normalizeRunEvent(event) {
  const runId = normalizeString(event?.runId);
  const kind = normalizeString(event?.kind);
  const status = normalizeString(event?.status);
  const sourceId = normalizeString(event?.sourceId);

  if (!runId || !VALID_KINDS.has(kind) || !VALID_STATUSES.has(status) || !sourceId) {
    return null;
  }

  const timestamp = toIsoTimestamp(event?.timestamp) || new Date().toISOString();

  return {
    runId,
    projectRoot: normalizeString(event?.projectRoot),
    kind,
    sourceId,
    title: normalizeString(event?.title, sourceId),
    status,
    timestamp,
    startedAt: toIsoTimestamp(event?.startedAt) || undefined,
    finishedAt: toIsoTimestamp(event?.finishedAt) || undefined,
    sessionId: normalizeString(event?.sessionId) || undefined,
    parentSessionId: normalizeString(event?.parentSessionId) || undefined,
    relativeTranscriptPath: normalizeString(event?.relativeTranscriptPath) || undefined,
    transcriptKey: normalizeString(event?.transcriptKey) || undefined,
    output: normalizeString(event?.output) || undefined,
    error: normalizeString(event?.error) || undefined,
    metadata: sanitizeMetadata(event?.metadata),
  };
}

function mergeRunEvent(record, event) {
  const metadata = {
    ...(record.metadata || {}),
    ...(event.metadata || {}),
  };

  const next = {
    ...record,
    title: event.title || record.title,
    status: event.status || record.status,
    updatedAt: event.timestamp || record.updatedAt,
    startedAt: event.startedAt || record.startedAt || event.timestamp,
    finishedAt: event.finishedAt || record.finishedAt,
    sessionId: event.sessionId || record.sessionId,
    parentSessionId: event.parentSessionId || record.parentSessionId,
    relativeTranscriptPath: event.relativeTranscriptPath || record.relativeTranscriptPath,
    transcriptKey: event.transcriptKey || record.transcriptKey,
    metadata,
  };

  const outputParts = [record.outputLog, event.output, event.error ? `Error: ${event.error}` : '']
    .filter(Boolean);
  next.outputLog = outputParts.join('\n\n').slice(-OUTPUT_LOG_MAX_CHARS);

  if (event.error) {
    next.error = event.error;
  }

  return next;
}

function createRecordFromEvent(event) {
  return mergeRunEvent({
    runId: event.runId,
    kind: event.kind,
    sourceId: event.sourceId,
    title: event.title,
    status: event.status,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    startedAt: event.startedAt || event.timestamp,
    finishedAt: event.finishedAt,
    sessionId: event.sessionId,
    parentSessionId: event.parentSessionId,
    relativeTranscriptPath: event.relativeTranscriptPath,
    transcriptKey: event.transcriptKey,
    metadata: {},
    outputLog: '',
  }, event);
}

function toHistoryEntry(record, sessionInfo = null) {
  const sessionId = sessionInfo?.sessionId || getRecordSessionId(record);
  const parentSessionId = sessionInfo?.parentSessionId || getRecordParentSessionId(record);
  const relativeTranscriptPath = sessionInfo?.relativeTranscriptPath || getRecordRelativeTranscriptPath(record);

  return {
    runId: record.runId,
    title: record.title,
    kind: record.kind,
    status: record.status,
    startedAt: record.startedAt,
    sourceId: record.sourceId,
    session: {
      sessionId,
      parentSessionId,
      relativeTranscriptPath,
    },
  };
}

function extractContentText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content?.text === 'string') {
    return content.text;
  }
  return '';
}

function formatMessageForLog(entry) {
  const role = normalizeString(entry?.message?.role || entry?.type || entry?.role, 'message');
  const content = extractContentText(entry?.message?.content ?? entry?.content).trim();
  if (!content) {
    return '';
  }
  const timestamp = toIsoTimestamp(entry?.timestamp);
  const prefix = timestamp ? `[${timestamp}] ${role}` : role;
  return `${prefix}\n${content}`;
}

async function buildSessionOutputLog(projectName, record, sessionInfo = null) {
  const sessionId = sessionInfo?.sessionId || getRecordSessionId(record);
  const parentSessionId = sessionInfo?.parentSessionId || getRecordParentSessionId(record);
  const relativeTranscriptPath = sessionInfo?.relativeTranscriptPath || getRecordRelativeTranscriptPath(record);

  if (!projectName || !sessionId) {
    return '';
  }

  try {
    const { getSessionMessages } = await import('../projects.js');
    const result = await getSessionMessages(projectName, sessionId, {
      limit: null,
      offset: 0,
      sessionKind: parentSessionId && relativeTranscriptPath ? 'background_task' : null,
      parentSessionId,
      relativeTranscriptPath,
    });
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    return messages
      .map(formatMessageForLog)
      .filter(Boolean)
      .join('\n\n')
      .slice(-OUTPUT_LOG_MAX_CHARS);
  } catch (error) {
    return '';
  }
}

async function readRunHistoryRecords(projectRoot) {
  let raw = '';
  try {
    raw = await fs.readFile(getRunHistoryPath(projectRoot), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const recordsById = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const event = normalizeRunEvent(JSON.parse(line));
      if (!event) {
        continue;
      }
      const existing = recordsById.get(event.runId);
      recordsById.set(
        event.runId,
        existing ? mergeRunEvent(existing, event) : createRecordFromEvent(event),
      );
    } catch {
      // Concurrent appends or manual edits can leave bad lines; ignore them.
    }
  }

  return [...recordsById.values()].sort((left, right) => {
    const leftTime = Date.parse(left.startedAt || left.updatedAt || left.createdAt || '') || 0;
    const rightTime = Date.parse(right.startedAt || right.updatedAt || right.createdAt || '') || 0;
    return rightTime - leftTime;
  });
}

export async function appendAlwaysOnRunEvent(projectRoot, event) {
  const normalized = normalizeRunEvent({
    ...event,
    projectRoot,
  });
  if (!normalized) {
    return null;
  }

  await fs.mkdir(getAlwaysOnRoot(projectRoot), { recursive: true });
  await fs.appendFile(getRunHistoryPath(projectRoot), `${JSON.stringify(normalized)}\n`, 'utf8');
  return normalized;
}

export async function getAlwaysOnRunHistory(projectRoot, { limit = RUN_HISTORY_MAX_ITEMS, projectName = '' } = {}) {
  const records = (await readRunHistoryRecords(projectRoot)).filter(
    (record) => record.status !== 'unknown',
  );
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : RUN_HISTORY_MAX_ITEMS;
  const slicedRecords = records.slice(0, safeLimit);
  const entries = await Promise.all(
    slicedRecords.map(async (record) => toHistoryEntry(
      record,
      projectName ? await recoverRecordSessionInfo(record, projectName) : null,
    )),
  );
  return {
    runs: entries,
  };
}

export async function getAlwaysOnRunHistoryDetail(projectRoot, runId, { projectName = '' } = {}) {
  const records = await readRunHistoryRecords(projectRoot);
  const record = records.find((candidate) => candidate.runId === runId);
  if (!record) {
    const error = new Error('Run history entry not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const sessionInfo = await recoverRecordSessionInfo(record, projectName);
  const sessionOutput = await buildSessionOutputLog(projectName, record, sessionInfo);
  const fileLog = await getAlwaysOnRunLog(projectRoot, runId);
  const outputLog = fileLog.content || sessionOutput || record.outputLog || record.error || '';
  const logSource = fileLog.content ? 'log-file' : (sessionOutput ? 'session' : 'history');
  const sessionId = sessionInfo?.sessionId || getRecordSessionId(record);
  const parentSessionId = sessionInfo?.parentSessionId || getRecordParentSessionId(record);
  const relativeTranscriptPath = sessionInfo?.relativeTranscriptPath || getRecordRelativeTranscriptPath(record);
  return {
    ...toHistoryEntry(record, sessionInfo),
    outputLog,
    metadata: {
      ...record.metadata,
      runId: record.runId,
      sourceId: record.sourceId,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      sessionId: sessionId ?? null,
      parentSessionId,
      relativeTranscriptPath,
      transcriptKey: sessionInfo?.transcriptKey || record.transcriptKey || normalizeString(record.metadata?.transcriptKey) || undefined,
      taskId: record.metadata?.taskId,
      runtimeTaskId: sessionInfo?.taskId,
      taskStatus: sessionInfo?.taskStatus,
      outputFile: sessionInfo?.outputFile,
      logSource,
      logUpdatedAt: fileLog.updatedAt,
      logSize: fileLog.size,
      logTruncated: fileLog.truncated,
    },
  };
}

export {
  getRunHistoryPath,
  readRunHistoryRecords,
};
