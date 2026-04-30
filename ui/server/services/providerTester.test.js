import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { testProvider, __test } from './providerTester.js';

const { resolveEndpoint, classifyKeyFormat, detectToolCall, buildHeaders, buildKeyAuthBody, buildToolUseBody } = __test;

// ── tiny fetch mock ────────────────────────────────────────────────
// We don't pull in msw to keep this test self-contained — global.fetch
// is the WHATWG API, so a fn that returns { status, json, text } is enough.

const realFetch = globalThis.fetch;
let fetchCalls;

function setFetch(implementation) {
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return implementation(url, init);
  };
}

function mockResponse({ status = 200, json = null, text = null, delayMs = 0 } = {}) {
  return new Promise((resolve) => {
    const body = text ?? (json !== null ? JSON.stringify(json) : '');
    const fn = () => resolve({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => (typeof body === 'string' && body ? JSON.parse(body) : null),
    });
    if (delayMs > 0) setTimeout(fn, delayMs);
    else fn();
  });
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

/* ── pure helpers ──────────────────────────────────────────── */

test('resolveEndpoint maps provider.type to the right URL suffix', () => {
  assert.equal(resolveEndpoint({ type: 'anthropic',  baseUrl: 'https://x' }).url, 'https://x/v1/messages');
  assert.equal(resolveEndpoint({ type: 'openai-chat', baseUrl: 'https://x/' }).url, 'https://x/chat/completions');
  assert.equal(resolveEndpoint({ type: 'openai-responses', baseUrl: 'https://x' }).url, 'https://x/responses');
  assert.equal(resolveEndpoint({ type: 'litellm', baseUrl: 'https://x' }).url, 'https://x/chat/completions');
  // Default fallback
  assert.equal(resolveEndpoint({ baseUrl: 'https://x' }).url, 'https://x/chat/completions');
  assert.equal(resolveEndpoint({ baseUrl: '' }).url, '');
});

test('classifyKeyFormat distinguishes the common shapes', () => {
  assert.equal(classifyKeyFormat('sk-ant-api03-xxxxxxxx').shape, 'anthropic-official');
  assert.equal(classifyKeyFormat('sk-proj-abcd1234abcd1234').shape, 'openai-project');
  assert.equal(classifyKeyFormat('sk-1234567890abcdefghij1234567890').shape, 'openai-or-compat');
  assert.equal(classifyKeyFormat('AIzaSyA-1234567890abcdef1234567890').shape, 'google');
  assert.equal(classifyKeyFormat('xai-abcdef').shape, 'xai');
  assert.equal(classifyKeyFormat('Bearer sk-xxx').shape, 'with-prefix');
  assert.equal(classifyKeyFormat('eyJhbGciOiJIUzI1...').shape, 'third-party');
  assert.equal(classifyKeyFormat('').shape, 'missing');
});

test('detectToolCall handles anthropic and openai response shapes', () => {
  // Anthropic
  assert.equal(detectToolCall({ content: [{ type: 'tool_use', name: 'x' }] }, 'anthropic'), true);
  assert.equal(detectToolCall({ content: [{ type: 'text', text: 'hi' }] }, 'anthropic'), false);
  // OpenAI chat
  assert.equal(detectToolCall({ choices: [{ message: { tool_calls: [{ id: '1' }] } }] }, 'openai-chat'), true);
  assert.equal(detectToolCall({ choices: [{ message: { content: 'no tool' } }] }, 'openai-chat'), false);
  // OpenAI responses
  assert.equal(detectToolCall({ output: [{ type: 'function_call', name: 'x' }] }, 'openai-responses'), true);
  // Robustness
  assert.equal(detectToolCall(null, 'anthropic'), false);
});

test('buildHeaders uses x-api-key + anthropic-version for anthropic', () => {
  const h = buildHeaders({ type: 'anthropic', apiKey: 'sk-ant-x' }, 'anthropic');
  assert.equal(h['x-api-key'], 'sk-ant-x');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['Authorization'], undefined);
});

