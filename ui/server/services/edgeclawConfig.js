import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const CONFIG_VERSION = 1;
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.edgeclaw', 'config.yaml');
const MASK = '********';

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|auth[_-]?token|access[_-]?token|bot[_-]?token|app[_-]?token|encoding[_-]?aes[_-]?key)$/i;
const SECRET_EXACT_KEYS = new Set(['key', 'apiKey', 'api_key', 'authToken', 'accessToken']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripTrailingSlash(value) {
  return normalizeString(value).replace(/\/+$/, '');
}

function providerEndpointForType(provider) {
  const baseUrl = stripTrailingSlash(provider?.baseUrl);
  const type = normalizeString(provider?.type) || 'openai-chat';
  if (!baseUrl) return '';
  if (type === 'openai-responses') return `${baseUrl}/responses`;
  if (type === 'anthropic') return `${baseUrl}/v1/messages`;
  if (type === 'openai-chat' || type === 'litellm' || type === 'ccr') return `${baseUrl}/chat/completions`;
  return `${baseUrl}/chat/completions`;
}

function deepMerge(base, override) {
  if (!isRecord(base)) return clone(override);
  const output = clone(base);
  if (!isRecord(override)) return output;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (isRecord(value) && isRecord(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function defaultChannels() {
  const userAccess = {
    homeChannel: { chatId: '', name: 'Home' },
    allowedUsers: [],
    allowAllUsers: false,
    replyToMode: 'first',
  };

  return {
    feishu: {
      enabled: false,
      appId: '',
      appSecret: '',
      connectionMode: 'websocket',
      domainName: 'feishu',
      verificationToken: '',
      encryptKey: '',
      webhookHost: '127.0.0.1',
      webhookPort: 8765,
      webhookPath: '/feishu/webhook',
      projectCard: false,
      ...clone(userAccess),
    },
    telegram: {
      enabled: false,
      token: '',
      webhookUrl: '',
      webhookPort: null,
      ...clone(userAccess),
    },
    discord: { enabled: false, token: '', ...clone(userAccess) },
    slack: {
      enabled: false,
      botToken: '',
      appToken: '',
      ...clone(userAccess),
    },
    wecom: {
      enabled: false,
      botId: '',
      botSecret: '',
      websocketUrl: 'wss://openws.work.weixin.qq.com',
      ...clone(userAccess),
    },
    wecom_callback: {
      enabled: false,
      port: null,
      corpId: '',
      token: '',
      encodingAesKey: '',
      corpSecret: '',
      agentId: '',
      apps: [],
      ...clone(userAccess),
    },
    dingtalk: {
      enabled: false,
      clientId: '',
      clientSecret: '',
      streamDebug: false,
      ...clone(userAccess),
    },
    weixin: {
      enabled: false,
      baseUrl: '',
      token: '',
      accountId: '',
      cdnAesKey: '',
      ...clone(userAccess),
    },
    whatsapp: { enabled: false, ...clone(userAccess) },
    signal: {
      enabled: false,
      httpUrl: '',
      account: '',
      ...clone(userAccess),
    },
    matrix: {
      enabled: false,
      homeserver: '',
      accessToken: '',
      userId: '',
      password: '',
      encryption: false,
      ...clone(userAccess),
    },
    mattermost: {
      enabled: false,
      url: '',
      token: '',
      ...clone(userAccess),
    },
    email: {
      enabled: false,
      address: '',
      password: '',
      imapHost: '',
      imapPort: 993,
      smtpHost: '',
      smtpPort: 587,
      ...clone(userAccess),
    },
    sms_twilio: {
      enabled: false,
      accountSid: '',
      authToken: '',
      phoneNumber: '',
      webhookPort: 8790,
      ...clone(userAccess),
    },
    homeassistant: { enabled: false, url: '', token: '' },
    api_server: {
      enabled: false,
      key: '',
      port: 8642,
      host: '',
      corsOrigins: '',
      modelName: 'claude-gateway',
    },
    webhook: { enabled: false, port: 8643, secret: '' },
    bluebubbles: {
      enabled: false,
      serverUrl: '',
      password: '',
      ...clone(userAccess),
    },
  };
}

export function buildDefaultEdgeClawConfig() {
  return {
    version: CONFIG_VERSION,
    runtime: {
      host: '0.0.0.0',
      serverPort: 3001,
      vitePort: 5173,
      proxyPort: 18080,
      contextWindow: 160000,
      apiTimeoutMs: 120000,
      httpsProxy: '',
      databasePath: path.join(os.homedir(), '.cloudcli', 'auth.db'),
      workspacesRoot: os.homedir(),
    },
    models: {
      providers: {
        edgeclaw: {
          type: 'openai-chat',
          baseUrl: '',
          apiKey: '',
          transformer: null,
          headers: {},
        },
      },
      entries: {
        default: {
          provider: 'edgeclaw',
          name: '',
          contextWindow: 160000,
        },
      },
    },
    agents: {
      main: {
        model: 'default',
        params: {},
      },
      subagents: {
        default: 'inherit',
        params: {},
      },
      alwaysOn: {
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
        },
      },
    },
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
    router: {
      enabled: false,
      log: true,
      host: '127.0.0.1',
      port: 19080,
      apiTimeoutMs: 120000,
      routes: {
        default: { model: 'default', params: {} },
        background: { model: 'default', params: {} },
        think: { model: 'default', params: {} },
        longContext: { model: 'default', params: {} },
        webSearch: { model: 'default', params: {} },
        longContextThreshold: 60000,
      },
      tokenSaver: {
        enabled: false,
        judgeModel: 'default',
        defaultTier: 'MEDIUM',
        subagentPolicy: 'inherit',
        tiers: {
          SIMPLE: { model: 'default', description: 'Simple Q&A, file reads, greetings, small edits' },
          MEDIUM: { model: 'default', description: 'Moderate coding, single-file edits, explanations' },
          COMPLEX: { model: 'default', description: 'Multi-step coding, architecture, large refactors' },
          REASONING: { model: 'default', description: 'Deep reasoning, novel algorithms, security analysis' },
        },
        rules: [
          'Short prompts (<20 words) -> SIMPLE',
          'Single-file edits, code review -> MEDIUM',
          'Multi-file tasks, refactoring -> COMPLEX',
          'Novel architecture, deep analysis -> REASONING',
        ],
      },
      autoOrchestrate: {
        enabled: false,
        triggerTiers: ['COMPLEX', 'REASONING'],
        mainAgentModel: 'default',
        skillPath: '~/.claude/prompts/auto-orchestrate.md',
        blockedTools: [],
        slimSystemPrompt: true,
      },
      tokenStats: { enabled: true },
      fallback: {},
      httpsProxy: '',
      rewriteSystemPrompt: '',
      customRouterPath: '',
    },
    gateway: {
      enabled: false,
      home: path.join(os.homedir(), '.edgeclaw', 'gateway'),
      allowAllUsers: false,
      allowedUsers: [],
      groupSessionsPerUser: true,
      threadSessionsPerUser: false,
      unauthorizedDmBehavior: 'pair',
      streaming: {
        enabled: false,
        transport: 'edit',
        editInterval: 1.0,
        bufferThreshold: 40,
        cursor: ' ▉',
      },
      sessionReset: {
        default: {
          mode: 'both',
          atHour: 4,
          idleMinutes: 1440,
          notify: true,
          notifyExcludeChannels: ['api_server', 'webhook'],
        },
        byType: {},
        byChannel: {},
      },
      quickCommands: {},
      channels: defaultChannels(),
      runtimePaths: {
        sessionMetadata: '~/.claude/projects/.gateway/sessions.json',
        userBindings: '~/.claude/projects/.gateway/user-projects.json',
        generalCwd: '~/Claude/general',
        generalJsonl: '~/.claude/projects/-Users-miwi-Claude-general/*.jsonl',
        boundProjectJsonl: '~/.claude/projects/<encoded-project>/*.jsonl',
      },
    },
  };
}

export function getEdgeClawConfigPath() {
  return DEFAULT_CONFIG_PATH;
}

export function readEdgeClawConfigFile() {
  const configPath = getEdgeClawConfigPath();
  if (!fs.existsSync(configPath)) {
    return { exists: false, configPath, raw: '', config: buildDefaultEdgeClawConfig() };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parseYaml(raw) || {};
  const config = normalizeEdgeClawConfig(parsed);
  return { exists: true, configPath, raw, config };
}

export function normalizeEdgeClawConfig(input) {
  const normalized = deepMerge(buildDefaultEdgeClawConfig(), isRecord(input) ? input : {});
  delete normalized.compat;
  return normalized;
}

function isSecretKey(key) {
  return SECRET_EXACT_KEYS.has(key) || SECRET_KEY_RE.test(key);
}

export function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!isRecord(value)) return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key) && typeof child === 'string' && child.trim()) {
      output[key] = MASK;
    } else {
      output[key] = maskSecrets(child);
    }
  }
  return output;
}

