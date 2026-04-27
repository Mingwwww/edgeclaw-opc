import type { AssistantMessage, UserMessage } from '../types/message.js'

export const FINGERPRINT_SALT = ''

export function extractFirstMessageText(
  _messages: (UserMessage | AssistantMessage)[],
): string {
  return ''
}

export function computeFingerprint(
  _messageText: string,
  _version: string,
): string {
  return '000'
}

export function computeFingerprintFromMessages(
  _messages: (UserMessage | AssistantMessage)[],
): string {
  return '000'
}
