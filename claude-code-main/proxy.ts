/**
 * Local proxy: Anthropic API format ↔ OpenAI API format
 *
 * Dual-mode entry point:
 *   1. CCR mode  — delegates to the embedded Claude Code Router pipeline
 *                  (multi-provider routing, tokenSaver, autoOrchestrate, etc.)
 *   2. Direct mode — simple Anthropic→provider conversion + single upstream forward
 *
 * Router enablement and provider settings are derived from ~/.edgeclaw/config.yaml.
 */

import { readdirSync, statSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'node:url'
import { get_encoding } from 'tiktoken'
import {
  applyEdgeClawConfigToEnv,
  buildCcrConfigFromEdgeClawConfig,
  type EdgeClawConfig,
  getEdgeClawConfigPath,
  getEdgeClawProxyModel,
  loadEdgeClawConfig,
} from './edgeclaw-config'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DIR = __dirname

const EDGECLAW_CONFIG: EdgeClawConfig = loadEdgeClawConfig()
applyEdgeClawConfigToEnv(EDGECLAW_CONFIG)

// Propagate HTTPS proxy from YAML / env so Bun's native fetch honours it
const _httpsProxy = (EDGECLAW_CONFIG as any)?.runtime?.httpsProxy
  || EDGECLAW_CONFIG?.router?.httpsProxy
  || process.env.HTTPS_PROXY
  || process.env.https_proxy
  || ''
if (_httpsProxy) {
  process.env.HTTPS_PROXY = _httpsProxy
  process.env.https_proxy = _httpsProxy
}

const EDGECLAW_MODEL = getEdgeClawProxyModel(EDGECLAW_CONFIG)
if (!EDGECLAW_MODEL?.provider.baseUrl || !EDGECLAW_MODEL.provider.apiKey || !EDGECLAW_MODEL.model) {
  throw new Error(`[proxy] Missing required provider/model settings in ${getEdgeClawConfigPath()}`)
}

const UPSTREAM_URL = EDGECLAW_MODEL.provider.baseUrl
const UPSTREAM_KEY = EDGECLAW_MODEL.provider.apiKey
const UPSTREAM_TYPE = EDGECLAW_MODEL.provider.type || 'openai-chat'
const UPSTREAM_HEADERS = EDGECLAW_MODEL.provider.headers || {}
const PORT = parseInt(process.env.PROXY_PORT || '18080', 10)

// Tiktoken encoder for fallback token counting when providers don't report usage
const tiktokenEncoder = get_encoding('o200k_base')

// OpenRouter app attribution. Only injected when the upstream is openrouter.ai
// so we don't leak the header through unrelated upstreams.
const IS_OPENROUTER_UPSTREAM = (() => {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(UPSTREAM_URL).hostname)
  } catch {
    return false
  }
})()
const ATTRIBUTION_HEADERS: Record<string, string> = IS_OPENROUTER_UPSTREAM
  ? {
      'HTTP-Referer': 'https://edgeclaw.ai',
      'X-Title': 'EdgeClaw',
      'X-OpenRouter-Title': 'EdgeClaw',
      'X-OpenRouter-Categories': 'cli-agent',
    }
  : {}

function joinEndpoint(baseUrl: string, endpoint: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith(endpoint)) return normalized
  return `${normalized}${endpoint}`
}

function providerChatUrl(): string {
  if (UPSTREAM_TYPE === 'anthropic') return joinEndpoint(UPSTREAM_URL, '/v1/messages')
  if (UPSTREAM_TYPE === 'openai-responses') return joinEndpoint(UPSTREAM_URL, '/responses')
  return joinEndpoint(UPSTREAM_URL, '/chat/completions')
}

// ─── CCR (Claude Code Router) integration ───

interface CCRServices {
  configService: any
  providerService: any
  transformerService: any
  tokenizerService: any
  logger: any
}

let ccrProcessRequest: ((url: string, init: RequestInit | undefined, services: CCRServices, realFetch: typeof fetch) => Promise<Response>) | null = null
let ccrServices: CCRServices | null = null
let ccrModule: any = null

