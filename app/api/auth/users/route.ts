import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userFromRequest } from "../../../auth";
import { users } from "../../../../db/schema";

export async function GET(request: Request) {
  const user = await userFromRequest(request);
  if (!user || user.role !== "admin") return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const rows = await getDb().select({ id: users.id, phone: users.phone, displayName: users.displayName, role: users.role, status: users.status, monthlyTokenLimit: users.monthlyTokenLimit, createdAt: users.createdAt, lastLoginAt: users.lastLoginAt }).from(users).orderBy(asc(users.createdAt));
  return Response.json({ users: rows }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request) {
  const user = await userFromRequest(request);
  if (!user || user.role !== "admin") return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : "";
  const status = body.status === "disabled" ? "disabled" : body.status === "active" ? "active" : "";
  const monthlyTokenLimit = Number(body.monthlyTokenLimit);
  if (!id || (!status && (!Number.isFinite(monthlyTokenLimit) || monthlyTokenLimit < 1_000 || monthlyTokenLimit > 10_000_000))) return Response.json({ error: "更新参数无效。" }, { status: 400 });
  if (id === user.id && status === "disabled") return Response.json({ error: "不能停用当前管理员账号。" }, { status: 400 });
  await getDb().update(users).set(status ? { status } : { monthlyTokenLimit: Math.floor(monthlyTokenLimit) }).where(eq(users.id, id));
  return Response.json({ ok: true });
}