export function preserveMaskedSecrets(nextValue, previousValue) {
  if (nextValue === MASK && typeof previousValue === 'string') return previousValue;
  if (Array.isArray(nextValue)) {
    return nextValue.map((item, index) => preserveMaskedSecrets(item, Array.isArray(previousValue) ? previousValue[index] : undefined));
  }
  if (isRecord(nextValue)) {
    const output = {};
    for (const [key, child] of Object.entries(nextValue)) {
      output[key] = preserveMaskedSecrets(child, isRecord(previousValue) ? previousValue[key] : undefined);
    }
    return output;
  }
  return nextValue;
}

export function resolveModel(config, modelId, options = {}) {
  const effectiveId = modelId === 'inherit' || !modelId
    ? normalizeString(config?.agents?.main?.model)
    : normalizeString(modelId);
  const entry = config?.models?.entries?.[effectiveId];
  if (!isRecord(entry)) {
    if (options.allowMissing) return null;
    throw new Error(`Model entry not found: ${effectiveId || modelId}`);
  }
  const providerId = normalizeString(entry.provider);
  const provider = config?.models?.providers?.[providerId];
  if (!isRecord(provider)) {
    if (options.allowMissing) return null;
    throw new Error(`Provider not found for model "${effectiveId}": ${providerId}`);
  }
  return {
    id: effectiveId,
    providerId,
    provider,
    model: normalizeString(entry.name),
    entry,
  };
}