const ROUTER_DIR = resolve(DIR, 'src/router')
const CJS_PATH = resolve(ROUTER_DIR, 'server.cjs')

function newestMtime(dir: string, ext = '.ts'): number {
  let newest = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full, ext))
      else if (entry.name.endsWith(ext)) newest = Math.max(newest, statSync(full).mtimeMs)
    }
  } catch {}
  return newest
}

function ensureCjsBuilt(): boolean {
  const buildScript = resolve(ROUTER_DIR, 'build.mjs')
  if (existsSync(resolve(ROUTER_DIR, 'src/server.ts')) && existsSync(buildScript)) {
    const cjsMtime = existsSync(CJS_PATH) ? statSync(CJS_PATH).mtimeMs : 0
    const srcMtime = Math.max(
      newestMtime(resolve(ROUTER_DIR, 'src')),
      newestMtime(resolve(ROUTER_DIR, 'shared')),
    )
    if (srcMtime > cjsMtime || cjsMtime === 0) {
      console.log('[proxy] CCR source newer than bundle — rebuilding...')
      execSync('node build.mjs', { cwd: ROUTER_DIR, stdio: 'inherit' })
      console.log('[proxy] CCR rebuild complete')
    }
  }
  return existsSync(CJS_PATH)
}

async function loadCCR(): Promise<boolean> {
  if (!EDGECLAW_CONFIG?.router?.enabled) return false
  if (!ensureCjsBuilt()) return false

  const config = buildCcrConfigFromEdgeClawConfig(EDGECLAW_CONFIG)
  if (!ccrModule) ccrModule = require(CJS_PATH)
  const Server = ccrModule.default

  const server = new Server({
    initialConfig: {
      providers: config.Providers,
      Router: config.Router,
      tokenStats: config.tokenStats,
      API_TIMEOUT_MS: config.API_TIMEOUT_MS,
      HOST: '127.0.0.1',
      PORT: 0,
      LOG: config.LOG ?? false,
    },
    logger: config.LOG !== false && process.env.CCR_LOG === '1',
  })

  await server.init()

  ccrProcessRequest = ccrModule.processRequest
  ccrServices = {
    configService: server.configService,
    providerService: server.providerService,
    transformerService: server.transformerService,
    tokenizerService: server.tokenizerService,
    logger: process.env.CCR_LOG === '1' ? undefined : {
      info: () => {},
      warn: (...a: any[]) => console.warn('[CCR]', ...a),
      error: (...a: any[]) => console.error('[CCR]', ...a),
      debug: () => {},
    },
  }
  return true
}

// Initial load
if (process.env.CCR_DISABLED !== '1' && process.env.CCR_DISABLED !== 'true') {
  try {
    if (await loadCCR()) {
      console.log('[proxy] CCR router loaded — advanced routing enabled')
    }
  } catch (err: any) {
    console.warn(`[proxy] CCR unavailable (${err.message}), using direct proxy mode`)
  }
}

let ccrEnabled = ccrProcessRequest !== null && ccrServices !== null

// ─── Request conversion: Anthropic → OpenAI ───

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: unknown
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: unknown
}

interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string | Array<{ type: string; text: string }>
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: unknown
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  metadata?: unknown
  thinking?: unknown
  [key: string]: unknown
}

function flattenContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('')
}

