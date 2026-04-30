/**
 * Lightweight ~/.edgeclaw/config.yaml validator owned by the desktop shell.
 *
 * Why this lives here (not in ui/server):
 *   - We need to decide *before spawning the server* whether the config is
 *     usable. The server's load-env.js does a similar check but only after
 *     the child has already crashed — by which point the user is staring at
 *     a 60-second progress bar and an ANSI-soup error log tail.
 *   - The desktop shell can't import the server's bundled
 *     edgeclawConfig.js at electron build time (that lives in a runtime tar
 *     extracted to ~/Library/Application Support/EdgeClaw/runtime/<v>/), so
 *     we duck-type the same minimal contract that load-env.js asserts:
 *       1. there is a "main" agent model entry that resolves
 *       2. that entry's provider has a non-empty baseUrl + apiKey
 *       3. the entry has a non-empty `name` (the actual model id)
 *
 * Failure modes we explicitly catch (the ones users hit in the wild):
 *   - File exists but is empty / "version: 1" only
 *   - File holds an old schema (no models.providers.<x>)
 *   - Provider exists but baseUrl or apiKey is empty (e.g. user deleted the
 *     value while keeping the key)
 *   - models.entries.default.name is empty
 *   - models.entries.default.provider points at a non-existent provider
 */

import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";

export type ConfigValidationResult =
  | { ok: true }
  | { ok: false; reason: string; missing: string[] };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateEdgeClawConfigFile(
  configPath: string,
): ConfigValidationResult {
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      reason: `配置文件不存在：${configPath}`,
      missing: ["config.yaml"],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    return {
      ok: false,
      reason: `无法读取配置文件：${e instanceof Error ? e.message : String(e)}`,
      missing: ["config.yaml"],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    return {
      ok: false,
      reason: `配置文件 YAML 解析失败：${
        e instanceof Error ? e.message : String(e)
      }`,
      missing: ["config.yaml"],
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: "配置文件内容不是合法的 YAML 对象",
      missing: ["models", "agents"],
    };
  }

  const agents = isRecord(parsed.agents) ? parsed.agents : {};
  const main = isRecord(agents.main) ? agents.main : {};
  const mainModelId = nonEmptyString(main.model) ? main.model : "default";

  const models = isRecord(parsed.models) ? parsed.models : {};
  const entries = isRecord(models.entries) ? models.entries : {};
  const entry = isRecord(entries[mainModelId]) ? entries[mainModelId] : null;

  const missing: string[] = [];
  if (!entry) {
    missing.push(`models.entries.${mainModelId}`);
  }

  const providers = isRecord(models.providers) ? models.providers : {};
  const providerId =
    entry && nonEmptyString(entry.provider) ? entry.provider : "";
  const provider =
    providerId && isRecord(providers[providerId]) ? providers[providerId] : null;

  if (entry && !provider) {
    missing.push(`models.providers.${providerId || "<unset>"}`);
  }

  if (entry && !nonEmptyString(entry.name)) {
    missing.push(`models.entries.${mainModelId}.name`);
  }
  if (provider && !nonEmptyString(provider.baseUrl)) {
    missing.push(`models.providers.${providerId}.baseUrl`);
  }
  if (provider && !nonEmptyString(provider.apiKey)) {
    missing.push(`models.providers.${providerId}.apiKey`);
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `配置文件缺少以下字段：${missing.join(", ")}`,
      missing,
    };
  }

  return { ok: true };
}
