/**
 * Default Router configuration for CCR (Claude Code Router).
 *
 * Embedded in source code so the routing strategy is version-controlled.
 * YAML config (~/.edgeclaw/config.yaml) or ccr-config.json can override
 * any of these values; when their Router/tokenSaver/autoOrchestrate
 * sections are absent or incomplete, these defaults fill in.
 */

export const DEFAULT_TOKEN_SAVER = {
  enabled: false,
  judgeProvider: "judge",
  judgeModel: "gemini-2.5-flash",
  defaultTier: "MEDIUM",
  tiers: {
    SIMPLE: {
      model: "yeysai,minimax-m2.5",
      description:
        "1-2 steps: one file read/write, one command, one factual answer, a short confirmation or safety refusal.",
    },
    MEDIUM: {
      model: "yeysai,minimax-m2.5",
      description:
        "3-20 steps using one or two skills: web scraping, multi-file search, code editing, data extraction, chat analysis, format conversion, or a combination of read+process+write. A single capable agent can complete the task end-to-end without help.",
    },
    COMPLEX: {
      model: "yeysai,gpt-5.4",
      description:
        "Requires TRUE multi-stage pipeline where stages have different skill requirements AND intermediate outputs must be validated before proceeding. Examples: fetch data from API then write processing code then run code then verify output then generate report. NOT just many steps — the steps must require fundamentally different capabilities.",
    },
    REASONING: {
      model: "yeysai,gpt-5.4",
      description:
        "Deep algorithmic reasoning WITHOUT needing multi-agent orchestration: constraint solving, graph traversal, puzzle solving, long-context precise reasoning with contradiction tracking, or multi-modal creative generation.",
    },
  },
  subagentPolicy: "judge",
  rules: [
    "SIMPLE: 1-2 steps: one file read/write, one command, one factual answer, a short confirmation or safety refusal.",
    "MEDIUM: 3-20 steps using one or two skills: web scraping, multi-file search, code editing, data extraction, chat analysis, format conversion, or read+process+write. A single capable agent can complete the task end-to-end without help.",
    "COMPLEX: TRUE multi-stage pipeline where stages have different skill requirements AND intermediate outputs must be validated before proceeding. NOT just many steps — the steps must require fundamentally different capabilities.",
    "REASONING: Deep algorithmic reasoning WITHOUT needing multi-agent orchestration: constraint solving, graph traversal, puzzle solving, long-context reasoning with contradiction tracking, or creative generation.",
    "Classify by the HARDEST sub-task required, not the average.",
    "Most tasks are MEDIUM. Only classify as COMPLEX if no single agent could reasonably handle all steps alone.",
    "REASONING is for tasks that need a STRONGER model for reasoning quality but NOT for task splitting. COMPLEX is specifically for tasks that BENEFIT from splitting into sub-agents.",
  ],
} as const;

export const DEFAULT_AUTO_ORCHESTRATE = {
  enabled: false,
  triggerTiers: ["COMPLEX"],
  mainAgentModel: "yeysai,gpt-5.4",
  skillPath: "/opt/claude-code/src/router/src/prompts/auto-orchestrate.md",
  slimSystemPrompt: true,
  allowedTools: ["Agent", "Read", "Grep", "Glob", "TodoRead", "TodoWrite"],
  subagentMaxTokens: 48000,
} as const;

export const DEFAULT_ROUTER_CONFIG = {
  default: "yeysai,minimax-m2.5",
  tokenSaver: DEFAULT_TOKEN_SAVER,
  autoOrchestrate: DEFAULT_AUTO_ORCHESTRATE,
} as const;
