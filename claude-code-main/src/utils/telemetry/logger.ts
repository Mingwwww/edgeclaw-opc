import type { DiagLogger } from '@opentelemetry/api'

export class ClaudeCodeDiagLogger implements DiagLogger {
  error(..._: unknown[]): void {}
  warn(..._: unknown[]): void {}
  info(..._: unknown[]): void {}
  debug(..._: unknown[]): void {}
  verbose(..._: unknown[]): void {}
}
