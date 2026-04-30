import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'

export type EdgeClawProviderType = 'openai-chat' | 'openai-responses' | 'anthropic' | 'litellm' | 'ccr'

export interface EdgeClawProviderConfig {
  type?: EdgeClawProviderType
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  transformer?: unknown
}

export interface EdgeClawModelEntry {
  provider?: string
  name?: string
  contextWindow?: number
}

export interface EdgeClawConfig {
  runtime?: {
    host?: string
    serverPort?: number
    vitePort?: number
    proxyPort?: number
    contextWindow?: number
    apiTimeoutMs?: number
    databasePath?: string
    workspacesRoot?: string
    httpsProxy?: string
  }
  models?: {
    providers?: Record<string, EdgeClawProviderConfig>
    entries?: Record<string, EdgeClawModelEntry>
  }
  agents?: {
    main?: { model?: string; params?: Record<string, unknown> }
    subagents?: { default?: string; params?: Record<string, unknown> }
    alwaysOn?: unknown
  }
  alwaysOn?: {
    discovery?: {
      trigger?: {
        enabled?: boolean
        tickIntervalMinutes?: number
        cooldownMinutes?: number
        dailyBudget?: number
        heartbeatStaleSeconds?: number
        recentUserMsgMinutes?: number
        preferClient?: 'webui' | 'tui'
      }
      projects?: Record<string, { enabled?: boolean }>
    }
  }
  memory?: {
    enabled?: boolean
    model?: string
    params?: Record<string, unknown>
    reasoningMode?: 'answer_first' | 'accuracy_first'
    autoIndexIntervalMinutes?: number
    autoDreamIntervalMinutes?: number
    captureStrategy?: 'last_turn' | 'full_session'
    includeAssistant?: boolean
    maxMessageChars?: number
    heartbeatBatchSize?: number
  }
  router?: { enabled?: boolean; httpsProxy?: string }
  gateway?: { enabled?: boolean; home?: string }
}

export interface ResolvedEdgeClawModel {
  id: string
  providerId: string
  provider: EdgeClawProviderConfig
  model: string
  entry: EdgeClawModelEntry
}

const DEFAULT_CONFIG_PATH = join(homedir(), '.edgeclaw', 'config.yaml')

function defaultAlwaysOnConfig(): NonNullable<EdgeClawConfig['alwaysOn']> {
  return {
    discovery: {
      trigger: {
        enabled: false,
        tickIntervalMinutes: 5,
        cooldownMinutes: 60,
        dailyBudget: 4,
        heartbeatStaleSeconds: 90,
        recentUserMsgMinutes: 5,
        preferClient: 'webui',
      },
      projects: {},
    },
  }
}

function normalize(value: string | undefined): string {
  return value?.trim() || ''
}

function stripTrailingSlash(value: string | undefined): string {
  return normalize(value).replace(/\/+$/, '')
}

function expandTilde(value: string | undefined): string {
  const text = normalize(value)
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

function defaultConfig(): EdgeClawConfig {
  return {
    runtime: {
      host: '0.0.0.0',
      serverPort: 3001,
      vitePort: 5173,
      proxyPort: 18080,
      contextWindow: 160000,
      apiTimeoutMs: 120000,
      httpsProxy: '',
    },
    models: {
      providers: {
        edgeclaw: { type: 'openai-chat', baseUrl: '', apiKey: '', headers: {} },
      },
      entries: {
        default: { provider: 'edgeclaw', name: '', contextWindow: 160000 },
      },
    },
    agents: {
      main: { model: 'default', params: {} },
      subagents: { default: 'inherit', params: {} },
    },
    alwaysOn: defaultAlwaysOnConfig(),
    memory: {
      enabled: true,
      model: 'inherit',
      params: {},
      reasoningMode: 'answer_first',
      autoIndexIntervalMinutes: 30,
      autoDreamIntervalMinutes: 60,
      captureStrategy: 'last_turn',
      includeAssistant: true,
      maxMessageChars: 6000,
      heartbeatBatchSize: 30,
    },
    router: { enabled: false },
    gateway: { enabled: false, home: join(homedir(), '.edgeclaw', 'gateway') },
  }
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return structuredClone(base)
  const output: any = structuredClone(base)
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && output[key] && typeof output[key] === 'object' && !Array.isArray(output[key])) {
      output[key] = deepMerge(output[key], value)
    } else {
      output[key] = value
    }
  }
  return output
}

export function getEdgeClawConfigPath(): string {
  if (process.env.EDGECLAW_CONFIG_PATH?.trim()) {
    return process.env.EDGECLAW_CONFIG_PATH.trim()
  }
  return DEFAULT_CONFIG_PATH
}

