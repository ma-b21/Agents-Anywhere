import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"
const dom = new JSDOM("<html><body></body></html>", { url: "https://app.example.test/" })
for (const name of ["window", "document", "navigator", "HTMLElement", "Event"]) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { AuthProvider, useAuth } = await import("../src/components/auth/auth-context.tsx")
const { authApi } = await import("../src/features/auth/api.ts")
const { webAuth } = await import("../src/features/auth/web-auth-runtime.ts")
const { WebAuthHttpError } = await import("../src/features/auth/web-auth-coordinator.ts")
hooks.deregister()
const initial = { accessToken: "a0", userId: "u", role: "member", loginGeneration: "g1", sessionId: "s1", credentialVersion: 0, refreshAt: Date.now() + 60000 }
const key = "aa.web.session.v1:https://app.example.test:/api/v2"
async function render(t, { ended = false, offline = false, cacheFault = false, exitWait = null } = {}) {
  window.localStorage.clear(); window.history.replaceState({}, "", "/#/")
  window.localStorage.setItem(key, JSON.stringify({ identityRevision: "g1", state: initial }))
  window.localStorage.setItem("aa.session.v1", JSON.stringify(cacheFault ? { accessToken: "a0", userId: "u", role: "member" } : initial))
  const auth = webAuth(); let state
  if (cacheFault) t.mock.method(auth, "current", () => { throw new Error("cache read fault") })
  t.mock.method(auth, "restore", async () => {
    if (ended) { window.localStorage.setItem(key, JSON.stringify({ identityRevision: "logout", state: null })); auth.synchronize(); throw new WebAuthHttpError(401, "reauth_required") }
    if (cacheFault) throw new Error("cache read fault")
    if (offline) throw new Error("offline")
    auth.synchronize(); return auth.current()
  })
  t.mock.method(auth, "signOut", async (generation) => {
    if (auth.current()?.loginGeneration !== generation) return false
    window.localStorage.setItem(key, JSON.stringify({ identityRevision: "logout", state: null })); auth.synchronize()
    if (exitWait) await exitWait
    return true
  })
  t.mock.method(authApi, "config", async () => ({ needsBootstrap: false }))
  t.mock.method(authApi, "me", async () => { if (offline) throw new Error("offline"); return { userId: "u", role: "member" } })
  function Consumer() { state = useAuth(); return h("div", null, state.session?.accessToken ?? "signed out") }
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: "zh-CN", timeZone: "Asia/Shanghai", messages: JSON.parse(readFileSync(new URL("../messages/zh-CN.json", import.meta.url))) }, h(AuthProvider, null, h(Consumer)))))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return { get state() { return state }, update: async (value) => { window.localStorage.setItem(key, JSON.stringify({ identityRevision: value.loginGeneration, state: value })); await act(async () => auth.synchronize()) } }
}
test("explicit revoked startup does not resurrect a stale native mirror", async t => {
  const f = await render(t, { ended: true }); assert.equal(f.state.session, null); assert.equal(window.localStorage.getItem("aa.session.v1"), null); assert.equal(f.state.screen, "login")
})
test("offline startup retains coordinated identity and a retryable error", async t => {
  const f = await render(t, { offline: true }); assert.equal(f.state.session.accessToken, "a0"); assert.match(f.state.error, /offline/)
})
test("same-generation token refresh keeps realtime closure while mirror advances", async t => {
  const f = await render(t); await f.update({ ...initial, accessToken: "a1", credentialVersion: 1 })
  assert.equal(f.state.session.accessToken, "a0"); assert.equal(JSON.parse(window.localStorage.getItem("aa.session.v1")).accessToken, "a1")
  await f.update({ ...initial, accessToken: "B", userId: "B", loginGeneration: "B" }); assert.equal(f.state.session.userId, "B")
})
test("delayed successful logout cannot clear a newly signed-in account", async t => {
  let finish; const exitWait = new Promise(r => { finish = r }); const f = await render(t, { exitWait })
  await act(async () => f.state.signOut()); await f.update({ ...initial, accessToken: "B", userId: "B", loginGeneration: "B" })
  await act(async () => finish()); assert.equal(f.state.session.userId, "B"); assert.equal(JSON.parse(window.localStorage.getItem("aa.session.v1")).userId, "B")
})
test("persistent cache read fault with a legacy mirror reports error and finishes loading", async t => {
  const f = await render(t, { cacheFault: true })
  assert.equal(f.state.loading, false); assert.equal(f.state.session, null); assert.match(f.state.error, /cache read fault/)
  assert.ok(window.localStorage.getItem("aa.session.v1"))
})