function convertMessages(
  messages: AnthropicMessage[],
  system?: string | Array<{ type: string; text: string }>,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []

  // System prompt → first message
  if (system) {
    const systemText =
      typeof system === 'string'
        ? system
        : system.map(s => s.text).join('\n')
    result.push({ role: 'system', content: systemText })
  }

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content })
        continue
      }

      // Assistant with content blocks (may contain text + tool_use)
      const textParts: string[] = []
      const toolCalls: Array<Record<string, unknown>> = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text || '')
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments:
                typeof block.input === 'string'
                  ? block.input
                  : JSON.stringify(block.input ?? {}),
            },
          })
        }
        // Skip thinking blocks — OpenAI format doesn't support them
      }

      const assistantMsg: Record<string, unknown> = { role: 'assistant' }
      if (textParts.length > 0) assistantMsg.content = textParts.join('')
      else assistantMsg.content = null
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      result.push(assistantMsg)
    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content })
        continue
      }

      // User with content blocks — may contain tool_result
      const toolResults: AnthropicContentBlock[] = []
      const otherBlocks: AnthropicContentBlock[] = []

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResults.push(block)
        } else {
          otherBlocks.push(block)
        }
      }

      // Emit tool result messages first (OpenAI requires role=tool)
      for (const tr of toolResults) {
        let content: string
        if (typeof tr.content === 'string') {
          content = tr.content
        } else if (Array.isArray(tr.content)) {
          content = flattenContent(tr.content)
        } else {
          content = ''
        }
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content,
        })
      }

      // Then any remaining user content
      if (otherBlocks.length > 0) {
        const hasImages = otherBlocks.some(b => b.type === 'image')
        if (hasImages) {
          // Multimodal: keep as content array
          const parts = otherBlocks.map(b => {
            if (b.type === 'text') return { type: 'text', text: b.text }
            if (b.type === 'image' && b.source) {
              const src = b.source as Record<string, string>
              return {
                type: 'image_url',
                image_url: {
                  url: `data:${src.media_type};base64,${src.data}`,
                },
              }
            }
            return { type: 'text', text: '' }
          })
          result.push({ role: 'user', content: parts })
        } else {
          result.push({
            role: 'user',
            content: flattenContent(otherBlocks),
          })
        }
      }
    }
  }

  return result
}

function convertTools(
  tools?: AnthropicTool[],
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }))
}

const MODEL_MAP: Record<string, string> = {
  'claude-opus-4-6':            'anthropic/claude-opus-4.6',
  'claude-sonnet-4-6':          'anthropic/claude-sonnet-4.6',
  'claude-opus-4-5':            'anthropic/claude-opus-4.5',
  'claude-sonnet-4-5':          'anthropic/claude-sonnet-4.5',
  'claude-haiku-4-5':           'anthropic/claude-haiku-4.5',
  'claude-opus-4':              'anthropic/claude-opus-4',
  'claude-sonnet-4':            'anthropic/claude-sonnet-4',
  'claude-3-7-sonnet':          'anthropic/claude-3.7-sonnet',
  'claude-3-5-sonnet':          'anthropic/claude-3.5-sonnet',
  'claude-3-5-haiku':           'anthropic/claude-3.5-haiku',
  'claude-3-haiku':             'anthropic/claude-3-haiku',
}

// In direct (non-CCR) mode the YAML's agents.main.model is the single source
// of truth. Any incoming body.model from the SDK is overridden so a stale
// localStorage selection (e.g. "opus") can't bypass the configured upstream.
// Set EDGECLAW_RESPECT_REQUEST_MODEL=1 to fall back to legacy behavior.
const FORCE_UPSTREAM_MODEL = process.env.EDGECLAW_RESPECT_REQUEST_MODEL !== '1'

function toUpstreamModel(model: string): string {
  if (FORCE_UPSTREAM_MODEL) return EDGECLAW_MODEL.model

  const normalized = model.trim()
  if (!normalized) return normalized
  if (!IS_OPENROUTER_UPSTREAM) return normalized
  if (normalized.includes('/')) return normalized

  const stripped = normalized.replace(/-\d{8}$/, '')
  if (MODEL_MAP[normalized]) return MODEL_MAP[normalized]
  if (MODEL_MAP[stripped]) return MODEL_MAP[stripped]
  return `anthropic/${stripped}`
}

// ─── Request conversion: OpenAI → Anthropic (for /chat/completions → CCR) ───

