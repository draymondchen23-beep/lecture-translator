import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { consumeInvite, createSession, ensureAdmin, hashPassword, normalizePhone, sessionResponse, validPassword, validPhone } from "../../../auth";
import { users } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const phone = normalizePhone(typeof body.phone === "string" ? body.phone : "");
  const password = typeof body.password === "string" ? body.password : "";
  const invite = typeof body.invite === "string" ? body.invite : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 80) : "Student";
  if (!validPhone(phone) || !validPassword(password) || !invite) return Response.json({ error: "请输入手机号、至少 8 位密码和邀请码。" }, { status: 400 });
  try {
    await ensureAdmin();
    const db = getDb();
    if ((await db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).limit(1))[0]) return Response.json({ error: "这个手机号已经注册过了，请直接登录。" }, { status: 409 });
    if (!(await consumeInvite(invite))) return Response.json({ error: "邀请码无效、已使用或已过期。" }, { status: 400 });
    const id = crypto.randomUUID();
    await db.insert(users).values({ id, phone, displayName: displayName || "Student", passwordHash: await hashPassword(password), role: "user", status: "active", monthlyTokenLimit: 100_000 });
    const { cookie } = await createSession(id);
    return sessionResponse({ user: { id, phone, displayName: displayName || "Student", role: "user", monthlyTokenLimit: 100_000 } }, cookie, 201);
  } catch {
    return Response.json({ error: "用户数据库尚未配置。" }, { status: 503 });
  }
}
