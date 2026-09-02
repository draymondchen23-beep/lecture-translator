import { ensureAdmin, userFromRequest } from "../../../auth";

export async function GET(request: Request) {
  try {
    await ensureAdmin();
    const user = await userFromRequest(request);
    return Response.json({ user }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[AUTH] session failed", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "用户数据库尚未配置。" }, { status: 503 });
  }
}
