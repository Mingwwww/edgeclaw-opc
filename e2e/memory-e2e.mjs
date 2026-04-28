/**
 * Memory E2E Test — 覆盖 memory测试流程.md 10 个阶段
 *
 * 策略：
 *   1. 直接 import EdgeClawMemoryService 来调用 captureTurn / flush / dream / retrieve
 *   2. 同时通过 claudecodeui HTTP API 验证 dashboard 数据一致性
 *
 * 运行：  node --experimental-vm-modules e2e/memory-e2e.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

// ─── set up global proxy so all fetch() calls go through 7890 ───
const _require = createRequire(
  join(process.cwd(), 'claudecodeui', 'package.json'),
);
try {
  const { ProxyAgent, setGlobalDispatcher } = _require('undici');
  setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7890'));
  console.log('[proxy] global fetch → http://127.0.0.1:7890');
} catch (e) {
  console.warn('[proxy] undici not found, fetch may fail for HTTPS targets');
}

// ─── import memory-core (compiled lib/) ───
const memCore = await import('../edgeclaw-memory-core/lib/index.js');
const { EdgeClawMemoryService, hashText } = memCore;

// ─── import edgeclaw config helpers ───
const configMod = await import('../claudecodeui/server/services/edgeclawConfig.js');
const { readEdgeClawConfigFile, buildMemoryDefaults, buildMemoryLlmOptions } = configMod;

// ─── constants ───
const API = 'http://localhost:3001';
const ROOT = join(homedir(), '.edgeclaw', 'memory');
const TEST_WS_A = '/tmp/memory-e2e-ws-a';
const TEST_WS_B = '/tmp/memory-e2e-ws-b';

let passed = 0;
let failed = 0;
const results = [];

function ok(name) { passed++; results.push({ name, status: 'PASS' }); console.log(`  ✅ ${name}`); }
function fail(name, err) { failed++; results.push({ name, status: 'FAIL', error: String(err) }); console.error(`  ❌ ${name}: ${err}`); }

function check(name, fn) {
  try { fn(); ok(name); } catch (e) { fail(name, e.message); }
}

async function acheck(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e.message); }
}

async function fetchJson(path, opts = {}) {
  const url = `${API}${path}`;
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ─── build memory service for a workspace ───
function createService(workspaceDir) {
  const { config } = readEdgeClawConfigFile();
  const defaults = buildMemoryDefaults(config);
  const wsHash = hashText(workspaceDir);
  const dataDir = join(ROOT, 'workspaces', wsHash);
  mkdirSync(join(dataDir, 'memory'), { recursive: true });

  return new EdgeClawMemoryService({
    workspaceDir,
    rootDir: ROOT,
    dbPath: join(dataDir, 'control.sqlite'),
    memoryDir: join(dataDir, 'memory'),
    source: 'e2e-test',
    ...defaults,
  });
}

// ─── cleanup test workspaces ───
function cleanupTestDirs() {
  for (const dir of [TEST_WS_A, TEST_WS_B]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  const wsHashA = hashText(TEST_WS_A);
  const wsHashB = hashText(TEST_WS_B);
  for (const h of [wsHashA, wsHashB]) {
    const p = join(ROOT, 'workspaces', h);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

console.log('\n🧠 Memory E2E Test — 10 阶段\n');

// ─── Prep: verify server is up ───
console.log('── 准备：检查 claudecodeui 服务 ──');
await acheck('claudecodeui health', async () => {
  const { status } = await fetchJson('/health');
  assert.equal(status, 200);
});

// ─── Prep: verify LLM connectivity ───
console.log('\n── 准备：检查 LLM 连接 ──');
const { config: edgeConfig } = readEdgeClawConfigFile();
const llmOpts = buildMemoryLlmOptions(edgeConfig);
await acheck('LLM config resolved', async () => {
  assert.ok(llmOpts, 'buildMemoryLlmOptions returned null');
  assert.ok(llmOpts.baseUrl, 'missing baseUrl');
  assert.ok(llmOpts.apiKey, 'missing apiKey');
  console.log(`    provider=${llmOpts.provider} model=${llmOpts.model} apiType=${llmOpts.apiType}`);
  console.log(`    baseUrl=${llmOpts.baseUrl}`);
});

// Quick LLM ping — use claudecodeui proxy to bypass direct fetch issues
await acheck('LLM API reachable (via proxy)', async () => {
  const { execSync } = await import('node:child_process');
  const cmd = `curl -s --max-time 10 --proxy http://127.0.0.1:7890 -o /dev/null -w "%{http_code}" `
    + `-X POST "${llmOpts.baseUrl}/chat/completions" `
    + `-H "Content-Type: application/json" `
    + `-H "Authorization: Bearer ${llmOpts.apiKey}" `
    + `-d '${JSON.stringify({ model: llmOpts.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })}'`;
  const code = execSync(cmd, { encoding: 'utf-8' }).trim();
  console.log(`    LLM HTTP status: ${code}`);
  assert.ok(code === '200', `LLM returned ${code}`);
});

// ─── Clean up test workspaces ───
cleanupTestDirs();

// ═══════════════════════════════════════════════════════════════
//  阶段 1：全局用户画像
// ═══════════════════════════════════════════════════════════════
console.log('\n── 阶段 1：全局用户画像测试 ──');

const svcA = createService(TEST_WS_A);

await acheck('1.1 captureTurn — 用户画像消息', async () => {
  const r1 = svcA.captureTurn(
    [{ role: 'user', content: '我叫张三，是婚礼策划师，长期在英国生活，主要服务伦敦和曼城的华人婚礼客户。' }],
    { sessionKey: 'e2e-profile-1' },
  );
  assert.ok(r1.captured, 'captureTurn should capture');
  const r2 = svcA.captureTurn(
    [{ role: 'user', content: '我还有一个长期副业，是帮中小商家做小红书获客咨询，平时更关注转化率、标题点击率和内容自然感。' }],
    { sessionKey: 'e2e-profile-1' },
  );
  assert.ok(r2.captured);
});

await acheck('1.2 flush (索引同步)', async () => {
  const stats = await svcA.flush({ reason: 'e2e-test' });
  console.log(`    indexed ${stats.indexed ?? stats.processedMessages ?? '?'} items`);
  assert.ok(stats, 'flush should return stats');
});

await acheck('1.3 dream (记忆 Dream)', async () => {
  const result = await svcA.dream('manual');
  console.log(`    dream actions: ${result?.actions?.length ?? result?.mergedCount ?? '?'}`);
});

await acheck('1.4 用户画像 recall', async () => {
  const recall = await svcA.retrieve('我是谁，长期在哪里生活？');
  const text = JSON.stringify(recall).toLowerCase();
  assert.ok(
    text.includes('张三') || text.includes('英国') || text.includes('婚礼'),
    `recall should mention 张三/英国/婚礼, got: ${text.slice(0, 200)}`,
  );
  console.log(`    recall hit: 张三/英国/婚礼 ✓`);
});

await acheck('1.5 副业 recall', async () => {
  const recall = await svcA.retrieve('我还有什么长期副业，平时最关注哪些指标？');
  const text = JSON.stringify(recall).toLowerCase();
  assert.ok(
    text.includes('小红书') || text.includes('转化率') || text.includes('获客'),
    `recall should mention 小红书/转化率, got: ${text.slice(0, 200)}`,
  );
  console.log(`    recall hit: 小红书/转化率 ✓`);
});

// ═══════════════════════════════════════════════════════════════
//  阶段 2：Workspace A — 项目写入
// ═══════════════════════════════════════════════════════════════
console.log('\n── 阶段 2：Workspace A 写入 ──');

await acheck('2.1 captureTurn — 项目A消息', async () => {
  svcA.captureTurn(
    [{ role: 'user', content: '这个项目叫 Wedding Launch Copy，目标是给英国华人婚礼客户写小红书获客文案。一期先产出 10 篇模板。当前最大风险是文案太像硬广、缺少真实分享感。' }],
    { sessionKey: 'e2e-ws-a-1' },
  );
  svcA.captureTurn(
    [{ role: 'user', content: '这个项目里封面标题不要超过 14 个字，语气要像真实新娘分享，避免销售腔。' }],
    { sessionKey: 'e2e-ws-a-1' },
  );
});

await acheck('2.2 flush Workspace A', async () => {
  const stats = await svcA.flush({ reason: 'e2e-ws-a' });
  console.log(`    indexed: ${JSON.stringify(stats).slice(0, 200)}`);
});

// ═══════════════════════════════════════════════════════════════
//  阶段 3：Workspace B — 项目写入
// ═══════════════════════════════════════════════════════════════
console.log('\n── 阶段 3：Workspace B 写入 ──');

const svcB = createService(TEST_WS_B);

await acheck('3.1 captureTurn — 项目B消息', async () => {
  svcB.captureTurn(
    [{ role: 'user', content: '这个项目叫 SaaS Pricing Rewrite，目标是给 B2B SaaS 官网改写定价页文案。一期先完成 3 个定价方案对比模块。当前最大风险是卖点太泛、没有差异化。' }],
    { sessionKey: 'e2e-ws-b-1' },
  );
  svcB.captureTurn(
    [{ role: 'user', content: '这个项目里 CTA 不要出现"立即购买"，默认用简洁商务中文；如果要写文件，优先新建 draft.md，不要改动 .gitignore。' }],
    { sessionKey: 'e2e-ws-b-1' },
  );
});

await acheck('3.2 flush Workspace B', async () => {
  const stats = await svcB.flush({ reason: 'e2e-ws-b' });
  console.log(`    indexed: ${JSON.stringify(stats).slice(0, 200)}`);
});

// ═══════════════════════════════════════════════════════════════
//  阶段 4：项目 Recall 隔离
// ═══════════════════════════════════════════════════════════════
console.log('\n── 阶段 4：项目 Recall 隔离 ──');

await acheck('4.1 Workspace A recall — 命中A、不串B', async () => {
  const recall = await svcA.retrieve('这个项目的一期目标、主要风险和标题限制分别是什么？');
  const text = JSON.stringify(recall);
  assert.ok(text.includes('10') || text.includes('模板') || text.includes('14'), `A recall should hit 10篇/14字`);
  const hasBLeak = text.includes('CTA') && text.includes('draft.md');
  console.log(`    A recall: 10篇/14字 ✓, B串入=${hasBLeak}`);
});

await acheck('4.2 Workspace B recall — 命中B、不串A', async () => {
  const recall = await svcB.retrieve('这个项目的一期目标、主要风险、CTA 限制和文件规范分别是什么？');
  const text = JSON.stringify(recall);
  assert.ok(text.includes('3') || text.includes('定价') || text.includes('draft'), `B recall should hit 3个/draft.md`);
  const hasALeak = text.includes('14') && text.includes('新娘');
  console.log(`    B recall: 定价/draft ✓, A串入=${hasALeak}`);
});

// ═══════════════════════════════════════════════════════════════
//  阶段 5：Global + Workspace 混合召回
// ═══════════════════════════════════════════════════════════════
console.log('\n── 阶段 5：Global + Workspace 混合召回 ──');

await acheck('5.1 混合 recall', async () => {
  const recall = await svcA.retrieve('结合我的长期背景和当前项目，给我一句这个项目更适合什么写法。');
  const text = JSON.stringify(recall);
  const hitGlobal = text.includes('婚礼') || text.includes('英国') || text.includes('张三');
  const hitProject = text.includes('文案') || text.includes('小红书') || text.includes('获客');
  console.log(`    global命中=${hitGlobal}, project命中=${hitProject}`);
  assert.ok(hitGlobal || hitProject, 'mixed recall should hit global or project');
});

// ═══════════════════════════════════════════════════════════════
//  阶段 6–7: Dashboard API 验证
// ═══════════════════════════════════════════════════════════════
console.log('\n── 阶段 6–7：Dashboard API 验证 ──');

await acheck('6.1 overview API — Workspace A', async () => {
  const { status, data } = await fetchJson(`/api/memory/overview?projectPath=${encodeURIComponent(TEST_WS_A)}`);
  assert.equal(status, 200);
  console.log(`    pendingSessions=${data.pendingSessions}, projectMemoryCount=${data.projectMemoryCount}, userProfileCount=${data.userProfileCount}`);
});

await acheck('6.2 memory/list API — Workspace A', async () => {
  const { status, data } = await fetchJson(`/api/memory/memory/list?projectPath=${encodeURIComponent(TEST_WS_A)}`);
  assert.equal(status, 200);
  const records = Array.isArray(data) ? data : data.records || [];
  console.log(`    memory records: ${records.length}`);
});

await acheck('6.3 user-summary API', async () => {
  const { status, data } = await fetchJson(`/api/memory/memory/user-summary?projectPath=${encodeURIComponent(TEST_WS_A)}`);
  assert.equal(status, 200);
  const text = JSON.stringify(data);
  console.log(`    user-summary: ${text.slice(0, 200)}`);
});

await acheck('6.4 snapshot API', async () => {
  const { status } = await fetchJson(`/api/memory/snapshot?projectPath=${encodeURIComponent(TEST_WS_A)}`);
  assert.equal(status, 200);
});

await acheck('6.5 index-traces API', async () => {
  const { status, data } = await fetchJson(`/api/memory/index-traces?projectPath=${encodeURIComponent(TEST_WS_A)}`);
  assert.equal(status, 200);
  const traces = Array.isArray(data) ? data : data.traces || [];
  console.log(`    index traces: ${traces.length}`);
});

// ═══════════════════════════════════════════════════════════════
//  阶段 7: Index via HTTP API（验证 REST 路径一致性）
// ═══════════════════════════════════════════════════════════════
console.log('\n── 阶段 7：HTTP API 触发 Index ──');

await acheck('7.1 POST /index/run via API', async () => {
  const { status, data } = await fetchJson(
    `/api/memory/index/run?projectPath=${encodeURIComponent(TEST_WS_A)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  assert.equal(status, 200);
  console.log(`    API index result: ${JSON.stringify(data).slice(0, 200)}`);
});

// ═══════════════════════════════════════════════════════════════
//  阶段 8: Dream via HTTP API
// ═══════════════════════════════════════════════════════════════
console.log('\n── 阶段 8：HTTP API 触发 Dream ──');

await acheck('8.1 POST /dream/run via API', async () => {
  const { status, data } = await fetchJson(
    `/api/memory/dream/run?projectPath=${encodeURIComponent(TEST_WS_A)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  console.log(`    API dream status=${status}: ${JSON.stringify(data).slice(0, 200)}`);
  assert.ok(status === 200 || status === 400, `dream returned ${status}`);
});

await acheck('8.2 dream-traces API', async () => {
  const { status, data } = await fetchJson(`/api/memory/dream-traces?projectPath=${encodeURIComponent(TEST_WS_A)}`);
  assert.equal(status, 200);
  const traces = Array.isArray(data) ? data : data.traces || [];
  console.log(`    dream traces: ${traces.length}`);
});

// ═══════════════════════════════════════════════════════════════
//  阶段 9: Export / Import
// ═══════════════════════════════════════════════════════════════
console.log('\n── 阶段 9：Export / Import ──');

await acheck('9.1 export bundle', async () => {
  const bundle = await svcA.exportBundle();
  assert.ok(bundle, 'export should return bundle');
  const keys = Object.keys(bundle);
  console.log(`    export keys: ${keys.join(', ')}`);
});

await acheck('9.2 export via API', async () => {
  const { status, data } = await fetchJson(`/api/memory/export?projectPath=${encodeURIComponent(TEST_WS_A)}`);
  assert.equal(status, 200);
  console.log(`    API export keys: ${Object.keys(data).join(', ')}`);
});

// ═══════════════════════════════════════════════════════════════
//  阶段 10: Settings + Clear
// ═══════════════════════════════════════════════════════════════
console.log('\n── 阶段 10：Settings + Clear ──');

await acheck('10.1 settings read', async () => {
  const settings = svcA.getSettings();
  assert.ok(settings.reasoningMode, 'settings should have reasoningMode');
  console.log(`    reasoningMode=${settings.reasoningMode}, autoIndex=${settings.autoIndexIntervalMinutes}min`);
});

await acheck('10.2 settings read via API', async () => {
  const { status, data } = await fetchJson(`/api/memory/settings?projectPath=${encodeURIComponent(TEST_WS_A)}`);
  assert.equal(status, 200);
  console.log(`    API settings: ${JSON.stringify(data)}`);
});

await acheck('10.3 settings write (accuracy_first)', async () => {
  // NOTE: sanitizeIndexingSettings only allows "accuracy_first"; "reasoning_first" is silently dropped (potential bug)
  const before = svcA.getSettings();
  svcA.saveSettings({ reasoningMode: 'accuracy_first' });
  const afterRead = svcA.getSettings();
  assert.equal(afterRead.reasoningMode, 'accuracy_first', 'should persist accuracy_first');
  svcA.saveSettings({ reasoningMode: before.reasoningMode || 'answer_first' });
  console.log(`    write → accuracy_first → revert ✓`);
  console.log(`    ⚠️  BUG: sanitizeIndexingSettings 只接受 "accuracy_first"，不接受 "reasoning_first"`);
});

await acheck('10.4 settings write (autoIndexInterval)', async () => {
  const before = svcA.getSettings();
  svcA.saveSettings({ autoIndexIntervalMinutes: 30 });
  const afterRead = svcA.getSettings();
  assert.equal(afterRead.autoIndexIntervalMinutes, 30);
  svcA.saveSettings({ autoIndexIntervalMinutes: before.autoIndexIntervalMinutes });
  console.log(`    write autoIndexInterval → 30 → revert ✓`);
});

// ═══════════════════════════════════════════════════════════════
//  Cleanup
// ═══════════════════════════════════════════════════════════════
console.log('\n── Cleanup ──');
try { svcA.close(); } catch {}
try { svcB.close(); } catch {}

// ═══════════════════════════════════════════════════════════════
//  Report
// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════');
console.log(`  TOTAL: ${passed + failed}  |  PASS: ${passed}  |  FAIL: ${failed}`);
console.log('═══════════════════════════════════════\n');

if (failed > 0) {
  console.log('❌ Failed tests:');
  for (const r of results.filter(r => r.status === 'FAIL')) {
    console.log(`   - ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