export function loadEdgeClawConfig(): EdgeClawConfig {
  const configPath = getEdgeClawConfigPath()
  if (existsSync(configPath)) {
    const parsed = parseYaml(readFileSync(configPath, 'utf8')) ?? {}
    const merged = deepMerge(defaultConfig(), parsed)
    const raw = parsed as any
    const legacyTrigger = raw?.agents?.alwaysOn?.discovery?.trigger
    if (
      legacyTrigger &&
      typeof legacyTrigger === 'object' &&
      !Array.isArray(legacyTrigger) &&
      !raw?.alwaysOn?.discovery?.trigger
    ) {
      ;(merged as any).alwaysOn.discovery.trigger = deepMerge(
        (merged as any).alwaysOn.discovery.trigger,
        legacyTrigger,
      )
    }
    delete (merged as any).agents?.alwaysOn
    delete (merged as any).compat
    return merged
  }
  return defaultConfig()
}

export function resolveEdgeClawModel(config: EdgeClawConfig, modelId: string | undefined): ResolvedEdgeClawModel | null {
  const effectiveId = !modelId || modelId === 'inherit' ? config.agents?.main?.model : modelId
  if (!effectiveId) return null
  const entry = config.models?.entries?.[effectiveId]
  if (!entry?.provider) return null
  const provider = config.models?.providers?.[entry.provider]
  if (!provider) return null
  return {
    id: effectiveId,
    providerId: entry.provider,
    provider,
    model: normalize(entry.name),
    entry,
  }
}

