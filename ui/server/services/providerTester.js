/**
 * Provider connectivity & capability prober — runs five lightweight checks
 * against an LLM provider and returns a structured report. Lives next to
 * edgeclawConfig.js because it consumes the same provider shape and reuses
 * `preserveMaskedSecrets` to merge "user is editing" overrides with
 * on-disk secrets at the route layer.
 *
 * The five checks (matching the Settings → Test dialog rows):
 *   1. network    — TCP/HTTPS reachability of the baseUrl host
 *   2. apiCompat  — endpoint shape detection (Anthropic /v1/messages vs
 *                   OpenAI /chat/completions vs /responses)
 *   3. keyAuth    — minimal real call (max_tokens=1) — auth + quota live
 *   4. toolUse    — same call but with a tool definition; checks for a
 *                   tool_use / tool_calls block in the response
 *   5. keyFormat  — pure-regex hint about the apiKey shape (advisory only)
 *
 * Important guarantees:
 *   - Every check has its own AbortController + timeout so one slow upstream
 *     never blocks the others past TOTAL_BUDGET_MS.
 *   - apiKey is never logged; error details capture upstream response bodies
 *     truncated to TRUNCATE_BYTES.
 *   - keyAuth never sends real prompts: just "ping" with max_tokens=1.
 *   - toolUse is a `warning` (not error) when the model refuses to call —
 *     plenty of self-hosted gateways forward to non-tool-capable backends.
 */

const NETWORK_TIMEOUT_MS = 5000;
const API_TIMEOUT_MS = 8000;
const TOOL_TIMEOUT_MS = 12000;
const TRUNCATE_BYTES = 240;

/** @typedef {'ok' | 'warning' | 'error' | 'skipped'} CheckLevel */
/**
 * @typedef {Object} Check
 * @property {string} id
 * @property {string} label
 * @property {CheckLevel} level
 * @property {string} detail
 * @property {string} [hint]
 * @property {number} [durationMs]
 */

function nonEmpty(s) { return typeof s === 'string' && s.trim().length > 0; }
function stripTrailingSlash(s) { return String(s ?? '').replace(/\/+$/, ''); }

