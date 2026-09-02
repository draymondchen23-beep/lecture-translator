// Cloudflare Workers cannot provide the Node `ws` proxy used by local Vite
// development. The realtime endpoint is intentionally implemented in
// server/realtime-proxy.ts, where credentials remain server-side.
export interface RealtimeEnvironment {}

export function handleRealtimeUpgrade(request: Request, _env: RealtimeEnvironment) {
  if (!request.headers.get("cookie")?.includes("lecture_session=")) return new Response("Authentication required", { status: 401 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
  return new Response("Realtime proxy is available only from the local Node development server.", { status: 501 });
}
