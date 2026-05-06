import { get_encoding } from "tiktoken";
import { sessionUsageCache, Usage } from "./cache";
import { readFile } from "fs/promises";
import { readFileSync } from "fs";
import { opendir, stat } from "fs/promises";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR, HOME_DIR } from "@CCR/shared";
import { LRUCache } from "lru-cache";
import { ConfigService } from "../services/config";
import { TokenizerService } from "../services/tokenizer";
import { ProviderService } from "../services/provider";
import {
  classifyAndRoute,
  detectAndCleanSubagentTag,
  extractLastUserMessage,
  TokenSaverConfig,
} from "./token-saver";
import {
  getSessionState,
  updateSessionState,
  setOrchestrating,
  isOrchestrating,
} from "./session-state";

// Types from @anthropic-ai/sdk
interface Tool {
  name: string;
  description?: string;
  input_schema: object;
}

interface ContentBlockParam {
  type: string;
  [key: string]: any;
}

interface MessageParam {
  role: string;
  content: string | ContentBlockParam[];
}

interface MessageCreateParamsBase {
  messages?: MessageParam[];
  system?: string | any[];
  tools?: Tool[];
  [key: string]: any;
}

const enc = get_encoding("cl100k_base");

export const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (contentPart.type === "tool_use") {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += enc.encode(item.text).length;
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

const getProjectSpecificRouter = async (
  req: any,
  configService: ConfigService
) => {
  // Check if there is project-specific configuration
  if (req.sessionId) {
    const project = await searchProjectBySession(req.sessionId);
    if (project) {
      const projectConfigPath = join(HOME_DIR, project, "config.json");
      const sessionConfigPath = join(
        HOME_DIR,
        project,
        `${req.sessionId}.json`
      );

      // First try to read sessionConfig file
      try {
        const sessionConfig = JSON.parse(await readFile(sessionConfigPath, "utf8"));
        if (sessionConfig && sessionConfig.Router) {
          return sessionConfig.Router;
        }
      } catch {}
      try {
        const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
        if (projectConfig && projectConfig.Router) {
          return projectConfig.Router;
        }
      } catch {}
    }
  }
  return undefined; // Return undefined to use original configuration
};

const getUseModel = async (
  req: any,
  tokenCount: number,
  configService: ConfigService,
  lastUsage?: Usage | undefined,
  providerService?: ProviderService,
): Promise<{ model: string; scenarioType: RouterScenarioType }> => {
  const projectSpecificRouter = await getProjectSpecificRouter(req, configService);
  const providers = configService.get<any[]>("providers") || [];
  const Router = projectSpecificRouter || configService.get("Router");

  // 1. Direct provider,model specification bypasses routing —
  //    BUT when Token-Saver is enabled, let it classify so AutoOrchestrate can trigger.
  const tokenSaverConfig = Router?.tokenSaver as TokenSaverConfig | undefined;
  if (req.body.model.includes(",") && !tokenSaverConfig?.enabled) {
    const [provider, model] = req.body.model.split(",");
    const finalProvider = providers.find(
      (p: any) => p.name.toLowerCase() === provider
    );
    const finalModel = finalProvider?.models?.find(
      (m: any) => m.toLowerCase() === model
    );
    if (finalProvider && finalModel) {
      return { model: `${finalProvider.name},${finalModel}`, scenarioType: 'default' };
    }
    return { model: req.body.model, scenarioType: 'default' };
  }

  // 2. Token-Saver: when enabled, fully takes over routing (user query + subagent)
  if (tokenSaverConfig?.enabled && providerService) {
    const isSubagent = detectAndCleanSubagentTag(req);

    // Sub-agent differential routing via subagentPolicy
    if (isSubagent) {
      const policy = tokenSaverConfig.subagentPolicy ?? "skip";
      req.isSubagent = true;

      if (policy === "skip") {
        req.log.info(`[TokenSaver] subagent policy=skip → using default model`);
        return { model: Router?.default, scenarioType: 'tokenSaver' };
      }
      if (policy === "judge") {
        if (req.sessionId) {
          const subKey = `${req.sessionId}:sub`;
          const msgCount = req.body.messages?.length ?? 0;

          if (msgCount > 1) {
            const sticky = getSessionState(subKey);
            if (sticky?.stickyModel) {
              req.tokenSaverTier = sticky.stickyTier;
              req.log.info(`[TokenSaver] subagent sticky hit → tier=${sticky.stickyTier} model=${sticky.stickyModel} (msgs=${msgCount})`);
              return { model: sticky.stickyModel, scenarioType: 'tokenSaver' };
            }
          }
          req.log.info(`[TokenSaver] subagent policy=judge → new sub-agent (msgs=${msgCount}), running LLM classification`);
        }
        // fall through to judge classification below
      } else if (policy === "inherit" && req.sessionId) {
        const sticky = getSessionState(req.sessionId);
        if (sticky?.stickyModel) {
          req.tokenSaverTier = sticky.stickyTier;
          req.log.info(`[TokenSaver] subagent policy=inherit → tier=${sticky.stickyTier} model=${sticky.stickyModel}`);
          return { model: sticky.stickyModel, scenarioType: 'tokenSaver' };
        }
        // no sticky yet → fall through to judge
      } else if (policy === "fixed" && tokenSaverConfig.subagentModel) {
        req.log.info(`[TokenSaver] subagent policy=fixed → model=${tokenSaverConfig.subagentModel}`);
        return { model: tokenSaverConfig.subagentModel, scenarioType: 'tokenSaver' };
      }
      // unknown policy or fallback → fall through to judge
    }

    // Main agent (or subagent fallthrough): run LLM judge classification
    const userMessage = extractLastUserMessage(req.body.messages);
    if (userMessage) {
      const httpsProxy = configService.getHttpsProxy();
      const result = await classifyAndRoute(userMessage, tokenSaverConfig, providerService, httpsProxy);
      if (result) {
        req.tokenSaverTier = result.tier;
        req.isSubagent = isSubagent;
        if (req.sessionId) {
          const storeKey = isSubagent ? `${req.sessionId}:sub` : req.sessionId;
          updateSessionState(storeKey, result.tier, result.model);
        }
        req.log.info(`[TokenSaver] tier=${result.tier} model=${result.model} subagent=${isSubagent}`);
        return { model: result.model, scenarioType: 'tokenSaver' };
      }
    }

    // Classify failed — fallback to defaultTier
    const fallbackTier = tokenSaverConfig.defaultTier || Object.keys(tokenSaverConfig.tiers)[0];
    const fallbackTarget = tokenSaverConfig.tiers[fallbackTier];
    if (fallbackTarget) {
      req.tokenSaverTier = fallbackTier;
      req.isSubagent = isSubagent;
      if (req.sessionId) {
        const storeKey = isSubagent ? `${req.sessionId}:sub` : req.sessionId;
        updateSessionState(storeKey, fallbackTier, fallbackTarget.model);
      }
      req.log.info(`[TokenSaver] fallback tier=${fallbackTier} model=${fallbackTarget.model}`);
      return { model: fallbackTarget.model, scenarioType: 'tokenSaver' };
    }
  }

  // 3. Original routing logic (when Token-Saver is disabled or not configured)

  const longContextThreshold = Router?.longContextThreshold || 60000;
  const lastUsageThreshold =
    lastUsage &&
    lastUsage.input_tokens > longContextThreshold &&
    tokenCount > 20000;
  const tokenCountThreshold = tokenCount > longContextThreshold;
  if ((lastUsageThreshold || tokenCountThreshold) && Router?.longContext) {
    req.log.info(
      `Using long context model due to token count: ${tokenCount}, threshold: ${longContextThreshold}`
    );
    return { model: Router.longContext, scenarioType: 'longContext' };
  }
  if (
    req.body?.system?.length > 1 &&
    req.body?.system[1]?.text?.startsWith("<CCR-SUBAGENT-MODEL>")
  ) {
    const model = req.body?.system[1].text.match(
      /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
    );
    if (model) {
      req.body.system[1].text = req.body.system[1].text.replace(
        `<CCR-SUBAGENT-MODEL>${model[1]}</CCR-SUBAGENT-MODEL>`,
        ""
      );
      return { model: model[1], scenarioType: 'default' };
    }
  }
  const globalRouter = configService.get("Router");
  if (
    req.body.model?.includes("claude") &&
    req.body.model?.includes("haiku") &&
    globalRouter?.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    return { model: globalRouter.background, scenarioType: 'background' };
  }
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    Router?.webSearch
  ) {
    return { model: Router.webSearch, scenarioType: 'webSearch' };
  }
  if (req.body.thinking && Router?.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    return { model: Router.think, scenarioType: 'think' };
  }
  return { model: Router?.default, scenarioType: 'default' };
};

