// Isolated fake auth service: localhost only; never imports production config or credentials.
import http from "node:http"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import ts from "typescript"
const root = fileURLToPath(new URL("../../src/", import.meta.url))
let refreshes = 0, logins = 0, accepted = 0, rejected = 0, logoutBodies = []
const sessions = new Map()
const json = (res, value, status = 200, headers = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(value)) }
const html = String.raw`<!doctype html><title>Isolated auth check</title><div id="ready">Loading</div><script>
window.process={env:{NEXT_PUBLIC_AGENTS_ANYWHERE_API_NAMESPACE:"/api/v2"}};
window.fixtureNow=Date.now(); Date.now=()=>window.fixtureNow;
</script><script type="module">
import {webAuth} from "/src/features/auth/web-auth-runtime.ts";
import {ApiClient} from "/src/lib/api/client.ts";
window.auth=webAuth(); window.api=new ApiClient();
window.login=async(user)=>{await api.signIn("/auth/login",{user});return auth.current().userId};
window.work=async(token,mode="ok",multipart=false)=>{
 let body={message:"fake"}; if(multipart){body=new FormData();body.append("message","fake");}
 return api.post("/api/v2/work?mode="+mode,body,{token});
};
window.restore=()=>auth.restore(); document.querySelector("#ready").textContent="Ready";
</script>`
const taskServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:5389"), p = url.pathname
    if (p === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return }
    if (p.startsWith("/src/")) {
      const rel = p.slice(5), file = path.resolve(root, rel.endsWith(".ts") ? rel : rel + ".ts")
      if (!file.startsWith(root) || !/\.ts$/.test(file)) { json(res, {}, 404); return }
      const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
      // Bundlers resolve alias and relative imports to one canonical module. Browsers
      // do not: /runtime and /runtime.ts are different modules without this normalization.
      const normalized = source.replace(/(from\s+|import\s*)(["'])([^"']+)\2/g, (all, prefix, quote, specifier) => {
        if (specifier.startsWith("@/")) specifier = "/src/" + specifier.slice(2)
        if ((specifier.startsWith("/src/") || specifier.startsWith(".")) && !/\.ts$/.test(specifier)) specifier += ".ts"
        return prefix + quote + specifier + quote
      })
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }); res.end(normalized); return
    }
    if (p === "/stats") { json(res, { refreshes, logins, accepted, rejected, logoutBodies }); return }
    if (p === "/shutdown") { json(res, { stopped: true }); setTimeout(() => process.exit(0), 50); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString(), body = req.headers["content-type"]?.includes("application/json") && raw ? JSON.parse(raw) : {}
    const sid = /(?:^|;\s*)fixture_sid=([^;]+)/.exec(req.headers.cookie || "")?.[1]
    const session = sessions.get(sid), live = session && !session.revoked
    const bundle = (s) => ({ accessToken: s.user + "-" + s.version, userId: s.user, sessionId: s.sid, credentialVersion: s.version, accessExpiresIn: 60, refreshToken: null, role: "member" })
    if (p.endsWith("/bootstrap")) { json(res, { authenticated: !!live, sessionId: live ? sid : undefined, userId: live ? session.user : undefined, csrfToken: live ? "csrf-" + sid : "anon", refreshProtocolVersion: 1 }); return }
    if (p.endsWith("/login")) {
      if (req.headers["x-csrf-token"] !== (live ? "csrf-" + sid : "anon")) { json(res, { detail: "csrf_failed" }, 403); return }
      const next = { sid: "sid-" + ++logins, user: body.user, version: 0, revoked: false }; sessions.set(next.sid, next)
      json(res, bundle(next), 200, { "set-cookie": "fixture_sid=" + next.sid + "; HttpOnly; SameSite=Lax; Path=/api/v2; Max-Age=7776000" }); return
    }
    if (p.endsWith("/refresh")) {
      if (!live) { json(res, { detail: "reauth_required" }, 401); return }
      if (body.expectedSessionId !== sid) { json(res, { detail: "session_changed" }, 401); return }
      if (req.headers["x-csrf-token"] !== "csrf-" + sid) { json(res, { detail: "csrf_failed" }, 403); return }
      refreshes++; session.version++; json(res, bundle(session)); return
    }
    if (p.endsWith("/logout")) {
      logoutBodies.push(body)
      if (body.expectedSessionId !== sid) { json(res, { detail: "session_changed" }, 401); return }
      if (session) session.revoked = true
      res.writeHead(204, body.clearCookie ? { "set-cookie": "fixture_sid=; Max-Age=0; Path=/api/v2; HttpOnly; SameSite=Lax" } : {}); res.end(); return
    }
    if (p.endsWith("/me")) { json(res, { userId: req.headers.authorization?.slice(7).split("-")[0], role: "member" }); return }
    if (p.endsWith("/work")) {
      if (url.searchParams.get("mode") === "deny" || !live || req.headers.authorization !== "Bearer " + bundle(session).accessToken) { rejected++; json(res, { detail: "unauthorized" }, 401); return }
      accepted++; json(res, { ok: true, user: session.user }); return
    }
    json(res, {}, 404)
  } catch { json(res, { detail: "fixture_error" }, 500) }
}).listen(5389, "127.0.0.1", () => console.log("Isolated auth fixture listening"))