export function buildRuntimeEnvFromConfig(config: EdgeClawConfig): Record<string, string> {
  const main = resolveEdgeClawModel(config, config.agents?.main?.model)
  const memory = resolveEdgeClawModel(config, config.memory?.model)
  const proxyPort = String(config.runtime?.proxyPort ?? 18080)
  const env: Record<string, string> = {
    EDGECLAW_PROXY_PORT: proxyPort,
    PROXY_PORT: proxyPort,
    SERVER_PORT: String(config.runtime?.serverPort ?? 3001),
    VITE_PORT: String(config.runtime?.vitePort ?? 5173),
    HOST: String(config.runtime?.host ?? '0.0.0.0'),
    CONTEXT_WINDOW: String(config.runtime?.contextWindow ?? 160000),
    VITE_CONTEXT_WINDOW: String(config.runtime?.contextWindow ?? 160000),
    API_TIMEOUT_MS: String(config.runtime?.apiTimeoutMs ?? 120000),
    EDGECLAW_MEMORY_ENABLED: config.memory?.enabled === false ? '0' : '1',
    CCR_ENABLED: config.router?.enabled ? '1' : '0',
    CCR_DISABLED: config.router?.enabled ? '0' : '1',
    GATEWAY_ENABLED: config.gateway?.enabled ? '1' : '0',
    GATEWAY_HOME: expandTilde(config.gateway?.home),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}`,
  }
  if (main) {
    env.EDGECLAW_API_BASE_URL = main.provider.baseUrl ?? ''
    env.EDGECLAW_API_KEY = main.provider.apiKey ?? ''
    env.EDGECLAW_MODEL = main.model
    env.OPENAI_BASE_URL = main.provider.baseUrl ?? ''
    env.OPENAI_API_KEY = main.provider.apiKey ?? ''
    env.OPENAI_MODEL = main.model
    env.ANTHROPIC_API_KEY = main.provider.apiKey ?? ''
    env.ANTHROPIC_MODEL = main.model
  }
  if (memory) {
    env.EDGECLAW_MEMORY_PROVIDER = memory.providerId
    env.EDGECLAW_MEMORY_MODEL = memory.model
    env.EDGECLAW_MEMORY_BASE_URL = memory.provider.baseUrl ?? ''
    env.EDGECLAW_MEMORY_API_KEY = memory.provider.apiKey ?? ''
    env.EDGECLAW_MEMORY_API_TYPE = memory.provider.type === 'openai-responses' ? 'openai-responses' : 'openai-completions'
  }
  const httpsProxy = (config.runtime as any)?.httpsProxy || config.router?.httpsProxy || ''
  if (httpsProxy) {
    env.HTTPS_PROXY = httpsProxy
    env.https_proxy = httpsProxy
  }
  return env
}

export function applyEdgeClawConfigToEnv(config = loadEdgeClawConfig()): void {
  Object.assign(process.env, buildRuntimeEnvFromConfig(config))
}

export function getEdgeClawMemoryServiceOptions(config = loadEdgeClawConfig()) {
  const memory = resolveEdgeClawModel(config, config.memory?.model)
  if (!memory) return {}
  return {
    llm: {
      provider: memory.providerId,
      model: memory.model,
      apiType: memory.provider.type === 'openai-responses'
        ? 'openai-responses' as const
        : 'openai-completions' as const,
      baseUrl: memory.provider.baseUrl,
      apiKey: memory.provider.apiKey,
      headers: memory.provider.headers,
    },
    defaultIndexingSettings: {
      reasoningMode: config.memory?.reasoningMode,
      autoIndexIntervalMinutes: config.memory?.autoIndexIntervalMinutes,
      autoDreamIntervalMinutes: config.memory?.autoDreamIntervalMinutes,
    },
    captureStrategy: config.memory?.captureStrategy,
    includeAssistant: config.memory?.includeAssistant,
    maxMessageChars: config.memory?.maxMessageChars,
    heartbeatBatchSize: config.memory?.heartbeatBatchSize,
  }
}

export function getEdgeClawProxyModel(config = loadEdgeClawConfig()): ResolvedEdgeClawModel | null {
  return resolveEdgeClawModel(config, config.agents?.main?.model)
}

function providerEndpoint(provider: EdgeClawProviderConfig): string {
  const baseUrl = stripTrailingSlash(provider.baseUrl)
  if (!baseUrl) return ''
  if (provider.type === 'anthropic') return `${baseUrl}/v1/messages`
  if (provider.type === 'openai-responses') return `${baseUrl}/responses`
  return `${baseUrl}/chat/completions`
}

function routeToCcr(config: EdgeClawConfig, route: any): string | undefined {
  const resolved = resolveEdgeClawModel(config, route?.model)
  return resolved ? `${resolved.providerId},${resolved.model}` : undefined
}

export function buildCcrConfigFromEdgeClawConfig(config = loadEdgeClawConfig()) {
  const providers = Object.entries(config.models?.providers ?? {}).map(([providerId, provider]) => ({
    name: providerId,
    api_base_url: providerEndpoint(provider),
    api_key: provider.apiKey,
    models: Object.values(config.models?.entries ?? {})
      .filter(entry => entry.provider === providerId)
      .map(entry => entry.name)
      .filter(Boolean),
    ...(provider.transformer ? { transformer: provider.transformer } : {}),
  }))
  const router: any = (config as any).router ?? {}
  const routes = router.routes ?? {}
  const tokenSaver = structuredClone(router.tokenSaver ?? { enabled: false })
  if (tokenSaver.judgeModel) {
    const judge = resolveEdgeClawModel(config, tokenSaver.judgeModel)
    if (judge) {
      tokenSaver.judgeProvider = judge.providerId
      tokenSaver.judgeModel = judge.model
    }
  }
  if (tokenSaver.tiers) {
    for (const tier of Object.values<any>(tokenSaver.tiers)) {
      const resolved = resolveEdgeClawModel(config, tier.model)
      if (resolved) tier.model = `${resolved.providerId},${resolved.model}`
    }
  }
  const autoOrchestrate = structuredClone(router.autoOrchestrate ?? { enabled: false })
  if (autoOrchestrate.mainAgentModel) {
    const resolved = resolveEdgeClawModel(config, autoOrchestrate.mainAgentModel)
    if (resolved) autoOrchestrate.mainAgentModel = `${resolved.providerId},${resolved.model}`
  }
  return {
    LOG: router.log ?? true,
    HOST: router.host ?? '127.0.0.1',
    PORT: router.port ?? 19080,
    API_TIMEOUT_MS: router.apiTimeoutMs ?? 120000,
    Providers: providers,
    Router: {
      default: routeToCcr(config, routes.default),
      background: routeToCcr(config, routes.background),
      think: routeToCcr(config, routes.think),
      longContext: routeToCcr(config, routes.longContext),
      webSearch: routeToCcr(config, routes.webSearch),
      longContextThreshold: routes.longContextThreshold ?? 60000,
      tokenSaver,
      autoOrchestrate,
    },
    tokenStats: router.tokenStats ?? { enabled: true },
    ...(router.httpsProxy ? { HTTPS_PROXY: router.httpsProxy } : {}),
    ...(router.fallback ? { fallback: router.fallback } : {}),
  }
}

if (import.meta.main) {
  const command = process.argv[2]
  const config = loadEdgeClawConfig()
  if (command === 'shell-env') {
    const env = buildRuntimeEnvFromConfig(config)
    for (const [key, value] of Object.entries(env)) {
      const escaped = value.replace(/'/g, `'\\''`)
      console.log(`export ${key}='${escaped}'`)
    }
  } else if (command === 'json') {
    console.log(JSON.stringify(config, null, 2))
  }
}
