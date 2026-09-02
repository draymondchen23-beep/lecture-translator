import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { createSession, ensureAdmin, hashPassword, normalizePhone, sessionResponse, validPassword, validPhone, verifyPassword } from "../../../auth";
import { users } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const phone = normalizePhone(typeof body.phone === "string" ? body.phone : "");
  const password = typeof body.password === "string" ? body.password : "";
  if (!validPhone(phone) || !validPassword(password)) return Response.json({ error: "请输入正确的手机号和至少 8 位密码。" }, { status: 400 });
  try {
    await ensureAdmin();
    const db = getDb();
    const row = await db.select().from(users).where(and(eq(users.phone, phone), eq(users.status, "active"))).limit(1);
    if (!row[0] || !(await verifyPassword(password, row[0].passwordHash))) return Response.json({ error: "手机号或密码不正确。" }, { status: 401 });
    const { cookie } = await createSession(row[0].id);
    await db.update(users).set({ lastLoginAt: new Date().toISOString() }).where(eq(users.id, row[0].id));
    return sessionResponse({ user: { id: row[0].id, phone: row[0].phone, displayName: row[0].displayName, role: row[0].role, monthlyTokenLimit: row[0].monthlyTokenLimit } }, cookie);
  } catch {
    return Response.json({ error: "用户数据库尚未配置。" }, { status: 503 });
  }
}