function convertOpenAIRequestToAnthropic(oai: Record<string, unknown>): Record<string, unknown> {
  const messages = oai.messages as Array<Record<string, unknown>> || []
  const systemMsgs: string[] = []
  const anthropicMsgs: Array<Record<string, unknown>> = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMsgs.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))
    } else if (msg.role === 'tool') {
      anthropicMsgs.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        }],
      })
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      const content: unknown[] = []
      if (msg.content) content.push({ type: 'text', text: msg.content })
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, string>
        let input: unknown = {}
        try { input = JSON.parse(fn.arguments || '{}') } catch { input = { raw: fn.arguments } }
        content.push({ type: 'tool_use', id: tc.id, name: fn.name, input })
      }
      anthropicMsgs.push({ role: 'assistant', content })
    } else {
      anthropicMsgs.push({ role: msg.role as string, content: msg.content })
    }
  }

  // Ensure metadata with session_id exists for CCR stats collection.
  // Prefer: explicit metadata > OpenAI `user` field > X-Session-Id header > fallback.
  let metadata = oai.metadata as Record<string, unknown> | undefined
  if (!metadata?.user_id) {
    const sessionId = (oai.user as string) || (oai._sessionId as string) || `chat-completions-${Date.now()}`
    metadata = { ...metadata, user_id: JSON.stringify({ session_id: sessionId }) }
  }

  const result: Record<string, unknown> = {
    model: oai.model,
    max_tokens: oai.max_tokens || oai.max_completion_tokens || 4096,
    messages: anthropicMsgs,
    stream: oai.stream ?? false,
    metadata,
  }
  if (systemMsgs.length > 0) result.system = systemMsgs.join('\n')
  if (oai.temperature !== undefined) result.temperature = oai.temperature
  if (oai.top_p !== undefined) result.top_p = oai.top_p
  if (oai.tools) {
    result.tools = (oai.tools as Array<Record<string, unknown>>).map(t => {
      const fn = t.function as Record<string, unknown>
      return { name: fn.name, description: fn.description, input_schema: fn.parameters }
    })
  }
  return result
}

async function convertAnthropicResponseToOpenAI(resp: Response): Promise<Response> {
  const contentType = resp.headers.get('content-type') || ''

  if (contentType.includes('text/event-stream')) {
    // Streaming: convert Anthropic SSE → OpenAI SSE
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let model = ''
    let buffer = ''

    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
          return
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            continue
          }
          try {
            const evt = JSON.parse(data)
            if (evt.type === 'message_start' && evt.message) {
              model = evt.message.model || ''
              continue
            }
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                model,
                choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }],
              }
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
            if (evt.type === 'message_delta') {
              const chunk: Record<string, unknown> = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                model,
                choices: [{ index: 0, delta: {}, finish_reason: evt.delta?.stop_reason === 'end_turn' ? 'stop' : evt.delta?.stop_reason || 'stop' }],
              }
              if (evt.usage) {
                chunk.usage = {
                  prompt_tokens: evt.usage.input_tokens || 0,
                  completion_tokens: evt.usage.output_tokens || 0,
                  total_tokens: (evt.usage.input_tokens || 0) + (evt.usage.output_tokens || 0),
                }
              }
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
          } catch { /* skip unparseable lines */ }
        }
      },
    })

    return new Response(stream, {
      status: resp.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  // Non-streaming: convert Anthropic JSON → OpenAI JSON
  const anthResp = await resp.json() as Record<string, unknown>
  const content = (anthResp.content as Array<Record<string, string>> || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('')
  const usage = anthResp.usage as Record<string, number> || {}
  const toolUseBlocks = (anthResp.content as Array<Record<string, unknown>> || [])
    .filter(c => c.type === 'tool_use')
  const toolCalls = toolUseBlocks.length > 0
    ? toolUseBlocks.map(t => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
      }))
    : undefined

  const oaiResp = {
    id: anthResp.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    model: anthResp.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: anthResp.stop_reason === 'end_turn' ? 'stop' : (anthResp.stop_reason || 'stop'),
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  }

  return new Response(JSON.stringify(oaiResp), {
    status: resp.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

function buildOpenAIRequest(body: AnthropicRequest): Record<string, unknown> {
  const req: Record<string, unknown> = {
    model: toUpstreamModel(body.model),
    max_tokens: body.max_tokens,
    messages: convertMessages(body.messages, body.system),
    stream: body.stream ?? false,
  }

  const tools = convertTools(body.tools)
  if (tools) req.tools = tools
  if (body.temperature !== undefined) req.temperature = body.temperature
  if (body.top_p !== undefined) req.top_p = body.top_p
  if (body.stop_sequences) req.stop = body.stop_sequences

  if (body.stream) {
    req.stream_options = { include_usage: true }
  }

  return req
}

// ─── Response conversion: OpenAI → Anthropic ───

function generateId(): string {
  return 'msg_' + Math.random().toString(36).slice(2, 14)
}

function convertNonStreamingResponse(
  oaiResp: Record<string, unknown>,
  model: string,
  requestBody?: Record<string, unknown>,
): Record<string, unknown> {
  const choices = oaiResp.choices as Array<Record<string, unknown>>
  const choice = choices?.[0] || {}
  const message = choice.message as Record<string, unknown>
  const usage = oaiResp.usage as Record<string, number>

  const content: unknown[] = []

  // Text content
  if (message?.content) {
    content.push({ type: 'text', text: message.content })
  }

  // Tool calls
  if (message?.tool_calls) {
    for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
      const fn = tc.function as Record<string, string>
      let input: unknown = {}
      try {
        input = JSON.parse(fn.arguments || '{}')
      } catch {
        input = { raw: fn.arguments }
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: fn.name,
        input,
      })
    }
  }

  const finishReason = choice.finish_reason as string
  let stopReason = 'end_turn'
  if (finishReason === 'tool_calls') stopReason = 'tool_use'
  else if (finishReason === 'length' || finishReason === 'max_tokens')
    stopReason = 'max_tokens'
  else if (finishReason === 'stop') stopReason = 'end_turn'

  let inputTokens = usage?.prompt_tokens || 0
  let outputTokens = usage?.completion_tokens || 0
  if (inputTokens === 0 && outputTokens === 0 && requestBody) {
    inputTokens = tiktokenEncoder.encode(JSON.stringify(requestBody)).length
    const outputText = (message?.content as string) || ''
    outputTokens = outputText ? tiktokenEncoder.encode(outputText).length : 1
    console.log(`[proxy] tiktoken fallback (non-stream): in=${inputTokens} out=${outputTokens} model=${model}`)
  }

  return {
    id: (oaiResp.id as string) || generateId(),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      speed: undefined,
      inference_geo: undefined,
    },
  }
}

