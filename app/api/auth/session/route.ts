import { ensureAdmin, userFromRequest } from "../../../auth";

export async function GET(request: Request) {
  try {
    await ensureAdmin();
    const user = await userFromRequest(request);
    return Response.json({ user }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "用户数据库尚未配置。" }, { status: 503 });
  }
}
