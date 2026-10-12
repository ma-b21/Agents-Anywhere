import { DesktopAuthCoordinator, DesktopAuthDenied, DesktopLoginChanged } from "./desktop-auth";

// Server permits five 25-MiB attachments; include multipart overhead, but bound memory.
const MAX_REPLAY_BYTES = 128 * 1024 * 1024;
async function replayBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const parts: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REPLAY_BYTES) { await reader.cancel(); throw new RangeError("Upload exceeds desktop replay limit."); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total); let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return body;
}
export async function proxyDesktopApi(
  request: Request, serverOrigin: string, trustedOrigins: readonly string[], fetcher: typeof fetch,
  auth?: DesktopAuthCoordinator,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !trustedOrigins.includes(origin)) return new Response("Forbidden", { status: 403 });
  const cors = new Headers();
  if (origin) { cors.set("access-control-allow-origin", origin); cors.set("vary", "Origin"); }
  cors.set("access-control-expose-headers", "X-AA-Auth-Error");
  if (request.method === "OPTIONS") {
    cors.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    cors.set("access-control-allow-headers", request.headers.get("access-control-request-headers") ?? "authorization, content-type");
    return new Response(null, { status: 204, headers: cors });
  }
  try {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("origin"); headers.delete("referer"); headers.delete("cookie"); headers.delete("host");
    const bearer = headers.get("authorization");
    const queryToken = url.searchParams.get("token");
    const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : queryToken;
    const body = await replayBody(request);
    const action = async (current?: string) => {
      request.signal.throwIfAborted();
      const outgoing = new Headers(headers); const target = new URL(serverOrigin + url.pathname + url.search);
      if (current) {
        if (bearer) outgoing.set("authorization", "Bearer " + current);
        if (queryToken) target.searchParams.set("token", current);
      }
      return fetcher(target.toString(), {
        method: request.method, headers: outgoing, body: body as BodyInit | null, signal: request.signal,
        credentials: "omit", redirect: "error",
      });
    };
    const response = auth && token ? await auth.execute(serverOrigin, token, action) : await action();
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("set-cookie");
    cors.forEach((value, key) => responseHeaders.set(key, value));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch (error) {
    if (request.signal.aborted) throw error;
    const status = error instanceof DesktopAuthDenied ? 401 : error instanceof DesktopLoginChanged ? 409 : error instanceof RangeError ? 413 : 503;
    if (status === 401) cors.set("X-AA-Auth-Error", "reauth_required");
    return Response.json({ detail: status === 401 ? "Login expired or revoked." : status === 409 ? "Login changed." : "Request temporarily unavailable." }, { status, headers: cors });
  }
}