// ─── Streaming conversion ───

class StreamConverter {
  private id: string
  private model: string
  private contentIndex = 0
  private currentToolId: string | null = null
  private currentToolName: string | null = null
  private hasStarted = false
  private hasTextBlock = false
  private activeToolIndices = new Map<number, { id: string; name: string }>()
  private inputTokens = 0
  private outputTokens = 0
  private pendingFinish: string | null = null // deferred stop_reason until usage arrives
  private finished = false
  private requestBodyJson: string
  private collectedOutput = ''

  constructor(model: string, requestBody: Record<string, unknown>) {
    this.id = generateId()
    this.model = model
    this.requestBodyJson = JSON.stringify(requestBody)
    // Pre-compute input tokens from request body so message_start has a
    // valid value even if the provider never reports usage
    this.inputTokens = tiktokenEncoder.encode(this.requestBodyJson).length
  }

  /** Emit the message_start event */
  private messageStart(): string {
    this.hasStarted = true
    const event = {
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: { web_search_requests: 0 },
          service_tier: 'standard',
        },
      },
    }
    return `event: message_start\ndata: ${JSON.stringify(event)}\n\n`
  }

  private startTextBlock(): string {
    this.hasTextBlock = true
    const event = {
      type: 'content_block_start',
      index: this.contentIndex,
      content_block: { type: 'text', text: '' },
    }
    return `event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`
  }

  private textDelta(text: string): string {
    const event = {
      type: 'content_block_delta',
      index: this.contentIndex,
      delta: { type: 'text_delta', text },
    }
    return `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`
  }

  private stopBlock(index: number): string {
    const event = { type: 'content_block_stop', index }
    return `event: content_block_stop\ndata: ${JSON.stringify(event)}\n\n`
  }

  private startToolBlock(id: string, name: string): string {
    const event = {
      type: 'content_block_start',
      index: this.contentIndex,
      content_block: { type: 'tool_use', id, name, input: {} },
    }
    return `event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`
  }

  private toolInputDelta(json: string): string {
    const event = {
      type: 'content_block_delta',
      index: this.contentIndex,
      delta: { type: 'input_json_delta', partial_json: json },
    }
    return `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`
  }

  /** Emit the deferred message_delta + message_stop with final usage */
  private emitFinish(): string {
    if (this.finished || !this.pendingFinish) return ''
    this.finished = true

    const deltaEvent = {
      type: 'message_delta',
      delta: { stop_reason: this.pendingFinish, stop_sequence: null },
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    }
    let out = `event: message_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`
    out += `event: message_stop\ndata: {"type":"message_stop"}\n\n`
    return out
  }

  /** Convert a single OpenAI SSE chunk to Anthropic SSE events */
  convert(chunk: Record<string, unknown>): string {
    let output = ''

    // Handle usage info (may come in a usage-only final chunk)
    // Provider-reported values override tiktoken pre-computation
    if (chunk.usage) {
      const usage = chunk.usage as Record<string, number>
      if (usage.prompt_tokens) this.inputTokens = usage.prompt_tokens
      if (usage.completion_tokens) this.outputTokens = usage.completion_tokens
    }

    if (!this.hasStarted) {
      output += this.messageStart()
    }

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined

    // Usage-only chunk (no choices) — emit deferred finish now that we have token counts
    if (!choices || choices.length === 0) {
      if (this.pendingFinish && !this.finished) {
        output += this.emitFinish()
      }
      return output
    }

    const delta = choices[0]!.delta as Record<string, unknown> | undefined
    const finishReason = choices[0]!.finish_reason as string | null

    if (delta) {
      // Text content — skip empty strings to avoid confusing the SDK
      if (delta.content !== undefined && delta.content !== null && delta.content !== '') {
        this.collectedOutput += delta.content as string
        if (!this.hasTextBlock) {
          output += this.startTextBlock()
        }
        output += this.textDelta(delta.content as string)
      }

      // Tool calls
      if (delta.tool_calls) {
        const toolCalls = delta.tool_calls as Array<Record<string, unknown>>
        for (const tc of toolCalls) {
          const tcIndex = (tc.index as number) ?? 0
          const fn = tc.function as Record<string, string> | undefined

          if (tc.id && fn?.name) {
            if (this.hasTextBlock) {
              output += this.stopBlock(this.contentIndex)
              this.hasTextBlock = false
              this.contentIndex++
            }
            this.activeToolIndices.set(tcIndex, {
              id: tc.id as string,
              name: fn.name,
            })
            this.currentToolId = tc.id as string
            this.currentToolName = fn.name
            this.collectedOutput += fn.name
            output += this.startToolBlock(tc.id as string, fn.name)
            if (fn.arguments) {
              this.collectedOutput += fn.arguments
              output += this.toolInputDelta(fn.arguments)
            }
          } else if (fn?.arguments) {
            this.collectedOutput += fn.arguments
            output += this.toolInputDelta(fn.arguments)
          }
        }
      }
    }

    // Finish: close content blocks, but DEFER message_delta until usage arrives
    if (finishReason) {
      if (this.hasTextBlock) {
        output += this.stopBlock(this.contentIndex)
        this.contentIndex++
      }
      for (const [,] of this.activeToolIndices) {
        output += this.stopBlock(this.contentIndex)
        this.contentIndex++
      }

      let stopReason = 'end_turn'
      if (finishReason === 'tool_calls') stopReason = 'tool_use'
      else if (finishReason === 'length') stopReason = 'max_tokens'

      // If provider reported output usage in this chunk, emit immediately.
      // Otherwise defer — provider may send a usage-only chunk next, or
      // flush() will compute output via tiktoken.
      if (this.outputTokens > 0) {
        this.pendingFinish = stopReason
        output += this.emitFinish()
      } else {
        this.pendingFinish = stopReason
      }
    }

    return output
  }

  /** Call after the stream ends to flush any remaining events */
  flush(): string {
    if (this.outputTokens === 0 && this.collectedOutput) {
      this.outputTokens = tiktokenEncoder.encode(this.collectedOutput).length
      console.log(`[proxy] tiktoken fallback (output): in=${this.inputTokens} out=${this.outputTokens} model=${this.model}`)
    } else {
      console.log(`[proxy] tokens: in=${this.inputTokens} out=${this.outputTokens} model=${this.model}`)
    }
    if (this.pendingFinish && !this.finished) {
      return this.emitFinish()
    }
    return ''
  }
}