export interface AutoOrchestrateConfig {
  enabled: boolean;
  mainAgentModel?: string;
  skillPath?: string;
  triggerTiers?: string[];
  blockedTools?: string[];
  slimSystemPrompt?: boolean;
}

export interface RouterContext {
  configService: ConfigService;
  tokenizerService?: TokenizerService;
  providerService?: ProviderService;
  event?: any;
}

export type RouterScenarioType = 'default' | 'background' | 'think' | 'longContext' | 'webSearch' | 'tokenSaver';

export interface RouterFallbackConfig {
  default?: string[];
  background?: string[];
  think?: string[];
  longContext?: string[];
  webSearch?: string[];
  tokenSaver?: string[];
}

const BUILTIN_ORCHESTRATE_PROMPT = `# SYSTEM OVERRIDE — ORCHESTRATOR MODE

**This overrides all other instructions. You are an ORCHESTRATOR, not an executor.**

## Absolute prohibitions

1. **Do NOT generate final deliverables yourself** (code, docs, configs) — output is produced by sub-agents
2. **Do NOT start work without delegating via the Agent tool** — all real work must go through Agent()
3. **Do NOT call tools beyond what is listed in the "Allowed" section below**
4. **Do NOT spawn read-only or status-check agents** — NEVER call Agent() just to "check progress", "verify results", "monitor status", or "diagnose issues". Use your own allowed tools (Read, ls, cat) for these.
5. **Do NOT spawn follow-up agents for the same step** — if a step fails, retry it ONCE with a more specific prompt, then move on or report failure.

## Your only workflow

Receive task → Present decomposition plan AND call Agent() in the SAME response → Stop and wait → Result received → review → call Agent() for the next step → All done → summarize to user

## Agent() usage

Agent({ description: "<short 3-5 word label>", prompt: "<self-contained, complete task description>" })

**CRITICAL: Do NOT pass \`model\`, \`isolation\`, or any parameter other than \`description\` and \`prompt\`.** The system automatically selects the optimal model and environment.

Prompt rules (sub-agents cannot see your context):
- Include all file paths, URLs, and format requirements
- **Include a concrete execution strategy** — tell the sub-agent HOW to do the work, not just WHAT to do
- If the workspace contains relevant skill files, tell the sub-agent the path so it can read them
- If the task depends on a previous step's output, specify file paths and content structure
- One task per Agent() call

## After calling Agent()

Agent() is a **blocking tool call**. The workflow is:
1. You call Agent() — you receive an initial "launched" confirmation
2. The sub-agent runs and completes its work
3. You receive the **final result** as a follow-up message

**CRITICAL**: The "Async agent launched successfully" message is NOT the final result.
You MUST continue the conversation and wait for the sub-agent's completed output.
NEVER end your turn with only a "launched/started" status — that means NO work was done.

When you receive the completed result:
- **Verify output** using your allowed tools (Read, ls, cat) — check that files exist and content looks correct
- If output has obvious errors or is incomplete, spawn ONE refinement agent with specific fix instructions
- Call Agent() for the next step, OR
- Summarize if all steps are done

## Refinement pass (important!)

After ALL steps are complete, do a **final verification** before summarizing:
1. Use Read / cat to inspect the key output files
2. Check for obvious issues: missing files, empty content, wrong format, logical errors
3. If issues are found, spawn ONE final Agent() with precise fix instructions referencing the specific problems
4. Only summarize after verification passes

This refinement step is critical for quality — sub-agents work in isolated worktrees and may miss cross-step dependencies or produce subtly wrong results.

## Allowed direct actions (only these)

- Read (inspect and verify output files)
- Shell commands limited to: ls, cat, head, tail, wc, grep, mkdir, cp (file inspection)
- Present plans and progress to the user`;