function validateProvider(id, provider, errors) {
  if (!normalizeString(provider?.type)) errors.push(`models.providers.${id}.type is required`);
  if (!normalizeString(provider?.baseUrl)) errors.push(`models.providers.${id}.baseUrl is required`);
  if (!normalizeString(provider?.apiKey)) errors.push(`models.providers.${id}.apiKey is required`);
}

export function validateEdgeClawConfig(config) {
  const normalized = normalizeEdgeClawConfig(config);
  const errors = [];
  const warnings = [];

  const main = resolveModel(normalized, normalized.agents.main.model, { allowMissing: true });
  if (!main) {
    errors.push('agents.main.model must reference a model in models.entries');
  } else if (!main.model) {
    errors.push(`models.entries.${main.id}.name is required`);
  } else if (!normalized.router.enabled) {
    validateProvider(main.providerId, main.provider, errors);
  }

  if (normalized.memory.enabled && normalized.memory.model !== 'inherit') {
    const memory = resolveModel(normalized, normalized.memory.model, { allowMissing: true });
    if (!memory) errors.push('memory.model must be inherit or reference a model in models.entries');
    else if (!memory.model) errors.push(`models.entries.${memory.id}.name is required`);
  }

  if (normalized.router.enabled) {
    const route = normalized.router.routes?.default;
    const routerModel = resolveModel(normalized, route?.model, { allowMissing: true });
    if (!routerModel) errors.push('router.routes.default.model must reference a model in models.entries');
    else if (!routerModel.model) errors.push(`models.entries.${routerModel.id}.name is required`);
  }

  for (const [channelName, channel] of Object.entries(normalized.gateway.channels ?? {})) {
    if (!channel?.enabled) continue;
    const missing = missingGatewayChannelFields(channelName, channel);
    if (missing.length > 0) {
      warnings.push(`gateway.channels.${channelName} disabled at runtime because missing: ${missing.join(', ')}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings, config: normalized };
}

function missingGatewayChannelFields(channelName, channel) {
  const missing = [];
  const require = (field) => {
    if (!normalizeString(channel[field])) missing.push(field);
  };
  switch (channelName) {
    case 'feishu':
      require('appId'); require('appSecret'); break;
    case 'telegram':
    case 'discord':
    case 'mattermost':
    case 'homeassistant':
      require('token'); break;
    case 'slack':
      require('botToken'); require('appToken'); break;
    case 'wecom':
      require('botId'); require('botSecret'); break;
    case 'dingtalk':
      require('clientId'); require('clientSecret'); break;
    case 'weixin':
      require('baseUrl'); require('token'); require('accountId'); break;
    case 'signal':
      require('httpUrl'); require('account'); break;
    case 'matrix':
      require('homeserver');
      if (!normalizeString(channel.accessToken) && !(normalizeString(channel.userId) && normalizeString(channel.password))) {
        missing.push('accessToken or userId+password');
      }
      break;
    case 'email':
      require('address'); require('imapHost'); require('smtpHost'); break;
    case 'sms_twilio':
      require('accountSid'); require('authToken'); require('phoneNumber'); break;
    case 'bluebubbles':
      require('serverUrl'); require('password'); break;
    default:
      break;
  }
  return missing;
}

export function buildRuntimeEnv(config) {
  const normalized = normalizeEdgeClawConfig(config);
  const main = resolveModel(normalized, normalized.agents.main.model, { allowMissing: true });
  const runtime = normalized.runtime;
  const proxyPort = String(runtime.proxyPort ?? 18080);
  const env = {
    EDGECLAW_PROXY_PORT: proxyPort,
    PROXY_PORT: proxyPort,
    SERVER_PORT: String(runtime.serverPort ?? 3001),
    VITE_PORT: String(runtime.vitePort ?? 5173),
    HOST: String(runtime.host ?? '0.0.0.0'),
    CONTEXT_WINDOW: String(runtime.contextWindow ?? 160000),
    VITE_CONTEXT_WINDOW: String(runtime.contextWindow ?? 160000),
    API_TIMEOUT_MS: String(runtime.apiTimeoutMs ?? 120000),
    EDGECLAW_MEMORY_ENABLED: normalized.memory.enabled ? '1' : '0',
    CCR_ENABLED: normalized.router.enabled ? '1' : '0',
    CCR_DISABLED: normalized.router.enabled ? '0' : '1',
    GATEWAY_ENABLED: normalized.gateway.enabled ? '1' : '0',
    GATEWAY_HOME: expandTilde(normalized.gateway.home),
  };

  if (runtime.databasePath) env.DATABASE_PATH = expandTilde(runtime.databasePath);
  if (runtime.workspacesRoot) env.WORKSPACES_ROOT = expandTilde(runtime.workspacesRoot);

  const httpsProxy = runtime.httpsProxy || normalized.router?.httpsProxy || '';
  if (httpsProxy) {
    env.HTTPS_PROXY = httpsProxy;
    env.https_proxy = httpsProxy;
  }

  if (main) {
    env.EDGECLAW_API_BASE_URL = main.provider.baseUrl;
    env.EDGECLAW_API_KEY = main.provider.apiKey;
    env.EDGECLAW_MODEL = main.model;
    env.OPENAI_BASE_URL = main.provider.baseUrl;
    env.OPENAI_API_KEY = main.provider.apiKey;
    env.OPENAI_MODEL = main.model;
    env.ANTHROPIC_API_KEY = main.provider.apiKey;
    env.ANTHROPIC_MODEL = main.model;
  }
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;

  const memory = resolveModel(normalized, normalized.memory.model, { allowMissing: true });
  if (memory) {
    env.EDGECLAW_MEMORY_MODEL = memory.model;
    env.EDGECLAW_MEMORY_PROVIDER = memory.providerId;
    env.EDGECLAW_MEMORY_BASE_URL = memory.provider.baseUrl;
    env.EDGECLAW_MEMORY_API_KEY = memory.provider.apiKey;
    env.EDGECLAW_MEMORY_API_TYPE = providerTypeToMemoryApi(memory.provider.type);
  }

  return env;
}

export function applyConfigToProcessEnv(config) {
  Object.assign(process.env, buildRuntimeEnv(config));
}

function providerTypeToMemoryApi(type) {
  return type === 'openai-responses' ? 'openai-responses' : 'openai-completions';
}

export function buildMemoryLlmOptions(config) {
  const memory = resolveModel(normalizeEdgeClawConfig(config), config.memory?.model, { allowMissing: true });
  if (!memory) return undefined;
  return {
    provider: memory.providerId,
    model: memory.model,
    apiType: providerTypeToMemoryApi(memory.provider.type),
    baseUrl: memory.provider.baseUrl,
    apiKey: memory.provider.apiKey,
    headers: memory.provider.headers ?? {},
  };
}

export function buildMemoryDefaults(config) {
  const memory = normalizeEdgeClawConfig(config).memory;
  return {
    llm: buildMemoryLlmOptions(config),
    defaultIndexingSettings: {
      reasoningMode: memory.reasoningMode,
      autoIndexIntervalMinutes: memory.autoIndexIntervalMinutes,
      autoDreamIntervalMinutes: memory.autoDreamIntervalMinutes,
    },
    captureStrategy: memory.captureStrategy,
    includeAssistant: memory.includeAssistant,
    maxMessageChars: memory.maxMessageChars,
    heartbeatBatchSize: memory.heartbeatBatchSize,
  };
}

export function buildCcrConfig(config) {
  const normalized = normalizeEdgeClawConfig(config);
  const providers = Object.entries(normalized.models.providers).map(([providerId, provider]) => {
    const models = Object.values(normalized.models.entries)
      .filter((entry) => entry?.provider === providerId)
      .map((entry) => entry.name)
      .filter(Boolean);
    return {
      name: providerId,
      api_base_url: providerEndpointForType(provider),
      api_key: provider.apiKey,
      models,
      ...(provider.transformer ? { transformer: provider.transformer } : {}),
    };
  });

  const routeToCcr = (route) => {
    const resolved = resolveModel(normalized, route?.model, { allowMissing: true });
    return resolved ? `${resolved.providerId},${resolved.model}` : undefined;
  };

  const router = {
    default: routeToCcr(normalized.router.routes.default),
    background: routeToCcr(normalized.router.routes.background),
    think: routeToCcr(normalized.router.routes.think),
    longContext: routeToCcr(normalized.router.routes.longContext),
    webSearch: routeToCcr(normalized.router.routes.webSearch),
    longContextThreshold: normalized.router.routes.longContextThreshold,
    tokenSaver: clone(normalized.router.tokenSaver),
    autoOrchestrate: clone(normalized.router.autoOrchestrate),
  };
  router.tokenSaver.judgeProvider = resolveModel(normalized, normalized.router.tokenSaver.judgeModel, { allowMissing: true })?.providerId;
  router.tokenSaver.judgeModel = resolveModel(normalized, normalized.router.tokenSaver.judgeModel, { allowMissing: true })?.model;
  if (router.tokenSaver.tiers) {
    for (const tier of Object.values(router.tokenSaver.tiers)) {
      const resolved = resolveModel(normalized, tier.model, { allowMissing: true });
      if (resolved) tier.model = `${resolved.providerId},${resolved.model}`;
    }
  }
  const aoModel = resolveModel(normalized, router.autoOrchestrate.mainAgentModel, { allowMissing: true });
  if (aoModel) router.autoOrchestrate.mainAgentModel = `${aoModel.providerId},${aoModel.model}`;

  return {
    LOG: normalized.router.log,
    HOST: normalized.router.host,
    PORT: normalized.router.port,
    API_TIMEOUT_MS: normalized.router.apiTimeoutMs,
    Providers: providers,
    Router: router,
    tokenStats: normalized.router.tokenStats,
    ...(normalized.router.httpsProxy ? { HTTPS_PROXY: normalized.router.httpsProxy } : {}),
    ...(normalized.router.rewriteSystemPrompt ? { REWRITE_SYSTEM_PROMPT: normalized.router.rewriteSystemPrompt } : {}),
    ...(normalized.router.customRouterPath ? { CUSTOM_ROUTER_PATH: normalized.router.customRouterPath } : {}),
    ...(Object.keys(normalized.router.fallback ?? {}).length > 0 ? { fallback: normalized.router.fallback } : {}),
  };
}

export function buildGatewayConfig(config) {
  const normalized = normalizeEdgeClawConfig(config);
  const channels = normalized.gateway.channels ?? {};
  const platforms = {};
  for (const [name, channel] of Object.entries(channels)) {
    if (!channel?.enabled || missingGatewayChannelFields(name, channel).length > 0) continue;
    platforms[gatewayPlatformName(name)] = channelToPlatformConfig(name, channel);
  }
  return {
    gateway: {
      platforms,
      session_reset: gatewaySessionReset(normalized.gateway.sessionReset),
      streaming: {
        enabled: normalized.gateway.streaming.enabled,
        transport: normalized.gateway.streaming.transport,
        edit_interval: normalized.gateway.streaming.editInterval,
        buffer_threshold: normalized.gateway.streaming.bufferThreshold,
        cursor: normalized.gateway.streaming.cursor,
      },
      group_sessions_per_user: normalized.gateway.groupSessionsPerUser,
      thread_sessions_per_user: normalized.gateway.threadSessionsPerUser,
      unauthorized_dm_behavior: normalized.gateway.unauthorizedDmBehavior,
      quick_commands: normalized.gateway.quickCommands,
    },
  };
}

function gatewaySessionReset(sessionReset) {
  return {
    default: {
      mode: sessionReset.default.mode,
      at_hour: sessionReset.default.atHour,
      idle_minutes: sessionReset.default.idleMinutes,
      notify: sessionReset.default.notify,
      notify_exclude_platforms: sessionReset.default.notifyExcludeChannels,
    },
    by_type: sessionReset.byType,
    by_platform: sessionReset.byChannel,
  };
}

function gatewayPlatformName(name) {
  return name === 'sms_twilio' ? 'sms' : name;
}

function channelAccessExtra(channel) {
  return {
    ...(Array.isArray(channel.allowedUsers) && channel.allowedUsers.length > 0 ? { allowedUsers: channel.allowedUsers.join(',') } : {}),
    ...(channel.allowAllUsers ? { allowAllUsers: true } : {}),
  };
}

function channelHome(channel, platform) {
  if (!channel.homeChannel?.chatId) return undefined;
  return {
    platform,
    chat_id: channel.homeChannel.chatId,
    name: channel.homeChannel.name || 'Home',
  };
}

function channelToPlatformConfig(name, channel) {
  const platform = gatewayPlatformName(name);
  const common = {
    enabled: true,
    reply_to_mode: channel.replyToMode ?? 'first',
    ...(channelHome(channel, platform) ? { home_channel: channelHome(channel, platform) } : {}),
  };
  const extra = channelAccessExtra(channel);
  switch (name) {
    case 'feishu':
      return { ...common, extra: { ...extra, appId: channel.appId, appSecret: channel.appSecret, connectionMode: channel.connectionMode, domainName: channel.domainName, verificationToken: channel.verificationToken, encryptKey: channel.encryptKey, webhookHost: channel.webhookHost, webhookPort: channel.webhookPort, webhookPath: channel.webhookPath } };
    case 'telegram':
      return { ...common, token: channel.token, extra: { ...extra, webhookUrl: channel.webhookUrl, webhookPort: channel.webhookPort } };
    case 'discord':
      return { ...common, token: channel.token, extra };
    case 'slack':
      return { ...common, token: channel.botToken, extra: { ...extra, appToken: channel.appToken } };
    case 'wecom':
      return { ...common, extra: { ...extra, botId: channel.botId, botSecret: channel.botSecret, websocketUrl: channel.websocketUrl } };
    case 'wecom_callback':
      return { ...common, extra: { ...extra, port: channel.port, corpId: channel.corpId, callbackToken: channel.token, encodingAesKey: channel.encodingAesKey, corpSecret: channel.corpSecret, agentId: channel.agentId, apps: channel.apps } };
    case 'dingtalk':
      return { ...common, extra: { ...extra, clientId: channel.clientId, clientSecret: channel.clientSecret, streamDebug: channel.streamDebug } };
    case 'weixin':
      return { ...common, token: channel.token, extra: { ...extra, baseUrl: channel.baseUrl, accountId: channel.accountId, cdnAesKey: channel.cdnAesKey } };
    case 'whatsapp':
      return { ...common, extra };
    case 'signal':
      return { ...common, extra: { ...extra, httpUrl: channel.httpUrl, account: channel.account } };
    case 'matrix':
      return { ...common, token: channel.accessToken, extra: { ...extra, homeserver: channel.homeserver, userId: channel.userId, password: channel.password, encryption: channel.encryption } };
    case 'mattermost':
      return { ...common, token: channel.token, extra: { ...extra, url: channel.url } };
    case 'email':
      return { ...common, extra: { ...extra, address: channel.address, password: channel.password, imapHost: channel.imapHost, imapPort: channel.imapPort, smtpHost: channel.smtpHost, smtpPort: channel.smtpPort } };
    case 'sms_twilio':
      return { ...common, api_key: channel.authToken, extra: { ...extra, accountSid: channel.accountSid, phoneNumber: channel.phoneNumber, webhookPort: channel.webhookPort } };
    case 'homeassistant':
      return { ...common, token: channel.token, extra: { url: channel.url } };
    case 'api_server':
      return { ...common, api_key: channel.key, extra: { port: channel.port, host: channel.host, corsOrigins: channel.corsOrigins, modelName: channel.modelName } };
    case 'webhook':
      return { ...common, extra: { port: channel.port, secret: channel.secret } };
    case 'bluebubbles':
      return { ...common, extra: { ...extra, serverUrl: channel.serverUrl, password: channel.password } };
    default:
      return { ...common, extra };
  }
}

export async function writeEdgeClawConfig(config) {
  const normalized = normalizeEdgeClawConfig(config);
  const validation = validateEdgeClawConfig(normalized);
  if (!validation.valid) {
    const error = new Error('Invalid EdgeClaw config');
    error.validation = validation;
    throw error;
  }
  const configPath = getEdgeClawConfigPath();
  await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
  const raw = stringifyYaml(normalized, { lineWidth: 0 });
  await fsPromises.writeFile(configPath, raw, 'utf8');
  return { configPath, raw, validation, config: normalized };
}

export function expandTilde(value) {
  const text = normalizeString(value);
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

export function configToYaml(config) {
  return stringifyYaml(normalizeEdgeClawConfig(config), { lineWidth: 0 });
}

export function parseConfigYaml(raw) {
  return normalizeEdgeClawConfig(parseYaml(raw) || {});
}
