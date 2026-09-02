import { revokeSession, clearAuthCookie } from "../../../auth";

export async function POST(request: Request) {
  try { await revokeSession(request); } catch { /* cookie is still cleared */ }
  return Response.json({ ok: true }, { headers: { "set-cookie": clearAuthCookie(), "cache-control": "no-store" } });
}