function loadOrchestratePrompt(skillPath?: string): string {
  if (skillPath) {
    try {
      const resolved = skillPath.startsWith("~")
        ? skillPath.replace("~", process.env.HOME || "/tmp")
        : skillPath;
      return readFileSync(resolved, "utf-8").replace(/^---[\s\S]*?---\n*/, "").trim();
    } catch {
      // fall through to builtin
    }
  }
  return BUILTIN_ORCHESTRATE_PROMPT;
}

export const router = async (req: any, _res: any, context: RouterContext) => {
  const { configService, providerService, event } = context;
  // Parse sessionId from metadata.user_id
  // Supports both JSON format (Claude Agent SDK): {"session_id":"...","device_id":"..."}
  // and legacy string format: "userXXX_session_YYY"
  if (req.body.metadata?.user_id) {
    const userId = req.body.metadata.user_id;
    if (typeof userId === 'string') {
      try {
        const parsed = JSON.parse(userId);
        if (parsed.session_id) {
          req.sessionId = parsed.session_id;
        }
      } catch {
        const parts = userId.split("_session_");
        if (parts.length > 1) {
          req.sessionId = parts[1];
        }
      }
    }
  }
  const lastMessageUsage = sessionUsageCache.get(req.sessionId);
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
  const rewritePrompt = configService.get("REWRITE_SYSTEM_PROMPT");
  if (
    rewritePrompt &&
    system.length > 1 &&
    system[1]?.text?.includes("<env>")
  ) {
    const prompt = await readFile(rewritePrompt, "utf-8");
    system[1].text = `${prompt}<env>${system[1].text.split("<env>").pop()}`;
  }

  try {
    // Try to get tokenizer config for the current model
    const [providerName, modelName] = req.body.model.split(",");
    const tokenizerConfig = context.tokenizerService?.getTokenizerConfigForModel(
      providerName,
      modelName
    );

    // Use TokenizerService if available, otherwise fall back to legacy method
    let tokenCount: number;

    if (context.tokenizerService) {
      const result = await context.tokenizerService.countTokens(
        {
          messages: messages as MessageParam[],
          system,
          tools: tools as Tool[],
        },
        tokenizerConfig
      );
      tokenCount = result.tokenCount;
    } else {
      // Legacy fallback
      tokenCount = calculateTokenCount(
        messages as MessageParam[],
        system,
        tools as Tool[]
      );
    }

    let model;
    const customRouterPath = configService.get("CUSTOM_ROUTER_PATH");
    if (customRouterPath) {
      try {
        const customRouter = require(customRouterPath);
        req.tokenCount = tokenCount; // Pass token count to custom router
        model = await customRouter(req, configService.getAll(), {
          event,
        });
      } catch (e: any) {
        req.log.error(`failed to load custom router: ${e.message}`);
      }
    }
    if (!model) {
      const result = await getUseModel(req, tokenCount, configService, lastMessageUsage, providerService);
      model = result.model;
      req.scenarioType = result.scenarioType;
    } else {
      req.scenarioType = 'default';
    }
    req.body.model = model;

    // Auto-Orchestrate: inject orchestration prompt + strip tools for complex tasks
    // Mirrors ClawXRouter: prompt injection (before_prompt_build) + tool blocking (before_tool_call)
    const routerConfig = configService.get<any>("Router");
    const autoOrch = routerConfig?.autoOrchestrate as AutoOrchestrateConfig | undefined;
    if (autoOrch?.enabled && req.sessionId && req.scenarioType === 'tokenSaver') {
      const triggerTiers = autoOrch.triggerTiers ?? ["COMPLEX", "REASONING"];
      const shouldOrchestrate = triggerTiers.includes(req.tokenSaverTier ?? "");
      const alreadyOrch = isOrchestrating(req.sessionId);

      if (shouldOrchestrate || alreadyOrch) {
        if (shouldOrchestrate && !alreadyOrch) {
          setOrchestrating(req.sessionId, true);
        }

        // Detect main agent vs sub-agent: main agent has the Agent tool, sub-agents don't.
        // ClawXRouter uses separate sessionKeys; here we check the tool list.
        const hasAgentTool = Array.isArray(req.body.tools) &&
          req.body.tools.some((t: any) => (t.name || t.function?.name) === "Agent");
        const isMainAgent = hasAgentTool && !req.isSubagent;

        if (isMainAgent) {
          // Model override — only for the orchestrator, not sub-agents
          if (autoOrch.mainAgentModel) {
            req.body.model = autoOrch.mainAgentModel;
            req.log.info(`[AutoOrchestrate] overriding model to ${autoOrch.mainAgentModel}`);
          }

          // Prompt injection — only for the orchestrator
          // Inject as a user-level <system-reminder> message instead of modifying system blocks.
          // This preserves the entire system array (both global and org cache scopes) untouched,
          // which is critical when MCP tools are present (skipGlobalCacheForSystemPrompt mode).
          // Tool stripping provides the hard constraint; this prompt provides soft guidance.
          const orchPrompt = loadOrchestratePrompt(autoOrch.skillPath);
          if (orchPrompt && Array.isArray(req.body.messages)) {
            const tier = req.tokenSaverTier ?? "COMPLEX";
            req.body.messages.unshift({
              role: "user",
              content: `<system-reminder>\n<auto-orchestrate tier="${tier}">\n${orchPrompt}\n</auto-orchestrate>\n</system-reminder>`,
            });
            req.log.info(`[AutoOrchestrate] injected orchestration prompt as user message (tier=${tier}, ${orchPrompt.length} chars)`);
          }

          // Tool stripping — remove executor tools so orchestrator MUST delegate via Agent()
          // Equivalent to ClawXRouter's before_tool_call block
          if (Array.isArray(req.body.tools)) {
            const blockedPatterns = autoOrch.blockedTools ?? [
              "mcp__browser-use__", "WebSearch", "WebFetch",
            ];
            const before = req.body.tools.length;
            req.body.tools = req.body.tools.filter((tool: any) => {
              const name = tool.name || tool.function?.name || "";
              return !blockedPatterns.some((p: string) => name.startsWith(p));
            });
            const removed = before - req.body.tools.length;
            if (removed > 0) {
              req.log.info(`[AutoOrchestrate] stripped ${removed} executor tools (${before}->${req.body.tools.length})`);
            }
          }

          // System prompt slimming — replace the orchestrator's verbose system prompt
          // with a minimal version to save ~20K input tokens per request.
          // The orchestration prompt (injected as user message above) provides all
          // the behavioral instructions the orchestrator needs.
          // Memory recall blocks are preserved so the orchestrator retains long-term
          // context when deciding how to decompose and delegate tasks.
          if (autoOrch.slimSystemPrompt !== false && Array.isArray(req.body.system)) {
            const originalBlocks = req.body.system.length;
            let originalTokensEstimate = 0;
            for (const block of req.body.system) {
              if (block.text) originalTokensEstimate += block.text.length;
            }

            const firstBlock = req.body.system[0];
            const cacheControl = firstBlock?.cache_control;

            const memoryKeywords = ["ClawXMemory", "memory_search", "memory_overview", "memory_get", "memory_list", "memory_flush", "memory_dream"];
            const preservedBlocks = req.body.system.filter((block: any) =>
              block.text && memoryKeywords.some((kw: string) => block.text.includes(kw))
            );

            const slimBlock = {
              type: "text",
              text: "You are Claude Code, an orchestration agent. Use the Agent tool to delegate all work to sub-agents.",
              ...(cacheControl ? { cache_control: cacheControl } : {}),
            };
            req.body.system = [slimBlock, ...preservedBlocks];

            let newTokensEstimate = 0;
            for (const block of req.body.system) {
              if (block.text) newTokensEstimate += block.text.length;
            }
            const savedChars = originalTokensEstimate - newTokensEstimate;
            req.log.info(
              `[AutoOrchestrate] slimmed system prompt: ${originalBlocks} blocks (~${Math.round(originalTokensEstimate / 4)} tokens) → ${req.body.system.length} blocks (~${Math.round(newTokensEstimate / 4)} tokens), saved ~${Math.round(savedChars / 4)} tokens${preservedBlocks.length > 0 ? `, preserved ${preservedBlocks.length} memory block(s)` : ""}`
            );
          }
        } else {
          // Sub-agents in an orchestrated session: let Token-Saver classification
          // decide the model (SIMPLE/MEDIUM → cheap, COMPLEX/REASONING → powerful).
          // Previously this forced mainAgentModel on all sub-agents, wasting budget.
          req.log.info(`[AutoOrchestrate] sub-agent request, model decided by Token-Saver: ${req.body.model}`);
        }
      }
    }

    // Rewrite "Async agent launched" tool_result for non-Claude models.
    // Non-Claude orchestrators (e.g. gpt-5.x) treat this as a final result and
    // stop their turn ("fire and forget"). Replacing it with a directive that
    // demands a follow-up tool call keeps the agentic loop alive.
    const autoOrchConfig = routerConfig?.autoOrchestrate as AutoOrchestrateConfig | undefined;
    if (
      autoOrchConfig?.enabled &&
      req.body.model &&
      !req.body.model.includes("claude") &&
      Array.isArray(req.body.messages)
    ) {
      for (const msg of req.body.messages) {
        if (msg.role === "user" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_result" && Array.isArray(block.content)) {
              for (const part of block.content) {
                if (
                  part.type === "text" &&
                  part.text &&
                  part.text.includes("Async agent launched")
                ) {
                  part.text =
                    "AGENT RESULT PENDING. The sub-agent is executing and will return its output shortly. " +
                    "While waiting, you MUST call a tool to keep the session alive. " +
                    "Use: ls /tmp_workspace/results/ to check progress. " +
                    "IMPORTANT: If you respond with ONLY text and no tool call, the session will TERMINATE immediately and all work will be lost.";
                  req.log.info(
                    "[AutoOrchestrate] rewrote Async-agent-launched tool_result for non-Claude model"
                  );
                }
              }
            }
          }
        }
      }
    }

    // Debug dump — write the final request body to /tmp/ccr-debug/ for inspection
    if (process.env.CCR_DEBUG_DUMP) {
      try {
        const { mkdirSync, writeFileSync } = await import("fs");
        const dumpDir = "/tmp/ccr-debug";
        mkdirSync(dumpDir, { recursive: true });
        const ts = Date.now();
        const sessionTag = req.sessionId ? req.sessionId.slice(0, 8) : "nosess";
        const isMain = Array.isArray(req.body.tools) &&
          req.body.tools.some((t: any) => (t.name || t.function?.name) === "Agent");
        const tag = isMain ? "main" : "sub";
        const filename = `${dumpDir}/${ts}-${sessionTag}-${tag}-req.json`;
        const dump = {
          sessionId: req.sessionId,
          scenarioType: req.scenarioType,
          tokenSaverTier: req.tokenSaverTier,
          isSubagent: req.isSubagent,
          model: req.body.model,
          system: req.body.system,
          messages: req.body.messages,
          tools: (req.body.tools || []).map((t: any) => t.name || t.function?.name),
        };
        writeFileSync(filename, JSON.stringify(dump, null, 2));
        req.log.info(`[DEBUG] dumped request to ${filename}`);
      } catch (e: any) {
        req.log.error(`[DEBUG] dump failed: ${e.message}`);
      }
    }
  } catch (error: any) {
    req.log.error(`Error in router middleware: ${error.message}`);
    const Router = configService.get("Router");
    req.body.model = Router?.default;
    req.scenarioType = 'default';
  }
  return;
};

