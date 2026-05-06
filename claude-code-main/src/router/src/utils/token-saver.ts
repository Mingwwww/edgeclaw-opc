import { ProviderService } from "../services/provider";

// ── Types ──

export interface TokenSaverConfig {
  enabled: boolean;
  judgeProvider: string;
  judgeModel: string;
  tiers: Record<string, TierTarget>;
  defaultTier?: string;
  rules?: string[];
  subagentPolicy?: "skip" | "judge" | "inherit" | "fixed";
  subagentModel?: string;
}

export interface TierTarget {
  model: string;
  description?: string;
}

export interface ClassifyResult {
  model: string;
  tier: string;
}

// ── Prompt generation ──

export function generateJudgePrompt(
  tiers: Record<string, TierTarget>,
  rules?: string[],
): string {
  const tierNames = Object.keys(tiers);

  const tierDefs = tierNames
    .map((name) => {
      const desc = tiers[name].description;
      return desc ? `${name} = ${desc}` : name;
    })
    .join("\n");

  const allRules = rules ?? [];
  const rulesBlock = allRules.map((r) => `- ${r}`).join("\n");

  const tierList = tierNames.join("|");

  return [
    "You are a task complexity classifier. Classify the user's task into exactly one tier.",
    "",
    tierDefs,
    "",
    "Rules:",
    rulesBlock,
    "",
    `CRITICAL: Output ONLY the raw JSON object. Do NOT wrap in markdown code blocks. Do NOT add any text before or after.`,
    `{"tier":"${tierList}"}`,
  ].join("\n");
}

// ── Response parsing ──

export function parseTier(
  response: string,
  validTiers: Set<string>,
  defaultTier: string,
): string {
  try {
    const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*?"tier"\s*:\s*"([A-Za-z_]+)"[\s\S]*?\}/);
    if (match) {
      const tier = match[1].toUpperCase();
      if (validTiers.has(tier)) return tier;
    }
  } catch {
    // parse failure
  }
  return defaultTier;
}

// ── Message extraction ──

export function extractLastUserMessage(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const texts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) texts.push(block.text);
        if (block.type === "tool_result") {
          if (typeof block.content === "string") texts.push(block.content);
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return "";
}

// ── Sub-agent detection ──

export function detectAndCleanSubagentTag(req: any): boolean {
  // Method 1: ClawXRouter-style explicit tag in system prompt
  if (
    req.body?.system?.length > 1 &&
    req.body.system[1]?.text?.startsWith("<CCR-SUBAGENT-MODEL>")
  ) {
    req.body.system[1].text = req.body.system[1].text.replace(
      /<CCR-SUBAGENT-MODEL>.*?<\/CCR-SUBAGENT-MODEL>/s,
      "",
    );
    return true;
  }
  // Method 2: Claude Code — sub-agents lack the Agent tool
  const tools = req.body?.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const hasAgentTool = tools.some(
      (t: any) => (t.name || t.function?.name) === "Agent"
    );
    if (!hasAgentTool) return true;
  }
  return false;
}

// ── Judge call ──

async function callJudge(
  providerService: ProviderService,
  config: TokenSaverConfig,
  prompt: string,
  httpsProxy?: string,
): Promise<string> {
  const provider = providerService.getProvider(config.judgeProvider);
  if (!provider) {
    throw new Error(`Judge provider '${config.judgeProvider}' not found — set judgeProvider in tokenSaver config`);
  }
  const modelName = config.judgeModel;

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: "system", content: generateJudgePrompt(config.tiers, config.rules) },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 256,
    }),
  };

  if (httpsProxy && !process.env.HTTPS_PROXY) {
    process.env.HTTPS_PROXY = httpsProxy;
  }

  // provider.baseUrl may already include the endpoint path (e.g. /chat/completions)
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  const targetUrl = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const nativeFetch = (globalThis as any).__originalFetch ?? fetch;
  const response = await nativeFetch(targetUrl, fetchOptions);

  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) {
    console.warn(`[TokenSaver] judge empty response: status=${response.status} body=${JSON.stringify(data).slice(0,200)}`);
  }
  return content;
}

// ── Main classification entry point ──

export async function classifyAndRoute(
  userMessage: string,
  config: TokenSaverConfig,
  providerService: ProviderService,
  httpsProxy?: string,
): Promise<ClassifyResult | null> {
  const tierNames = Object.keys(config.tiers);
  if (tierNames.length === 0) return null;

  const validTiers = new Set(tierNames);
  const defaultTier =
    config.defaultTier && validTiers.has(config.defaultTier)
      ? config.defaultTier
      : tierNames[Math.floor(tierNames.length / 2)] ?? "MEDIUM";

  if (!userMessage.trim()) {
    const target = config.tiers[defaultTier];
    return target ? { model: target.model, tier: defaultTier } : null;
  }

  try {
    const responseText = await callJudge(providerService, config, userMessage, httpsProxy);
    const tier = parseTier(responseText, validTiers, defaultTier);
    console.error(`[TokenSaver] query="${userMessage.slice(0,40)}" → tier=${tier}`);
    const target = config.tiers[tier];
    return target ? { model: target.model, tier } : null;
  } catch (err) {
    console.error("[TokenSaver] judge call failed:", err);
    const target = config.tiers[defaultTier];
    return target ? { model: target.model, tier: defaultTier } : null;
  }
}