// ─── HTTP Server ───

async function forwardToUpstream(
  openaiBody: Record<string, unknown>,
  streaming: boolean,
): Promise<Response> {
  const url = providerChatUrl()
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${UPSTREAM_KEY}`,
      ...UPSTREAM_HEADERS,
      ...ATTRIBUTION_HEADERS,
    },
    body: JSON.stringify(openaiBody),
  })
  return resp
}

const server = Bun.serve({
  port: PORT,
  // Bun.serve default idleTimeout is 10s. Long streaming completions (slow
  // models, slow networks, long thinking) easily exceed that and the
  // connection gets killed mid-stream. The Anthropic SDK then silently
  // retries the same request with stream:false, which is why the UI seemed
  // to "wait then dump the whole reply at the end" instead of streaming.
  // 0 disables the idle timeout entirely; we still cap total request time
  // upstream via apiTimeoutMs.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    console.log(`[proxy] ${req.method} ${url.pathname}`)

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok')
    }

    // ── CCR stats endpoints (consumed by Express dashboard) ──
    if (url.pathname === '/ccr-stats/sessions' && req.method === 'GET') {
      const collector = ccrModule?.getGlobalStatsCollector?.()
      if (!collector) return Response.json({ error: 'no collector' }, { status: 503 })
      return Response.json(collector.getSessionStats())
    }
    if (url.pathname === '/ccr-stats/flush' && req.method === 'POST') {
      const collector = ccrModule?.getGlobalStatsCollector?.()
      if (!collector) return Response.json({ error: 'no collector' }, { status: 503 })
      await collector.flush()
      return Response.json({ flushed: true, sessions: collector.getSessionStats() })
    }

    // Intercept both /v1/messages (Anthropic) and /chat/completions (OpenAI) for CCR routing
    const isChatCompletions = url.pathname.includes('/chat/completions')
    const isMessages = url.pathname.includes('/messages')

    if (!isMessages && !isChatCompletions) {
      // Forward non-LLM requests as pass-through to upstream
      console.log(`[proxy] pass-through: ${url.pathname}`)
      try {
        const upResp = await fetch(`${UPSTREAM_URL}${url.pathname}${url.search}`, {
          method: req.method,
          headers: {
            Authorization: `Bearer ${UPSTREAM_KEY}`,
            'Content-Type': 'application/json',
            ...UPSTREAM_HEADERS,
            ...ATTRIBUTION_HEADERS,
          },
          body: req.method !== 'GET' ? await req.text() : undefined,
        })
        return new Response(await upResp.text(), {
          status: upResp.status,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 502 })
      }
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      })
    }

    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405 })
    }

    // ── CCR mode: delegate to embedded router pipeline ──
    if (ccrEnabled) {
      try {
        let bodyText = await req.text()
        let ccrUrl = url.toString()

        // Convert OpenAI /chat/completions → Anthropic /v1/messages for CCR pipeline
        if (isChatCompletions) {
          console.log('[proxy] converting /chat/completions → /v1/messages for CCR')
          const openaiBody = JSON.parse(bodyText)
          // Forward X-Session-Id header so convertOpenAIRequestToAnthropic can use it
          const headerSessionId = req.headers.get('x-session-id')
          if (headerSessionId && !openaiBody.user && !openaiBody._sessionId) {
            openaiBody._sessionId = headerSessionId
          }
          const anthropicBody = convertOpenAIRequestToAnthropic(openaiBody)
          bodyText = JSON.stringify(anthropicBody)
          ccrUrl = ccrUrl.replace(/\/chat\/completions/, '/v1/messages')
        }

        const reqInit: RequestInit = {
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
          body: bodyText,
        }
        const ccrResp = await ccrProcessRequest!(ccrUrl, reqInit, ccrServices!, fetch)

        // Convert response back to OpenAI format if the original request was /chat/completions
        if (isChatCompletions) {
          return convertAnthropicResponseToOpenAI(ccrResp)
        }
        return ccrResp
      } catch (err) {
        console.error('[proxy] CCR pipeline error:', err)
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'api_error', message: `CCR error: ${err}` } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    // ── Legacy mode: Anthropic → OpenAI conversion ──
    try {
      const body: AnthropicRequest = await req.json()
      const isStreaming = body.stream === true
      if (UPSTREAM_TYPE === 'anthropic') {
        const upstreamResp = await fetch(providerChatUrl(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': UPSTREAM_KEY,
            'anthropic-version': req.headers.get('anthropic-version') || '2023-06-01',
            ...UPSTREAM_HEADERS,
          },
          body: JSON.stringify(body),
        })
        return new Response(upstreamResp.body, {
          status: upstreamResp.status,
          headers: {
            'Content-Type': upstreamResp.headers.get('content-type') || (isStreaming ? 'text/event-stream' : 'application/json'),
            'Cache-Control': upstreamResp.headers.get('cache-control') || 'no-cache',
          },
        })
      }

      const openaiBody = buildOpenAIRequest(body)
      const toolCount = (openaiBody.tools as any[])?.length ?? 0
      console.error(`[proxy] ${isStreaming ? 'stream' : 'sync'} model=${body.model} tools=${toolCount} msgs=${body.messages?.length}`)

      const upstreamResp = await forwardToUpstream(openaiBody, isStreaming)

      if (!upstreamResp.ok) {
        const errText = await upstreamResp.text()
        console.error(`[proxy] upstream error ${upstreamResp.status}: ${errText}`)
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: `Upstream error: ${errText}`,
            },
          }),
          {
            status: upstreamResp.status,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      if (!isStreaming) {
        const oaiResp = await upstreamResp.json()
        const anthropicResp = convertNonStreamingResponse(
          oaiResp as Record<string, unknown>,
          body.model,
          openaiBody,
        )
        const u = (anthropicResp as Record<string, unknown>).usage as Record<string, number> | undefined
        console.log(`[proxy] tokens: in=${u?.input_tokens || 0} out=${u?.output_tokens || 0} model=${body.model}`)
        return new Response(JSON.stringify(anthropicResp), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Streaming response
      const converter = new StreamConverter(body.model, openaiBody)
      const upstreamBody = upstreamResp.body
      if (!upstreamBody) {
        return new Response('no body', { status: 502 })
      }

      const stream = new ReadableStream({
        async start(controller) {
          const reader = upstreamBody.getReader()
          const decoder = new TextDecoder()
          let buffer = ''

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed || trimmed === 'data: [DONE]') continue
                if (!trimmed.startsWith('data: ')) continue

                const jsonStr = trimmed.slice(6)
                try {
                  const chunk = JSON.parse(jsonStr)
                  const converted = converter.convert(chunk)
                  if (converted) {
                    controller.enqueue(new TextEncoder().encode(converted))
                  }
                } catch {
                  // Skip malformed chunks
                }
              }
            }
          } catch (err) {
            console.error('[proxy] stream error:', err)
          } finally {
            // Flush any deferred finish events (e.g. when usage arrived late)
            const remaining = converter.flush()
            if (remaining) {
              controller.enqueue(new TextEncoder().encode(remaining))
            }
            controller.close()
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    } catch (err) {
      console.error('[proxy] handler error:', err)
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: String(err) },
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }
  },
})

console.log(`[proxy] listening on http://localhost:${PORT}  mode=${ccrEnabled ? 'CCR' : 'direct'}`)
if (!ccrEnabled) {
  console.log(`[proxy] Upstream: ${UPSTREAM_URL} (${UPSTREAM_TYPE})`)
}