test('buildHeaders uses Bearer for openai-chat and respects custom headers', () => {
  const h = buildHeaders({ type: 'openai-chat', apiKey: 'sk-x', headers: { 'X-Custom': '1' } }, 'openai-chat');
  assert.equal(h['Authorization'], 'Bearer sk-x');
  assert.equal(h['X-Custom'], '1');
});

test('buildKeyAuthBody is minimal for each mode', () => {
  assert.equal(buildKeyAuthBody({ mode: 'anthropic' }).max_tokens, 1);
  assert.equal(buildKeyAuthBody({ mode: 'openai-chat' }).max_tokens, 1);
  assert.equal(buildKeyAuthBody({ mode: 'openai-responses' }).max_output_tokens, 1);
});

test('buildToolUseBody injects tools[] in the right schema per mode', () => {
  const ant = buildToolUseBody({ mode: 'anthropic', modelName: 'claude' });
  assert.equal(ant.tools[0].input_schema.type, 'object');
  const oai = buildToolUseBody({ mode: 'openai-chat', modelName: 'gpt' });
  assert.equal(oai.tools[0].type, 'function');
  assert.equal(oai.tools[0].function.parameters.type, 'object');
});

/* ── orchestrator: end-to-end paths ─────────────────────────── */

test('testProvider: full green path for anthropic with tool_use', async () => {
  setFetch(async (url, init) => {
    if (init?.method === 'HEAD') return mockResponse({ status: 200, text: '' });
    const body = JSON.parse(init.body);
    if (body.tools) {
      // tool use call
      return mockResponse({ status: 200, json: { content: [{ type: 'tool_use', name: 'get_time' }] } });
    }
    // auth ping
    return mockResponse({ status: 200, json: { id: 'msg_1', content: [{ type: 'text', text: 'ok' }] } });
  });
  const result = await testProvider({
    provider: { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-xxxxxxxxxxxxxxxx' },
    modelName: 'claude-3-5-haiku-latest',
  });
  assert.equal(result.overall, 'ok');
  const byId = Object.fromEntries(result.checks.map(c => [c.id, c]));
  assert.equal(byId.network.level, 'ok');
  assert.equal(byId.apiCompat.level, 'ok');
  assert.equal(byId.keyAuth.level, 'ok');
  assert.equal(byId.toolUse.level, 'ok');
  assert.equal(byId.keyFormat.level, 'ok');
});

test('testProvider: 401 surfaces as keyAuth error and skips toolUse', async () => {
  setFetch(async (url, init) => {
    if (init?.method === 'HEAD') return mockResponse({ status: 200, text: '' });
    return mockResponse({ status: 401, json: { error: { message: 'invalid_api_key' } } });
  });
  const result = await testProvider({
    provider: { type: 'openai-chat', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-bad' },
    modelName: 'deepseek-chat',
  });
  assert.equal(result.overall, 'error');
  const byId = Object.fromEntries(result.checks.map(c => [c.id, c]));
  // 401 still means the endpoint is reachable & speaks the right protocol
  assert.equal(byId.apiCompat.level, 'ok');
  assert.equal(byId.keyAuth.level, 'error');
  assert.match(byId.keyAuth.detail, /401/);
  assert.equal(byId.toolUse.level, 'skipped');
});

test('testProvider: 429 is a warning (key valid, rate limited)', async () => {
  setFetch(async (url, init) => {
    if (init?.method === 'HEAD') return mockResponse({ status: 200, text: '' });
    return mockResponse({ status: 429, json: { error: { message: 'rate_limited' } } });
  });
  const result = await testProvider({
    provider: { type: 'openai-chat', baseUrl: 'https://x', apiKey: 'sk-1234567890abcdefghij1234567890' },
  });
  const auth = result.checks.find(c => c.id === 'keyAuth');
  assert.equal(auth.level, 'warning');
  assert.equal(result.overall, 'warning');
});

test('testProvider: 404 HTML body marks apiCompat as error with hint', async () => {
  setFetch(async (url, init) => {
    if (init?.method === 'HEAD') return mockResponse({ status: 200, text: '' });
    return mockResponse({ status: 404, text: '<html><body>Not Found</body></html>' });
  });
  const result = await testProvider({
    provider: { type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-x' },
    modelName: 'claude-3-5-haiku-latest',
  });
  const compat = result.checks.find(c => c.id === 'apiCompat');
  assert.equal(compat.level, 'error');
  assert.match(compat.hint, /\/v1/);
  assert.equal(result.overall, 'error');
});

test('testProvider: tool not triggered → warning, not error', async () => {
  setFetch(async (url, init) => {
    if (init?.method === 'HEAD') return mockResponse({ status: 200, text: '' });
    const body = JSON.parse(init.body);
    if (body.tools) {
      // model replied with text only
      return mockResponse({ status: 200, json: { content: [{ type: 'text', text: 'sure' }] } });
    }
    return mockResponse({ status: 200, json: { id: 'msg_1', content: [{ type: 'text', text: 'pong' }] } });
  });
  const result = await testProvider({
    provider: { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-xxxxxxxxxxxxxxxx' },
    modelName: 'some-non-tool-model',
  });
  const tool = result.checks.find(c => c.id === 'toolUse');
  assert.equal(tool.level, 'warning');
  assert.equal(result.overall, 'warning');
});

test('testProvider: third-party key format is a warning, never blocks', async () => {
  setFetch(async (url, init) => {
    if (init?.method === 'HEAD') return mockResponse({ status: 200, text: '' });
    const body = JSON.parse(init.body);
    if (body.tools) return mockResponse({ status: 200, json: { content: [{ type: 'tool_use', name: 'get_time' }] } });
    return mockResponse({ status: 200, json: { content: [{ type: 'text', text: 'ok' }] } });
  });
  const result = await testProvider({
    provider: { type: 'anthropic', baseUrl: 'https://gateway.example.com', apiKey: 'opaque_token_12345' },
    modelName: 'claude-3-5-haiku-latest',
  });
  const fmt = result.checks.find(c => c.id === 'keyFormat');
  assert.equal(fmt.level, 'warning');
  assert.match(fmt.detail, /第三方/);
  // Whole result is still warning, not error — third-party gateways are normal in this codebase
  assert.equal(result.overall, 'warning');
});

test('testProvider: missing baseUrl short-circuits all network checks', async () => {
  setFetch(async () => { throw new Error('should not be called'); });
  const result = await testProvider({
    provider: { type: 'openai-chat', baseUrl: '', apiKey: 'sk-x' },
  });
  assert.equal(result.overall, 'error');
  const network = result.checks.find(c => c.id === 'network');
  assert.equal(network.level, 'error');
  assert.match(network.detail, /baseUrl/);
});

test('testProvider: missing apiKey skips compat/auth, format flags it', async () => {
  setFetch(async (url, init) => {
    // Only the HEAD network probe should fire
    assert.equal(init?.method, 'HEAD');
    return mockResponse({ status: 200, text: '' });
  });
  const result = await testProvider({
    provider: { type: 'openai-chat', baseUrl: 'https://x', apiKey: '' },
  });
  const byId = Object.fromEntries(result.checks.map(c => [c.id, c]));
  assert.equal(byId.network.level, 'ok');
  assert.equal(byId.apiCompat.level, 'skipped');
  assert.equal(byId.keyAuth.level, 'error');
  assert.equal(byId.keyFormat.level, 'error');
  assert.equal(result.overall, 'error');
});

test('testProvider: TLS error gets a NODE_EXTRA_CA_CERTS hint', async () => {
  setFetch(async () => {
    const e = new Error('self signed certificate in certificate chain');
    e.cause = { code: 'SELF_SIGNED_CERT_IN_CHAIN' };
    throw e;
  });
  const result = await testProvider({
    provider: { type: 'openai-chat', baseUrl: 'https://internal.corp', apiKey: 'sk-1234567890abcdefghij1234567890' },
  });
  const network = result.checks.find(c => c.id === 'network');
  assert.equal(network.level, 'error');
  assert.match(network.hint, /NODE_EXTRA_CA_CERTS/);
});
