/**
 * CCR Pipeline — in-process request processing without HTTP.
 *
 * Extracts the core routing/transform/forward/stats pipeline from the Fastify
 * route handler so it can be invoked directly from a `fetch` wrapper.
 *
 * Entry point: `processRequest(url, init, services, realFetch)`
 * Returns a standard `Response` (streaming or JSON) just like a real HTTP call.
 */

import { router } from "./utils/router";
import { sendUnifiedRequest } from "./utils/request";
import { getGlobalStatsCollector } from "./plugins/token-stats";
import { SSEParserTransform } from "./utils/sse";
import { ConfigService } from "./services/config";
import { ProviderService } from "./services/provider";
import { TransformerService } from "./services/transformer";
import { TokenizerService } from "./services/tokenizer";

export interface PipelineServices {
  configService: ConfigService;
  providerService: ProviderService;
  transformerService: TransformerService;
  tokenizerService: TokenizerService;
  logger: any;
}

const noopLog = {
  info: () => {},
  warn: () => {},
  error: (...a: any[]) => console.error("[CCR]", ...a),
  debug: () => {},
};

/**
 * Process an Anthropic-shaped request entirely in-process.
 * Mirrors the Fastify preHandler hooks + handleTransformerEndpoint flow.
 */
export async function processRequest(
  url: string,
  init: RequestInit | undefined,
  services: PipelineServices,
  realFetch: typeof globalThis.fetch
): Promise<Response> {
  const { configService, providerService, transformerService, tokenizerService, logger } = services;
  const log = logger || noopLog;

  const parsedUrl = new URL(url);
  const pathname = parsedUrl.pathname;

  // ── Non-/v1/messages routes: health, stats, info ──
  if (pathname.endsWith("/health")) {
    return Response.json({ status: "ok", timestamp: new Date().toISOString() });
  }
  if (pathname.endsWith("/api/stats/summary")) {
    const collector = getGlobalStatsCollector();
    return Response.json(collector ? collector.getSummary() : { error: "Token stats not enabled" });
  }
  if (pathname.endsWith("/api/stats/sessions")) {
    const collector = getGlobalStatsCollector();
    return Response.json(collector ? collector.getSessionStats() : { error: "Token stats not enabled" });
  }
  if (pathname.endsWith("/api/stats/hourly")) {
    const collector = getGlobalStatsCollector();
    return Response.json(collector ? collector.getHourly() : { error: "Token stats not enabled" });
  }
  if (pathname.endsWith("/api/stats/reset")) {
    const collector = getGlobalStatsCollector();
    if (collector) await collector.reset();
    return Response.json(collector ? { message: "Stats reset successfully" } : { error: "Token stats not enabled" });
  }
  if (pathname === "/" || pathname === "") {
    return Response.json({ message: "LLMs API", version: "2.0.0" });
  }

  // ── /v1/messages — main routing pipeline ──
  if (!pathname.endsWith("/v1/messages")) {
    return new Response(JSON.stringify({ error: `Unknown route: ${pathname}` }), { status: 404 });
  }

  let body: any;
  try {
    body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  if (!body.stream) body.stream = false;

  // Build a minimal request bag compatible with router()
  const req: any = {
    body,
    headers: init?.headers || {},
    log,
    id: `pipeline-${Date.now()}`,
    url: pathname,
    metadata: {},
  };

  // Phase 1: Router — mutates req.body.model, sets scenarioType/tier/etc.
  await router(req, null, { configService, tokenizerService, providerService });

  // Phase 2: Split "provider,model" from req.body.model
  if (!req.body.model) {
    return new Response(JSON.stringify({ error: "No model resolved by router" }), { status: 500 });
  }
  const [providerName, ...modelParts] = req.body.model.split(",");
  req.body.model = modelParts.join(",");
  req.provider = providerName;
  req.model = modelParts;

  // Phase 3: Resolve provider and transformer
  const provider = providerService.getProvider(providerName);
  if (!provider) {
    return new Response(JSON.stringify({ error: `Provider '${providerName}' not found` }), { status: 404 });
  }

  const transformersWithEndpoint = transformerService.getTransformersWithEndpoint();
  const anthropicTf = transformersWithEndpoint.find(
    (t: any) => t.transformer.endPoint === "/v1/messages"
  );
  if (!anthropicTf) {
    return new Response(JSON.stringify({ error: "No transformer for /v1/messages" }), { status: 500 });
  }
  const transformer = anthropicTf.transformer;

  try {
    // Phase 4: Request transformer chain
    const { requestBody, config, bypass } = await pipelineProcessRequestTransformers(
      body, provider, transformer, req.headers, { req }
    );

    // Phase 5: Send to real provider via realFetch
    const providerUrl = config.url || new URL(provider.baseUrl);

    if (bypass && typeof transformer.auth === "function") {
      const auth = await transformer.auth(requestBody, provider);
      if (auth.body) {
        Object.assign(config, auth.config || {});
        if (auth.config?.headers) {
          config.headers = { ...(config.headers || {}), ...auth.config.headers };
          delete config.headers.host;
        }
      }
    }

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${provider.apiKey}`,
      ...(config?.headers || {}),
    };
    for (const key in requestHeaders) {
      if (requestHeaders[key] === "undefined" ||
        (["authorization", "Authorization"].includes(key) && requestHeaders[key]?.includes("undefined"))) {
        delete requestHeaders[key];
      }
    }

    const response = await sendUnifiedRequest(
      providerUrl,
      bypass ? requestBody : requestBody,
      {
        httpsProxy: configService.getHttpsProxy(),
        ...config,
        headers: JSON.parse(JSON.stringify(requestHeaders)),
      },
      { req },
      log
    );

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`[provider_response_error] ${provider.name},${requestBody.model}: ${response.status}: ${errorText}`);

      // Try fallback
      const fallbackResponse = await handlePipelineFallback(
        req, body, provider, transformer, configService, providerService, transformerService, log
      );
      if (fallbackResponse) return fallbackResponse;

      return new Response(errorText, { status: response.status, headers: { "Content-Type": "application/json" } });
    }

    // Phase 6: Response transformer chain
    const finalResponse = await pipelineProcessResponseTransformers(
      requestBody, response, provider, transformer, bypass, { req }
    );

    // Phase 7: Stats collection
    collectStats(req, body, finalResponse);

    // Phase 8: Return
    if (body.stream === true) {
      return new Response(finalResponse.body, {
        status: finalResponse.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }
    const jsonBody = await finalResponse.json();
    return Response.json(jsonBody, { status: finalResponse.status });

  } catch (error: any) {
    log.error(`Pipeline error: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

// ── Internal helpers (extracted from routes.ts, adapted for pipeline use) ──

async function pipelineProcessRequestTransformers(
  body: any, provider: any, transformer: any, headers: any, context: any
) {
  let requestBody = body;
  let config: any = {};
  let bypass = false;

  bypass = (
    provider.transformer?.use?.length === 1 &&
    provider.transformer.use[0].name === transformer.name &&
    (!provider.transformer?.[body.model]?.use?.length ||
      (provider.transformer?.[body.model]?.use?.length === 1 &&
        provider.transformer?.[body.model]?.use[0].name === transformer.name))
  );

  if (bypass) {
    if (headers instanceof Headers) {
      headers.delete("content-length");
    } else if (headers && typeof headers === "object") {
      delete headers["content-length"];
    }
    config.headers = headers;
  }

  if (!bypass && typeof transformer.transformRequestOut === "function") {
    const transformOut = await transformer.transformRequestOut(requestBody);
    if (transformOut.body) {
      requestBody = transformOut.body;
      config = transformOut.config || {};
    } else {
      requestBody = transformOut;
    }
  }

  if (!bypass && provider.transformer?.use?.length) {
    for (const pt of provider.transformer.use) {
      if (!pt || typeof pt.transformRequestIn !== "function") continue;
      const result = await pt.transformRequestIn(requestBody, provider, context);
      if (result.body) {
        requestBody = result.body;
        config = { ...config, ...result.config };
      } else {
        requestBody = result;
      }
    }
  }

  if (!bypass && provider.transformer?.[body.model]?.use?.length) {
    for (const mt of provider.transformer[body.model].use) {
      if (!mt || typeof mt.transformRequestIn !== "function") continue;
      requestBody = await mt.transformRequestIn(requestBody, provider, context);
    }
  }

  return { requestBody, config, bypass };
}

async function pipelineProcessResponseTransformers(
  requestBody: any, response: any, provider: any, transformer: any, bypass: boolean, context: any
) {
  let finalResponse = response;

  if (!bypass && provider.transformer?.use?.length) {
    for (const pt of Array.from(provider.transformer.use).reverse() as any[]) {
      if (!pt || typeof pt.transformResponseOut !== "function") continue;
      finalResponse = await pt.transformResponseOut(finalResponse, context);
    }
  }

  if (!bypass && provider.transformer?.[requestBody.model]?.use?.length) {
    for (const mt of Array.from(provider.transformer[requestBody.model].use).reverse() as any[]) {
      if (!mt || typeof mt.transformResponseOut !== "function") continue;
      finalResponse = await mt.transformResponseOut(finalResponse, context);
    }
  }

  if (!bypass && transformer.transformResponseIn) {
    finalResponse = await transformer.transformResponseIn(finalResponse, context);
  }

  return finalResponse;
}

async function handlePipelineFallback(
  req: any, originalBody: any, _provider: any, transformer: any,
  configService: ConfigService, providerService: ProviderService,
  transformerService: TransformerService, log: any
): Promise<Response | null> {
  const scenarioType = req.scenarioType || "default";
  const fallbackConfig = configService.get<any>("fallback");
  if (!fallbackConfig || !fallbackConfig[scenarioType]) return null;

  const fallbackList = fallbackConfig[scenarioType] as string[];
  if (!Array.isArray(fallbackList) || fallbackList.length === 0) return null;

  for (const fallbackModel of fallbackList) {
    try {
      const [fbProvider, ...fbModelParts] = fallbackModel.split(",");
      const fbBody = { ...originalBody, model: fbModelParts.join(",") };
      const provider = providerService.getProvider(fbProvider);
      if (!provider) continue;

      const fbReq = { ...req, provider: fbProvider, body: fbBody };
      const { requestBody, config, bypass } = await pipelineProcessRequestTransformers(
        fbBody, provider, transformer, req.headers, { req: fbReq }
      );

      const requestHeaders: Record<string, string> = {
        Authorization: `Bearer ${provider.apiKey}`,
        ...(config?.headers || {}),
      };

      const response = await sendUnifiedRequest(
        config.url || new URL(provider.baseUrl),
        requestBody,
        {
          httpsProxy: configService.getHttpsProxy(),
          ...config,
          headers: JSON.parse(JSON.stringify(requestHeaders)),
        },
        { req: fbReq },
        log
      );

      if (!response.ok) continue;

      const finalResponse = await pipelineProcessResponseTransformers(
        requestBody, response, provider, transformer, bypass, { req: fbReq }
      );

      if (fbBody.stream === true) {
        return new Response(finalResponse.body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }
      const jsonBody = await finalResponse.json();
      return Response.json(jsonBody);
    } catch {
      continue;
    }
  }
  return null;
}

function collectStats(req: any, body: any, response: Response) {
  const collector = getGlobalStatsCollector();
  if (!collector) return;

  const sessionId = req.sessionId;
  if (!sessionId) return;

  const provider = req.provider || "unknown";
  const scenarioType = req.scenarioType || "default";
  const tier = req.tokenSaverTier as string | undefined;
  const isSubagent = req.isSubagent as boolean | undefined;
  const model = body.model || "unknown";

  if (body.stream === true && response.body) {
    const [originalStream, statsStream] = response.body.tee();

    const processUsage = async () => {
      try {
        const eventStream = statsStream
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new SSEParserTransform());
        const reader = eventStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.event === "message_delta" && value?.data?.usage) {
            const u = value.data.usage;
            collector.record({
              sessionId, provider, model, scenarioType, tier, isSubagent,
              usage: {
                input: u.input_tokens,
                output: u.output_tokens,
                cacheRead: u.cache_read_input_tokens,
              },
            });
            break;
          }
        }
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {}
    };
    processUsage().catch(() => {});

    Object.defineProperty(response, "body", { value: originalStream, writable: false });
  } else {
    const cloned = response.clone();
    cloned.json().then((json: any) => {
      if (json?.usage) {
        collector.record({
          sessionId, provider, model, scenarioType, tier, isSubagent,
          usage: {
            input: json.usage.input_tokens,
            output: json.usage.output_tokens,
            cacheRead: json.usage.cache_read_input_tokens,
          },
        });
      }
    }).catch(() => {});
  }
}

/**
 * Wrap globalThis.fetch to intercept requests targeting the sentinel URL.
 * Non-matching requests pass through to the original fetch.
 */
export function installFetchInterceptor(
  sentinelBaseUrl: string,
  services: PipelineServices
): void {
  const _originalFetch = globalThis.fetch;

  globalThis.fetch = async function ccrInterceptedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

    if (url.startsWith(sentinelBaseUrl)) {
      return processRequest(url, init, services, _originalFetch);
    }
    return _originalFetch(input, init);
  } as typeof globalThis.fetch;
}
