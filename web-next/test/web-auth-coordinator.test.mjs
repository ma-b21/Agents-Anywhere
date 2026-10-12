import assert from "node:assert/strict"
import test from "node:test"
import { WebAuthCoordinator, WebAuthUnavailable, WebAuthHttpError, WebLoginChanged } from "../src/features/auth/web-auth-coordinator.ts"

const initial = { accessToken: "A-0", userId: "A", role: "member", sessionId: "A", loginGeneration: "generation-A", credentialVersion: 0, refreshAt: 1000 }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const lockQueue = () => { let tail = Promise.resolve(); return (job) => { const result = tail.then(job); tail = result.catch(() => {}); return result } }
function fixture({ locks = true, state = initial, cookie = "A", intercept } = {}) {
  const events = [], requests = []; let cached = state ? structuredClone(state) : null; let version = 0; let now = 0; let uuid = 0; let failWrite = false
  let identityRevision = 0
  const lock = locks ? lockQueue() : undefined
  const storage = {
    read: () => cached ? structuredClone(cached) : null,
    revision: () => identityRevision === 0 && !cached ? "none" : String(identityRevision),
    write: (value) => { if (failWrite) throw new Error("storage"); if (cached?.loginGeneration !== value.loginGeneration) identityRevision++; cached = structuredClone(value) },
    clear: () => { if (failWrite) throw new Error("storage"); identityRevision++; cached = null },
  }
  const bundle = (user = cookie, n = version) => ({ accessToken: user + "-" + n, userId: user, sessionId: user, credentialVersion: n, accessExpiresIn: 60, refreshToken: null })
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname.replace("/api/v2", "")
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ path, body, headers: new Headers(init.headers), init })
    assert.equal(init.credentials, "include"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store")
    const custom = await intercept?.({ path, body, init, bundle, storage, setCookie: (value) => { cookie = value }, setFailWrite: (value) => { failWrite = value } })
    if (custom) return custom
    if (path === "/auth/session/bootstrap") return Response.json({ authenticated: !!cookie, sessionId: cookie || undefined, userId: cookie || undefined, csrfToken: "csrf-" + (cookie || "anon"), refreshProtocolVersion: 1 })
    if (path === "/auth/session/refresh") {
      assert.equal(new Headers(init.headers).get("x-csrf-token"), "csrf-" + cookie)
      if (body.expectedSessionId !== cookie) return Response.json({ detail: "session_changed" }, { status: 401, headers: { "X-AA-Auth-Error": "session_changed" } })
      return Response.json(bundle(cookie, ++version))
    }
    if (["/auth/login", "/auth/register", "/auth/oauth/finalize"].includes(path)) {
      assert.equal(new Headers(init.headers).get("x-aa-session-protocol"), "1")
      cookie = body.user || "B"; version = 0
      const auth = { ...bundle(), role: "member" }
      return Response.json(path.endsWith("finalize") ? { auth } : auth)
    }
    if (path === "/auth/me") return Response.json({ userId: new Headers(init.headers).get("authorization").slice(7).split("-")[0], role: "member" })
    if (path === "/auth/session/upgrade") {
      assert.equal(body.clientId, "agents-anywhere-web"); assert.equal(body.upgradeAttemptId, cached.pendingUpgrade)
      cookie = cached.userId; return Response.json(bundle(cookie))
    }
    if (path === "/auth/session/logout") {
      assert.equal(body.expectedSessionId, cookie); if (body.clearCookie) cookie = null
      return new Response(null, { status: 204 })
    }
    throw new Error("unexpected path " + path)
  }
  const make = () => new WebAuthCoordinator({ storage, lock, fetcher, base: "https://self.example/api/v2", clock: () => now, uuid: () => "new-generation-" + ++uuid, changed: value => events.push(value) })
  return { auth: make(), make, storage, bundle, requests, events, expired: () => { now += 61_000 }, get cached() { return cached }, get cookie() { return cookie } }
}