// Memory cache for sessionId to project name mapping
// null value indicates previously searched but not found
// Uses LRU cache with max 1000 entries
const sessionProjectCache = new LRUCache<string, string>({
  max: 1000,
});

export const searchProjectBySession = async (
  sessionId: string
): Promise<string | null> => {
  // Check cache first
  if (sessionProjectCache.has(sessionId)) {
    const result = sessionProjectCache.get(sessionId);
    if (!result || result === '') {
      return null;
    }
    return result;
  }

  try {
    const dir = await opendir(CLAUDE_PROJECTS_DIR);
    const folderNames: string[] = [];

    // Collect all folder names
    for await (const dirent of dir) {
      if (dirent.isDirectory()) {
        folderNames.push(dirent.name);
      }
    }

    // Concurrently check each project folder for sessionId.jsonl file
    const checkPromises = folderNames.map(async (folderName) => {
      const sessionFilePath = join(
        CLAUDE_PROJECTS_DIR,
        folderName,
        `${sessionId}.jsonl`
      );
      try {
        const fileStat = await stat(sessionFilePath);
        return fileStat.isFile() ? folderName : null;
      } catch {
        // File does not exist, continue checking next
        return null;
      }
    });

    const results = await Promise.all(checkPromises);

    // Return the first existing project directory name
    for (const result of results) {
      if (result) {
        // Cache the found result
        sessionProjectCache.set(sessionId, result);
        return result;
      }
    }

    // Cache not found result (null value means previously searched but not found)
    sessionProjectCache.set(sessionId, '');
    return null; // No matching project found
  } catch (error) {
    console.error("Error searching for project by session:", error);
    // Cache null result on error to avoid repeated errors
    sessionProjectCache.set(sessionId, '');
    return null;
  }
};
