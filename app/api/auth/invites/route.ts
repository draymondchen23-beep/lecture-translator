import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { createInvite, userFromRequest } from "../../../auth";
import { invites } from "../../../../db/schema";

export async function GET(request: Request) {
  const user = await userFromRequest(request);
  if (!user || user.role !== "admin") return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const rows = await getDb().select({ id: invites.id, expiresAt: invites.expiresAt, maxUses: invites.maxUses, usedCount: invites.usedCount, createdAt: invites.createdAt }).from(invites).orderBy(desc(invites.createdAt)).limit(20);
  return Response.json({ invites: rows }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const user = await userFromRequest(request);
  if (!user || user.role !== "admin") return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const days = Math.max(1, Math.min(90, Number(body.days) || 30));
  try {
    const code = await createInvite(user.id, days);
    return Response.json({ code, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "暂时无法生成邀请码。" }, { status: 503 });
  }
}
