type Environment = {
  QWEN_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  QWEN_API_URL?: string;
  QWEN_MT_MODEL?: string;
  DASHSCOPE_WORKSPACE_ID?: string;
  TENCENT_SECRET_ID?: string;
  TENCENT_SECRET_KEY?: string;
  TENCENT_APP_ID?: string;
};

import { createIncrementalRefiner, validateIncrementalRequest } from "./incremental-refinement.mjs";
import { translationNeedsRetry } from "./translation-quality.mjs";
import { recordUsage, userFromRequest, withinMonthlyQuota } from "../../auth";

type QwenResponse = { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
type TranslateRequest = { text?: unknown; context?: unknown; terminology?: unknown; lectureId?: unknown; sessionId?: unknown; segmentId?: unknown; quality?: unknown };

const DEFAULT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const refiner = createIncrementalRefiner();

function isGenericDashScopeUrl(value: string) {
  try { return new URL(value).hostname === "dashscope.aliyuncs.com"; } catch { return false; }
}

function qwenUrl(env: Environment) {
  const override = env.QWEN_API_URL?.trim();
  const workspace = env.DASHSCOPE_WORKSPACE_ID?.trim();
  if (workspace && (!override || isGenericDashScopeUrl(override))) {
    return `https://${workspace}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
  }
  return override || DEFAULT_URL;
}

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function environment() {
  const { env } = await import("cloudflare:workers");
  return env as Environment;
}

export async function GET() {
  const user = await userFromRequest();
  if (!user) return json({ error: "请先登录。" }, 401);
  const env = await environment();
  return json({
    providers: {
      qwen: Boolean((env.QWEN_API_KEY || env.DASHSCOPE_API_KEY) && env.DASHSCOPE_WORKSPACE_ID),
      tencent: Boolean(env.TENCENT_SECRET_ID && env.TENCENT_SECRET_KEY && env.TENCENT_APP_ID),
    },
    refinement: Boolean(env.QWEN_API_KEY || env.DASHSCOPE_API_KEY),
    usage: refiner.usage(),
  });
}

export async function POST(request: Request) {
  const user = await userFromRequest(request);
  if (!user) return json({ error: "请先登录。" }, 401);
  const body = await request.json().catch(() => ({})) as TranslateRequest;
  const checked = validateIncrementalRequest(body);
  if ("error" in checked) return json({ error: checked.error }, checked.status);
  const { value } = checked;
  const env = await environment();
  const apiKey = env.QWEN_API_KEY || env.DASHSCOPE_API_KEY;
  if (!apiKey) return json({ error: "Qwen-MT refinement is not configured on the server." }, 503);
  if (!(await withinMonthlyQuota(user, value.tokenEstimate))) return json({ error: "本月 API 配额已用尽，请联系管理员。" }, 429);

  let measuredTokens = 0;
  try {
    const explicitModel = env.QWEN_MT_MODEL?.trim();
    const initialModel = explicitModel || (value.quality === "accurate" ? "qwen-mt-plus" : "qwen-mt-flash");
    const refined = await refiner.run({ ...value, provider: "qwen-mt", model: initialModel, sourceLanguage: "English", targetLanguage: "Chinese" }, async () => {
      const requestModel = (model: string) => fetch(qwenUrl(env), {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          // Qwen-MT's compatible endpoint accepts the current source text in
          // the user message. Do not smuggle prompts or transcript context
          // into `domains`: it is a domain/style field, not an instruction
          // channel, and doing so can become visible subtitle content.
          messages: [{ role: "user", content: value.text }],
          translation_options: {
            source_lang: "English",
            target_lang: "Chinese",
            domains: "university lecture",
            ...(value.terminology.length ? { terms: value.terminology.map(([source, target]) => ({ source, target })) } : {}),
          },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const request = (model: string) => {
        return requestModel(model);
      };
      let model = initialModel;
      let response = await request(model);
      if (!explicitModel && value.quality === "fast" && [400, 404, 422].includes(response.status)) {
        console.warn("[translate] Qwen-MT upstream request retrying", { status: response.status, model });
        model = "qwen-mt-plus";
        response = await request(model);
      }
      if (!response.ok) {
        console.warn("[translate] Qwen-MT upstream request failed", { status: response.status, model });
        throw new Error(response.status === 429 ? "Qwen-MT is busy or its quota is exhausted." : "Qwen-MT did not accept the refinement request.");
      }
      const result = await response.json().catch(() => ({})) as QwenResponse;
      let translation = result.choices?.[0]?.message?.content;
      if (typeof translation !== "string" || !translation.trim()) throw new Error("Qwen-MT returned an unreadable translation.");
      let inputTokens = typeof result.usage?.prompt_tokens === "number" ? result.usage.prompt_tokens : undefined;
      let outputTokens = typeof result.usage?.completion_tokens === "number" ? result.usage.completion_tokens : undefined;
      if (typeof inputTokens === "number") measuredTokens += inputTokens;
      if (typeof outputTokens === "number") measuredTokens += outputTokens;
      if (translationNeedsRetry(translation)) {
        console.warn("[translate] Qwen-MT output failed Chinese quality check; retrying with qwen-mt-plus");
        model = "qwen-mt-plus";
        const retry = await request(model);
        if (!retry.ok) throw new Error("Qwen-MT quality retry failed.");
        const retryResult = await retry.json().catch(() => ({})) as QwenResponse;
        const retryTranslation = retryResult.choices?.[0]?.message?.content;
        if (typeof retryTranslation !== "string" || !retryTranslation.trim()) throw new Error("Qwen-MT returned an unreadable translation.");
        const retryInputTokens = typeof retryResult.usage?.prompt_tokens === "number" ? retryResult.usage.prompt_tokens : undefined;
        const retryOutputTokens = typeof retryResult.usage?.completion_tokens === "number" ? retryResult.usage.completion_tokens : undefined;
        if (translationNeedsRetry(retryTranslation)) throw new Error("Qwen-MT quality retry did not return a usable translation.");
        translation = retryTranslation.trim();
        inputTokens = typeof inputTokens === "number" && typeof retryInputTokens === "number" ? inputTokens + retryInputTokens : undefined;
        outputTokens = typeof outputTokens === "number" && typeof retryOutputTokens === "number" ? outputTokens + retryOutputTokens : undefined;
        if (typeof retryInputTokens === "number") measuredTokens += retryInputTokens;
        if (typeof retryOutputTokens === "number") measuredTokens += retryOutputTokens;
      } else {
        translation = translation.trim();
      }
      return {
        translation, provider: "qwen-mt", model, inputTokens, outputTokens,
      };
    });
    if (!refined.cacheHit && measuredTokens) await recordUsage(user.id, "translation", measuredTokens);
    return json(refined);
  } catch {
    if (measuredTokens) await recordUsage(user.id, "translation", measuredTokens).catch(() => undefined);
    return json({ error: "Unable to reach Qwen-MT refinement." }, 502);
  }
}