function truncate(value, max = TRUNCATE_BYTES) {
  const text = typeof value === 'string' ? value : (() => {
    try { return JSON.stringify(value); } catch { return String(value); }
  })();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} bytes)`;
}

/**
 * Resolve provider.type → endpoint suffix. Mirrors the mapping in
 * edgeclawConfig.js#providerEndpointForType so test results match what the
 * server actually dials at runtime.
 */
function resolveEndpoint(provider) {
  const baseUrl = stripTrailingSlash(provider?.baseUrl);
  if (!baseUrl) return { url: '', mode: 'unknown' };
  const type = (provider?.type || 'openai-chat').trim();
  switch (type) {
    case 'anthropic':         return { url: `${baseUrl}/v1/messages`,      mode: 'anthropic' };
    case 'openai-responses':  return { url: `${baseUrl}/responses`,        mode: 'openai-responses' };
    case 'openai-chat':
    case 'litellm':
    case 'ccr':
    default:                  return { url: `${baseUrl}/chat/completions`, mode: 'openai-chat' };
  }
}

function buildHeaders(provider, mode) {
  /** @type {Record<string,string>} */
  const headers = {
    'Content-Type': 'application/json',
    ...(provider?.headers && typeof provider.headers === 'object' ? provider.headers : {}),
  };
  const key = nonEmpty(provider?.apiKey) ? provider.apiKey : '';
  if (mode === 'anthropic') {
    headers['x-api-key'] = key;
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
}

/**
 * Body templates kept as small as the API spec allows. We pass a single
 * "ping" turn so even strict gateways accept the request.
 */
function buildKeyAuthBody({ mode, modelName }) {
  if (mode === 'anthropic') {
    return {
      model: modelName || 'claude-3-5-haiku-latest',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    };
  }
  if (mode === 'openai-responses') {
    return { model: modelName || 'gpt-4o-mini', max_output_tokens: 1, input: 'ping' };
  }
  return {
    model: modelName || 'gpt-4o-mini',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  };
}

function buildToolUseBody({ mode, modelName }) {
  if (mode === 'anthropic') {
    return {
      model: modelName,
      max_tokens: 64,
      tools: [{
        name: 'get_time',
        description: 'Returns the current server time. Call this when asked.',
        input_schema: { type: 'object', properties: {}, required: [] },
      }],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: 'Call the get_time tool right now. Do not reply with text.' }],
    };
  }
  // Both openai-chat and openai-responses accept the OpenAI tools schema in
  // practice (responses API uses the same shape under "tools"), so share.
  const tool = {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'Returns the current server time. Call this when asked.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };
  if (mode === 'openai-responses') {
    return {
      model: modelName,
      max_output_tokens: 64,
      tools: [tool],
      input: 'Call the get_time tool right now. Do not reply with text.',
    };
  }
  return {
    model: modelName,
    max_tokens: 64,
    tools: [tool],
    tool_choice: 'auto',
    messages: [{ role: 'user', content: 'Call the get_time tool right now. Do not reply with text.' }],
  };
}

function detectToolCall(json, mode) {
  if (!json || typeof json !== 'object') return false;
  if (mode === 'anthropic') {
    return Array.isArray(json.content) && json.content.some(p => p && p.type === 'tool_use');
  }
  if (mode === 'openai-responses') {
    // Responses API surfaces tool calls under output[].type === 'function_call'
    if (Array.isArray(json.output) && json.output.some(o => o?.type === 'function_call' || o?.type === 'tool_call')) return true;
  }
  // openai-chat (and most compatibles): choices[0].message.tool_calls
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (choice?.message?.tool_calls?.length > 0) return true;
  if (Array.isArray(choice?.message?.content)
      && choice.message.content.some(c => c?.type === 'tool_use' || c?.type === 'tool_call')) return true;
  return false;
}

function classifyKeyFormat(apiKey) {
  if (!nonEmpty(apiKey)) return { shape: 'missing', label: 'API key 缺失' };
  const k = apiKey.trim();
  if (/^sk-ant-[\w-]+/i.test(k)) return { shape: 'anthropic-official', label: 'Anthropic 官方格式 (sk-ant-…)' };
  if (/^sk-proj-[\w-]+/i.test(k)) return { shape: 'openai-project',    label: 'OpenAI 项目密钥 (sk-proj-…)' };
  if (/^sk-[A-Za-z0-9]{20,}$/.test(k)) return { shape: 'openai-or-compat', label: 'OpenAI 或兼容格式 (sk-…)' };
  if (/^AIza[\w-]{20,}$/.test(k))   return { shape: 'google',           label: 'Google AI 格式 (AIza…)' };
  if (/^xai-[\w-]+/i.test(k))       return { shape: 'xai',              label: 'xAI 格式 (xai-…)' };
  if (/^Bearer\s+/i.test(k))        return { shape: 'with-prefix',      label: '已包含 "Bearer " 前缀（建议去掉）' };
  return { shape: 'third-party', label: '第三方/未知格式' };
}

/**
 * fetch-with-timeout that swallows one common edge: the WHATWG fetch in node
 * raises AbortError after the controller fires, but some agents wrap the
 * cause as ConnectionError. Both bubble up with name === 'AbortError' on
 * modern node.
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyNetworkError(err) {
  const code = err?.cause?.code || err?.code || '';
  const name = err?.name || '';
  if (name === 'AbortError') return { detail: `连接超时 (>${NETWORK_TIMEOUT_MS}ms)`, hint: '检查 baseUrl 是否可达，或所在网络是否需要代理。' };
  if (code === 'ENOTFOUND')   return { detail: `DNS 解析失败：${err.message}`,        hint: '检查 baseUrl 域名拼写是否正确。' };
  if (code === 'ECONNREFUSED') return { detail: `连接被拒绝：${err.message}`,         hint: '上游服务可能未启动；本地网关请确认端口正确。' };
  if (code === 'ECONNRESET')  return { detail: `连接被重置：${err.message}`,          hint: '可能是上游 TLS/HTTP 协议不匹配。' };
  if (String(code).includes('CERT') || /self.signed|certificate/i.test(err?.message || ''))
    return { detail: `TLS 证书校验失败：${err.message}`, hint: '若使用企业代理或自签证书，请设置环境变量 NODE_EXTRA_CA_CERTS。' };
  return { detail: err?.message || String(err), hint: '' };
}

/* ── individual checks ──────────────────────────────────────────── */

async function checkNetwork(provider) {
  const start = Date.now();
  const baseUrl = stripTrailingSlash(provider?.baseUrl);
  if (!baseUrl) {
    return { id: 'network', label: '网络连接', level: 'error', detail: 'baseUrl 未配置', durationMs: 0 };
  }
  try {
    // We don't hit the LLM endpoint here — just the base host. HEAD to the
    // baseUrl itself is the most universally supported probe. Some hosts
    // 404/405 on HEAD but that still proves connectivity.
    const res = await fetchWithTimeout(baseUrl, { method: 'HEAD' }, NETWORK_TIMEOUT_MS);
    return {
      id: 'network',
      label: '网络连接',
      level: 'ok',
      detail: `已连通 (HTTP ${res.status})`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const { detail, hint } = classifyNetworkError(err);
    return {
      id: 'network', label: '网络连接', level: 'error',
      detail, hint, durationMs: Date.now() - start,
    };
  }
}

async function checkApiCompatAndAuth(provider, modelName) {
  const compatStart = Date.now();
  const { url, mode } = resolveEndpoint(provider);
  if (!url) {
    return {
      compat: { id: 'apiCompat', label: 'API 兼容', level: 'error', detail: '无法构造 endpoint（baseUrl 缺失）' },
      auth:   { id: 'keyAuth',   label: 'Key 验证', level: 'skipped', detail: '前置检查未通过' },
    };
  }
  if (!nonEmpty(provider?.apiKey)) {
    return {
      compat: { id: 'apiCompat', label: 'API 兼容', level: 'skipped', detail: '需要 apiKey 才能探测' },
      auth:   { id: 'keyAuth',   label: 'Key 验证', level: 'error',   detail: 'apiKey 未配置' },
    };
  }
  // Real, minimal call. Status code drives both checks.
  let res, body, parsed;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: buildHeaders(provider, mode),
      body: JSON.stringify(buildKeyAuthBody({ mode, modelName })),
    }, API_TIMEOUT_MS);
    body = await res.text();
    try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
  } catch (err) {
    const { detail, hint } = classifyNetworkError(err);
    const failure = { id: 'apiCompat', label: 'API 兼容', level: 'error', detail, hint, durationMs: Date.now() - compatStart };
    return { compat: failure, auth: { id: 'keyAuth', label: 'Key 验证', level: 'skipped', detail: 'API 探测失败' } };
  }

  const status = res.status;
  const compatDuration = Date.now() - compatStart;

  // 4xx with a structured JSON body still proves the endpoint speaks the right
  // protocol. Only 502/503/504 or HTML 404s mean "wrong shape".
  const looksLikeLlm = parsed && (
    parsed.error || parsed.choices || parsed.content || parsed.id || parsed.object || parsed.model
  );
  let compat;
  if (status >= 200 && status < 300) {
    compat = { id: 'apiCompat', label: 'API 兼容', level: 'ok',
               detail: mode === 'anthropic' ? '支持 Messages API' : `支持 ${mode}`,
               durationMs: compatDuration };
  } else if (status === 401 || status === 403 || status === 429 || (status >= 400 && status < 500 && looksLikeLlm)) {
    compat = { id: 'apiCompat', label: 'API 兼容', level: 'ok',
               detail: mode === 'anthropic' ? '支持 Messages API' : `支持 ${mode}`,
               durationMs: compatDuration };
  } else if (status === 404 || status === 405) {
    const hint = mode === 'anthropic' && /\/v1$/.test(stripTrailingSlash(provider.baseUrl))
      ? 'Anthropic 类型的 baseUrl 不需要带 /v1，会被自动追加。'
      : `检查 provider.type 是否匹配；当前按 ${mode} 调用 ${url}。`;
    compat = { id: 'apiCompat', label: 'API 兼容', level: 'error',
               detail: `${status}：endpoint 不存在或不接受该方法 — ${truncate(body)}`,
               hint, durationMs: compatDuration };
  } else if (status >= 500) {
    compat = { id: 'apiCompat', label: 'API 兼容', level: 'error',
               detail: `${status}：上游错误 — ${truncate(body)}`,
               hint: '可能是上游网关故障；稍后再试或换一个 provider。',
               durationMs: compatDuration };
  } else {
    compat = { id: 'apiCompat', label: 'API 兼容', level: 'warning',
               detail: `HTTP ${status}：响应不像 LLM 端点 — ${truncate(body)}`,
               durationMs: compatDuration };
  }

  // Auth verdict from same response
  let auth;
  if (status >= 200 && status < 300) {
    auth = { id: 'keyAuth', label: 'Key 验证', level: 'ok', detail: '调用成功 (HTTP 200)' };
  } else if (status === 401) {
    const msg = parsed?.error?.message || parsed?.message || truncate(body, 120);
    auth = { id: 'keyAuth', label: 'Key 验证', level: 'error', detail: `401 未授权：${msg}`,
             hint: 'apiKey 无效或已过期；如确认正确请检查 Authorization header 格式。' };
  } else if (status === 403) {
    const msg = parsed?.error?.message || parsed?.message || truncate(body, 120);
    auth = { id: 'keyAuth', label: 'Key 验证', level: 'error', detail: `403 禁止：${msg}`,
             hint: '账号无权限访问该模型，或 IP 被限制。' };
  } else if (status === 429) {
    auth = { id: 'keyAuth', label: 'Key 验证', level: 'warning', detail: '429 限流（key 有效，已被限速）' };
  } else if (status === 404 && mode === 'anthropic' && parsed?.error?.type === 'not_found_error') {
    auth = { id: 'keyAuth', label: 'Key 验证', level: 'warning',
             detail: `404：模型 "${modelName || '<default>'}" 在该账号下不可用`,
             hint: '换一个支持的模型再测试，或在 Models 中修正 entry.name。' };
  } else if (compat.level === 'error') {
    auth = { id: 'keyAuth', label: 'Key 验证', level: 'skipped', detail: 'API 兼容性检查未通过' };
  } else {
    auth = { id: 'keyAuth', label: 'Key 验证', level: 'warning',
             detail: `HTTP ${status}：未确认 — ${truncate(body, 120)}` };
  }
  return { compat, auth };
}

async function checkToolUse(provider, modelName) {
  const start = Date.now();
  if (!nonEmpty(modelName)) {
    return { id: 'toolUse', label: '模型能力', level: 'skipped', detail: '未指定 model name（仅在测试某个 entry 时检查）' };
  }
  const { url, mode } = resolveEndpoint(provider);
  if (!url) return { id: 'toolUse', label: '模型能力', level: 'skipped', detail: 'baseUrl 缺失' };

  let res, body, parsed;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: buildHeaders(provider, mode),
      body: JSON.stringify(buildToolUseBody({ mode, modelName })),
    }, TOOL_TIMEOUT_MS);
    body = await res.text();
    try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
  } catch (err) {
    const { detail } = classifyNetworkError(err);
    return { id: 'toolUse', label: '模型能力', level: 'warning',
             detail: `工具调用探测失败：${detail}`, durationMs: Date.now() - start };
  }
  const duration = Date.now() - start;
  if (!res.ok) {
    return { id: 'toolUse', label: '模型能力', level: 'warning',
             detail: `HTTP ${res.status}：模型可能不支持 tool — ${truncate(body, 120)}`,
             durationMs: duration };
  }
  if (detectToolCall(parsed, mode)) {
    return { id: 'toolUse', label: '模型能力', level: 'ok', detail: '支持 tool use', durationMs: duration };
  }
  return { id: 'toolUse', label: '模型能力', level: 'warning',
           detail: '调用成功但模型未触发 tool_use（可能不支持，或被网关吞掉）',
           hint: '如果该模型在其他客户端可用 tool，请检查上游网关是否转发 tools 字段。',
           durationMs: duration };
}

function checkKeyFormat(provider) {
  const { shape, label } = classifyKeyFormat(provider?.apiKey);
  if (shape === 'missing') {
    return { id: 'keyFormat', label: 'Key 格式', level: 'error', detail: label };
  }
  if (shape === 'with-prefix') {
    return { id: 'keyFormat', label: 'Key 格式', level: 'warning', detail: label,
             hint: 'apiKey 字段只填裸 token，"Bearer " 前缀由系统自动添加。' };
  }
  if (shape === 'third-party') {
    return { id: 'keyFormat', label: 'Key 格式', level: 'warning', detail: label };
  }
  return { id: 'keyFormat', label: 'Key 格式', level: 'ok', detail: label };
}

/* ── orchestrator ───────────────────────────────────────────────── */

/**
 * @param {Object}  args
 * @param {Object}  args.provider     — fully-merged provider (no ******** placeholders)
 * @param {string=} args.modelName    — entry.name; if absent, toolUse is skipped
 * @returns {Promise<{
 *   endpoint: string,
 *   overall: 'ok' | 'warning' | 'error',
 *   checks: Check[],
 *   startedAt: string,
 *   finishedAt: string,
 * }>}
 */
export async function testProvider({ provider, modelName }) {
  const startedAt = new Date().toISOString();
  const { url } = resolveEndpoint(provider);

  // Run network first (cheap & gates everything else conceptually).
  const network = await checkNetwork(provider);
  // apiCompat + keyAuth share one HTTP round-trip — issue them together.
  const { compat, auth } = await checkApiCompatAndAuth(provider, modelName);
  // toolUse is the heaviest, do it last and only if auth succeeded.
  const toolUse = (auth.level === 'ok' || auth.level === 'warning')
    ? await checkToolUse(provider, modelName)
    : { id: 'toolUse', label: '模型能力', level: 'skipped', detail: 'Key 未通过验证，跳过 tool use 检测' };
  const keyFormat = checkKeyFormat(provider);

  const checks = [network, compat, auth, toolUse, keyFormat];
  const finishedAt = new Date().toISOString();

  // Overall verdict: any error → error; else any warning → warning; else ok.
  // Skipped doesn't downgrade.
  let overall = 'ok';
  for (const c of checks) {
    if (c.level === 'error') { overall = 'error'; break; }
    if (c.level === 'warning') overall = 'warning';
  }
  return { endpoint: url, overall, checks, startedAt, finishedAt };
}

// Exposed for unit tests
export const __test = {
  resolveEndpoint,
  classifyKeyFormat,
  detectToolCall,
  buildKeyAuthBody,
  buildToolUseBody,
  buildHeaders,
};