test("twenty expired page requests share a single CSRF bootstrap and refresh", async () => {
  const f = fixture(); f.expired()
  const values = await Promise.all(Array.from({ length: 20 }, () => f.auth.accessToken("A-0")))
  assert.deepEqual(values, Array(20).fill("A-1")); assert.equal(f.requests.filter(r => r.path.endsWith("/refresh")).length, 1)
  assert.equal(f.cookie, "A"); assert.equal("refreshToken" in f.cached, false)
})
test("three tabs share one refresh under the origin lock and shared credential version", async () => {
  const f = fixture(); const tabs = [f.auth, f.make(), f.make()]; f.expired()
  const tokens = await Promise.all(tabs.map(tab => tab.accessToken("A-0")))
  assert.deepEqual(tokens, ["A-1", "A-1", "A-1"]); assert.equal(f.requests.filter(r => r.path.endsWith("/refresh")).length, 1)
})
test("late old 401 reuses already refreshed credentials, with one business auth retry", async () => {
  const f = fixture(); const reply = deferred(); const tokens = []
  const business = f.auth.execute("A-0", async token => { tokens.push(token); return tokens.length === 1 ? reply.promise : Response.json({ ok: true }) })
  await Promise.resolve(); await Promise.resolve(); await f.auth.accessToken("A-0", true)
  reply.resolve(new Response(null, { status: 401 })); assert.equal((await business).status, 200)
  assert.deepEqual(tokens, ["A-0", "A-1"]); assert.equal(f.requests.filter(r => r.path.endsWith("/refresh")).length, 1)
})
test("network or server failure preserves login and never replays a sent business POST", async () => {
  const f = fixture(); let sent = 0
  await assert.rejects(f.auth.execute("A-0", async () => { sent++; throw new Error("lost POST response") }), /lost POST/)
  assert.equal(sent, 1); assert.equal(f.cached.accessToken, "A-0")
  const offline = fixture({ intercept: async ({ path }) => { if (path.endsWith("/refresh")) return new Response(null, { status: 503 }) } }); offline.expired()
  await assert.rejects(offline.auth.accessToken("A-0"), WebAuthHttpError); assert.ok(offline.auth.current())
})
test("second auth failure logs out once and cannot loop", async () => {
  const f = fixture(); let attempts = 0
  const response = await f.auth.execute("A-0", async () => { attempts++; return new Response(null, { status: 401 }) })
  assert.equal(response.status, 401); assert.equal(attempts, 2); assert.equal(f.auth.current(), null); assert.equal(f.events.filter(v => v === null).length, 1)
})
test("server Cookie revocation causes explicit logout while CSRF failure preserves login", async () => {
  const revoked = fixture({ cookie: null }); revoked.expired()
  await assert.rejects(revoked.auth.accessToken("A-0"), WebAuthHttpError); assert.equal(revoked.cached, null)
  const csrf = fixture({ intercept: async ({ path }) => { if (path.endsWith("/refresh")) return Response.json({ detail: "csrf_failed" }, { status: 403 }) } }); csrf.expired()
  await assert.rejects(csrf.auth.accessToken("A-0"), WebAuthHttpError); assert.ok(csrf.cached)
})
test("fresh browser boot recovers Cookie identity and verifies role without any refresh secret", async () => {
  const f = fixture({ state: null }); const value = await f.auth.restore()
  assert.equal(value.userId, "A"); assert.equal(value.accessToken, "A-1"); assert.equal(value.role, "member")
  assert.equal("refreshToken" in f.cached, false); assert.equal("csrfToken" in f.cached, false)
})
test("Cookie expiry cannot resurrect a native localStorage mirror", async () => {
  const f = fixture({ state: null, cookie: null }); assert.equal(await f.auth.restore(initial), null); assert.equal(f.cached, null)
})
test("legacy upgrade persists attempt before spend and retries the same ID after a lost response", async () => {
  const attempts = []; let lose = true
  const f = fixture({ state: null, cookie: null, intercept: async ({ path, body }) => {
    if (path.endsWith("/upgrade")) { attempts.push(body.upgradeAttemptId); if (lose) { lose = false; throw new Error("offline") } }
  } })
  const legacy = { accessToken: "legacy", userId: "A", role: "member" }
  await assert.rejects(f.auth.restore(legacy), /offline/)
  assert.ok(f.cached.pendingUpgrade); const restored = await f.make().restore(legacy)
  assert.equal(restored.sessionId, "A"); assert.equal(attempts[0], attempts[1]); assert.equal(f.cached.pendingUpgrade, undefined)
})
test("old server upgrade-unavailable preserves legacy access rather than forcing logout", async () => {
  const f = fixture({ state: null, cookie: null, intercept: async ({ path }) => {
    if (path.endsWith("/upgrade")) return Response.json({ detail: "upgrade_unavailable" }, { status: 401, headers: { "X-AA-Auth-Error": "upgrade_unavailable" } })
  } })
  assert.equal((await f.auth.restore({ accessToken: "legacy", userId: "A", role: "member" })).accessToken, "legacy")
})
test("without Web Locks existing Cookie may refresh, but login and legacy Cookie upgrade are forbidden", async () => {
  const f = fixture({ locks: false }); f.expired(); assert.equal(await f.auth.accessToken("A-0"), "A-1")
  await assert.rejects(f.auth.login("/auth/login", { user: "B" }), WebAuthUnavailable); assert.equal(f.cookie, "A")
  const legacy = fixture({ locks: false, state: null, cookie: null }); await legacy.auth.restore({ accessToken: "legacy", userId: "A", role: "member" })
  assert.equal(legacy.requests.some(r => r.path.endsWith("/upgrade")), false)
})
test("without locks logout revokes expected SID and deliberately does not delete the Cookie", async () => {
  const f = fixture({ locks: false }); assert.equal(await f.auth.signOut(initial.loginGeneration), true)
  const body = f.requests.find(r => r.path.endsWith("/logout")).body; assert.equal(body.clearCookie, false); assert.equal(f.cookie, "A"); assert.equal(f.cached, null)
})
test("identity lock covers login response and shared snapshot commit before another login starts", async () => {
  const wait = deferred(); let held = true
  const f = fixture({ intercept: async ({ path }) => { if (path === "/auth/login" && held) { held = false; await wait.promise } } })
  const a = f.auth.login("/auth/login", { user: "B" }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const b = f.make().login("/auth/login", { user: "C" }); wait.resolve()
  await a; await b; assert.equal(f.cookie, "C"); assert.equal(f.cached.userId, "C")
  assert.deepEqual(f.requests.filter(r => r.path === "/auth/login").map(r => r.body.user), ["B", "C"])
})
test("stale tab logout cannot delete a newer account Cookie or cache", async () => {
  const f = fixture(); const other = f.make(); await other.login("/auth/login", { user: "B" })
  assert.equal(await f.auth.signOut(initial.loginGeneration), false); assert.equal(f.cookie, "B"); assert.equal(f.cached.userId, "B")
  assert.equal(f.requests.some(r => r.path.endsWith("/logout")), false)
})
test("Cookie storage restrictions are reported before declaring renewable login", async () => {
  let boot = 0
  const f = fixture({ cookie: null, state: null, intercept: async ({ path }) => {
    if (path.endsWith("/bootstrap") && ++boot > 1) return Response.json({ authenticated: false, csrfToken: "anon", refreshProtocolVersion: 1 })
  } })
  await assert.rejects(f.auth.login("/auth/login", { user: "B" }), /did not retain/); assert.equal(f.cached, null)
})
test("cancelled waiter leaves a shared refresh running for another caller", async () => {
  const wait = deferred(); const f = fixture({ intercept: async ({ path, bundle }) => { if (path.endsWith("/refresh")) { await wait.promise; return Response.json(bundle("A", 1)) } } }); f.expired()
  const controller = new AbortController(); let sends = 0
  const cancelled = f.auth.execute("A-0", async () => { controller.signal.throwIfAborted(); sends++; return new Response() })
  const other = f.auth.accessToken("A-0"); controller.abort(); wait.resolve()
  await assert.rejects(cancelled); assert.equal(await other, "A-1"); assert.equal(sends, 0)
})
test("out-of-order no-lock renewals never downgrade shared credential version", async () => {
  const older = deferred(); let n = 0
  const f = fixture({ locks: false, intercept: async ({ path, bundle }) => {
    if (path.endsWith("/refresh")) { if (++n === 1) { await older.promise; return Response.json(bundle("A", 1)) } return Response.json(bundle("A", 2)) }
  } }); const second = f.make(); f.expired()
  const first = f.auth.accessToken("A-0"); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(await second.accessToken("A-0"), "A-2"); older.resolve()
  assert.equal(await first, "A-2"); assert.equal(f.cached.credentialVersion, 2)
})
test("mid-flight account change fences old refresh and never borrows new account bearer", async () => {
  const wait = deferred(); const f = fixture({ locks: false, intercept: async ({ path, bundle }) => { if (path.endsWith("/refresh")) { await wait.promise; return Response.json(bundle("A", 1)) } } }); f.expired()
  const old = f.auth.accessToken("A-0"); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  f.storage.write({ ...initial, accessToken: "B-0", userId: "B", sessionId: "B", loginGeneration: "B-generation" }); wait.resolve()
  await assert.rejects(old, WebLoginChanged); assert.equal(f.auth.current().accessToken, "B-0")
  await assert.rejects(f.auth.accessToken("unknown"), WebLoginChanged)
})
test("second retry's late 401 cannot clear a later credential from another tab", async () => {
  const f = fixture(); const reply = deferred(), retryStarted = deferred(); let sent = 0
  const pending = f.auth.execute("A-0", async () => { sent++; if (sent === 1) return new Response(null, { status: 401 }); retryStarted.resolve(); return reply.promise })
  await retryStarted.promise
  const other = f.make(); await other.accessToken("A-1", true)
  reply.resolve(new Response(null, { status: 401 }))
  assert.equal((await pending).status, 401); assert.equal(sent, 2); assert.equal(f.cached.accessToken, "A-2")
})
test("bootstrap delayed across local logout cannot notify or return the departed account", async () => {
  const reply = deferred(), started = deferred()
  const f = fixture({ intercept: async ({ path }) => { if (path.endsWith("bootstrap")) { started.resolve(); return reply.promise } } })
  const pending = f.auth.restore(); await started.promise; f.storage.clear()
  reply.resolve(Response.json({ authenticated: true, sessionId: "A", userId: "A", csrfToken: "csrf-A", refreshProtocolVersion: 1 }))
  await assert.rejects(pending, WebLoginChanged); assert.equal(f.cached, null); assert.equal(f.events.length, 0)
})
test("empty to login to logout tombstone prevents a delayed fresh restore from resurrecting", async () => {
  const reply = deferred(), started = deferred()
  const f = fixture({ state: null, locks: false, intercept: async ({ path }) => { if (path.endsWith("bootstrap")) { started.resolve(); return reply.promise } } })
  const pending = f.auth.restore(); await started.promise; f.storage.write(initial); f.storage.clear()
  reply.resolve(Response.json({ authenticated: true, sessionId: "A", userId: "A", csrfToken: "csrf-A", refreshProtocolVersion: 1 }))
  await assert.rejects(pending, WebLoginChanged); assert.equal(f.cached, null)
})
test("unavailable legacy upgrade honors cooldown for business traffic and foreground restore", async () => {
  const f = fixture({ state: { ...initial, sessionId: undefined }, cookie: null,
    intercept: async ({ path }) => path.endsWith("upgrade") ? new Response(null, { status: 404 }) : undefined })
  await f.auth.restore(); const attempt = f.cached.pendingUpgrade
  for (let i = 0; i < 3; i++) { await f.auth.accessToken("A-0"); await f.auth.restore() }
  assert.equal(f.requests.filter(r => r.path.endsWith("upgrade")).length, 1); assert.equal(f.cached.pendingUpgrade, attempt)
})
test("a legacy mirror supplied after a persistent logout tombstone cannot re-import", async () => {
  const f = fixture({ cookie: null }); f.storage.clear()
  const value = await f.auth.restore({ accessToken: "old", userId: "A", role: "member" })
  assert.equal(value, null); assert.equal(f.cached, null)
  assert.equal(f.requests.filter(r => r.path.endsWith("upgrade")).length, 0)
})
