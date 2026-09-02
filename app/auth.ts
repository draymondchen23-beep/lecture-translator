import { and, eq, gt, lt, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { invites, sessions, usageEvents, users } from "../db/schema";

export type AuthUser = {
  id: string;
  phone: string;
  displayName: string;
  role: "admin" | "user";
  monthlyTokenLimit: number;
};

type AuthEnvironment = {
  AUTH_ADMIN_PHONE?: string;
  AUTH_ADMIN_PASSWORD?: string;
  AUTH_SESSION_SECRET?: string;
};

export const SESSION_COOKIE = "lecture_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Cloudflare Workers Web Crypto caps PBKDF2 iteration counts at 100,000.
const PASSWORD_ITERATIONS = 100_000;

function environment() {
  return env as AuthEnvironment;
}

export function normalizePhone(value: string) {
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (compact.startsWith("+")) return `+${compact.slice(1).replace(/\D/g, "")}`;
  const digits = compact.replace(/\D/g, "");
  return digits.startsWith("00") ? `+${digits.slice(2)}` : `+${digits}`;
}

function isPhone(value: string) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function derivePassword(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" }, key, 256);
  return hex(bits);
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `pbkdf2$${PASSWORD_ITERATIONS}$${base64Url(salt)}$${await derivePassword(password, salt)}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [, iterationText, encodedSalt, expected] = encoded.split("$");
  if (!iterationText || !encodedSalt || !expected || Number(iterationText) !== PASSWORD_ITERATIONS) return false;
  const binary = atob(encodedSalt.replace(/-/g, "+").replace(/_/g, "/") + "==");
  const salt = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const actual = await derivePassword(password, salt);
  return actual === expected;
}

function cookieValue(cookieHeader: string | null, name: string) {
  return cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

function authCookie(token: string, maxAge = SESSION_TTL_MS / 1_000) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${Math.floor(maxAge)}; Path=/; HttpOnly; SameSite=Lax; Secure`;
}

export function clearAuthCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`;
}

export async function ensureAdmin() {
  const config = environment();
  const phone = normalizePhone(config.AUTH_ADMIN_PHONE || "");
  const password = config.AUTH_ADMIN_PASSWORD || "";
  console.info("[AUTH] admin config", { phoneLoaded: Boolean(config.AUTH_ADMIN_PHONE), passwordLoaded: Boolean(config.AUTH_ADMIN_PASSWORD), dbLoaded: Boolean((env as { DB?: unknown }).DB) });
  if (!isPhone(phone) || password.length < 8) return null;
  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (existing[0]) {
    if (existing[0].role !== "admin" || existing[0].status !== "active") {
      await db.update(users).set({ role: "admin", status: "active" }).where(eq(users.id, existing[0].id));
    }
    return existing[0].id;
  }
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, phone, displayName: "Administrator", passwordHash: await hashPassword(password), role: "admin", status: "active", monthlyTokenLimit: 1_000_000 });
  return id;
}

export async function userFromRequest(request?: Request): Promise<AuthUser | null> {
  await ensureAdmin();
  const cookieHeader = request?.headers.get("cookie") ?? (await headers()).get("cookie");
  const token = cookieValue(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const db = getDb();
  const row = await db.select({ user: users }).from(sessions).innerJoin(users, eq(sessions.userId, users.id)).where(and(eq(sessions.tokenHash, await sha256(token)), gt(sessions.expiresAt, new Date().toISOString()), eq(users.status, "active"))).limit(1);
  return row[0]?.user ? {
    id: row[0].user.id,
    phone: row[0].user.phone,
    displayName: row[0].user.displayName,
    role: row[0].user.role,
    monthlyTokenLimit: row[0].user.monthlyTokenLimit,
  } : null;
}

export async function createSession(userId: string) {
  const token = base64Url(randomBytes(32));
  const now = Date.now();
  await getDb().insert(sessions).values({ tokenHash: await sha256(token), userId, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() });
  return { token, cookie: authCookie(token) };
}

export async function revokeSession(request: Request) {
  const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) await getDb().delete(sessions).where(eq(sessions.tokenHash, await sha256(token)));
}

export function inviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `LT-${Array.from(randomBytes(10), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

export async function createInvite(userId: string, days = 30) {
  const code = inviteCode();
  await getDb().insert(invites).values({ id: crypto.randomUUID(), codeHash: await sha256(code), createdBy: userId, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(), maxUses: 1, usedCount: 0 });
  return code;
}

export async function consumeInvite(code: string) {
  const normalized = code.trim().toUpperCase();
  if (!/^LT-[A-Z2-9]{10}$/.test(normalized)) return false;
  const db = getDb();
  const hash = await sha256(normalized);
  const row = await db.select().from(invites).where(and(eq(invites.codeHash, hash), lt(invites.usedCount, invites.maxUses), gt(invites.expiresAt, new Date().toISOString()))).limit(1);
  if (!row[0]) return false;
  await db.update(invites).set({ usedCount: sql`${invites.usedCount} + 1` }).where(and(eq(invites.id, row[0].id), lt(invites.usedCount, invites.maxUses)));
  return true;
}

export async function recordUsage(userId: string, kind: string, units: number) {
  await getDb().insert(usageEvents).values({ id: crypto.randomUUID(), userId, kind, units: Math.max(0, Math.floor(units)), createdAt: new Date().toISOString() });
}

export async function withinMonthlyQuota(user: AuthUser, units: number) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const result = await getDb().select({ total: sql<number>`coalesce(sum(${usageEvents.units}), 0)` }).from(usageEvents).where(and(eq(usageEvents.userId, user.id), gt(usageEvents.createdAt, monthStart.toISOString())));
  return Number(result[0]?.total || 0) + Math.max(0, units) <= user.monthlyTokenLimit;
}

export function sessionResponse(body: object, cookie: string, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "set-cookie": cookie } });
}

export function validPassword(password: string) {
  return password.length >= 8 && password.length <= 128;
}

export function validPhone(phone: string) {
  return isPhone(phone);
}
