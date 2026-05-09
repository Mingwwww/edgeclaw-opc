/**
 * Shared provider utilities.
 *
 * @module providers/utils
 */

/**
 * Prefixes that indicate internal/system content which should be hidden from the UI.
 * @type {readonly string[]}
 */
export const INTERNAL_CONTENT_PREFIXES = Object.freeze([
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<system-reminder>',
  'Caveat:',
  'This session is being continued from a previous',
  '[Request interrupted',
  'Always-On execution for project',
  'Always-On discovery planning for project',
  'Always-On 主动发现规划',
]);

/**
 * Matches any XML-tag-like opener at the very start of the content, e.g.
 *   <command-name>, <system-reminder>, <task-notification>, <new-diagnostics>,
 *   <mcp-resource server="..." ...>, <local-command-stdout>, etc.
 *
 * Real human input almost never starts with `<tag>` — code snippets are
 * normally wrapped in backticks — so this is a safe catch-all for "unknown
 * system content injected as a user message" that predates this file's
 * hardcoded prefix list.
 */
const INTERNAL_XML_TAG_OPENER = /^<[a-z][a-z0-9-]*(?:\s[^>]*)?>/i;

/**
 * Check if user text content is internal/system that should be skipped.
 *
 * Hides anything that:
 *   1. Starts with a known internal prefix (exact strings like `Caveat:`), OR
 *   2. Opens with an XML-like tag (`<command-name>`, `<system-reminder>`, …)
 *
 * Rule (2) is a deliberate catch-all: the Claude Code SDK and future skills
 * keep adding new `<foo-bar>` wrappers for system-injected user messages, and
 * we don't want those leaking into the chat as fake user bubbles just because
 * they haven't been explicitly whitelisted here.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isInternalContent(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return false;
  }
  if (INTERNAL_CONTENT_PREFIXES.some(prefix => content.startsWith(prefix))) {
    return true;
  }
  return INTERNAL_XML_TAG_OPENER.test(content);
}

/**
 * Detect the SDK-injected "[Request interrupted by user ...]" follow-up that
 * Claude Agents writes into the conversation history right after the user
 * presses the pause button. We surface these as an explicit `interrupted`
 * NormalizedMessage so the UI can render a divider, instead of letting them
 * fall through `isInternalContent` and disappear entirely.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isInterruptedNotice(content) {
  return typeof content === 'string' && content.startsWith('[Request interrupted');
}

/**
 * Detect the Claude Code CLI slash-command "metadata" envelope that the SDK
 * emits whenever a user runs `/foo` in the REPL. It looks like:
 *
 *   <command-message>foo</command-message>
 *   <command-name>/foo</command-name>
 *   [optional <command-args>…</command-args>]
 *
 * This content is internal (it would otherwise render as a blank/garbled user
 * bubble in the UI), but it is also the only surviving record of what the user
 * typed — the original `/foo` input is replaced by this metadata + a separate
 * `isMeta: true` skill-output message. We return the user-visible slash
 * command string so callers can surface a clean "/foo arg1 arg2" bubble.
 *
 * @param {string} content
 * @returns {string|null} The reconstructed slash command (e.g. "/projects"),
 *   or null if the content is not a slash-command metadata envelope.
 */
export function extractSlashCommandInvocation(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return null;
  }
  // Must be the metadata envelope — starts with <command-message> or <command-name>
  if (!content.startsWith('<command-message>') && !content.startsWith('<command-name>')) {
    return null;
  }
  const nameMatch = content.match(/<command-name>([^<]+)<\/command-name>/);
  if (!nameMatch) {
    return null;
  }
  const name = nameMatch[1].trim();
  if (!name) {
    return null;
  }
  const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch ? argsMatch[1].trim() : '';
  const slash = name.startsWith('/') ? name : `/${name}`;
  return args ? `${slash} ${args}` : slash;
}
