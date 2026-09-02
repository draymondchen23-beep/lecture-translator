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

function translationInstructions(context: string, terminology: unknown) {
  const contextInstruction = context ? `\nPrevious finalized block context (use only for continuity; translate only the current input):\n${context}` : "";
  if (!terminology || typeof terminology !== "object" || Array.isArray(terminology)) return contextInstruction;
  const lines = Object.entries(terminology as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .slice(0, 100)
    .map(([english, chinese]) => `${english} => ${chinese}`);
  return `${contextInstruction}${lines.length ? `\nUse these established terms consistently:\n${lines.join("\n")}` : ""}`;
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

  try {
    const refined = await refiner.run(value, async () => {
      const explicitModel = env.QWEN_MT_MODEL?.trim();
      const requestModel = (model: string) => fetch(qwenUrl(env), {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: value.text }],
          translation_options: { source_lang: "English", target_lang: "Chinese", domains: `University lecture, academic English. Translate only the current input. Use any supplied previous-block context only to resolve continuity, pronouns and terminology. Preserve formulas, numbers, units, names and established English abbreviations. On first use, format uncertain academic terms as 中文（English Term）.${translationInstructions(value.context, body.terminology)}` },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      let model = explicitModel || (value.quality === "accurate" ? "qwen-mt-plus" : "qwen-mt-flash");
      let response = await requestModel(model);
      if (!explicitModel && value.quality === "fast" && [400, 404, 422].includes(response.status)) {
        console.warn("[translate] Qwen-MT upstream request retrying", { status: response.status, model });
        model = "qwen-mt-plus";
        response = await requestModel(model);
      }
      if (!response.ok) {
        console.warn("[translate] Qwen-MT upstream request failed", { status: response.status, model });
        throw new Error(response.status === 429 ? "Qwen-MT is busy or its quota is exhausted." : "Qwen-MT did not accept the refinement request.");
      }
      const result = await response.json().catch(() => ({})) as QwenResponse;
      const translation = result.choices?.[0]?.message?.content;
      if (typeof translation !== "string" || !translation.trim()) throw new Error("Qwen-MT returned an unreadable translation.");
      return {
        translation: translation.trim(), provider: "qwen-mt",
        inputTokens: typeof result.usage?.prompt_tokens === "number" ? result.usage.prompt_tokens : undefined,
        outputTokens: typeof result.usage?.completion_tokens === "number" ? result.usage.completion_tokens : undefined,
      };
    });
    if (!refined.cacheHit) await recordUsage(user.id, "translation", value.tokenEstimate + Math.ceil(String(refined.translation || "").length / 4));
    return json(refined);
  } catch {
    return json({ error: "Unable to reach Qwen-MT refinement." }, 502);
  }
}
