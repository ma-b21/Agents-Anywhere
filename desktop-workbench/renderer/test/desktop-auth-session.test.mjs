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
hooks.deregister()
const initial = { serverUrl: "https://self.example", accessToken: "a0", userId: "u", role: "member", loginGeneration: "g1", sessionId: "s1", credentialVersion: 0 }
async function render(t, { offline = false, noDiskSession = false, legacy = false, exitWait = null } = {}) {
  let snapshot = noDiskSession ? null : { ...initial }; let listener; let imports = 0; let state
  window.localStorage.clear(); window.location.hash = "#/"
  if (noDiskSession) window.localStorage.setItem("aa.session.v1", JSON.stringify(legacy ? { accessToken: "old", userId: "u", role: "member" } : initial))
  window.desktopWorkbench = { platform: "win32", auth: {
    getServer: async () => ({ serverUrl: "https://self.example", apiNamespace: "/api/v2", oauthWebOrigin: "https://self.example" }),
    getSession: async () => snapshot,
    importLegacy: async () => { imports++; snapshot = initial; listener(snapshot); return snapshot },
    onSessionChanged: (callback) => { listener = callback; return () => { listener = null } },
    consumeOAuthResult: async () => null, onOAuthResult: () => () => {},
    signOut: async (generation) => { if (generation !== snapshot?.loginGeneration) return false; snapshot = null; listener(null); if (exitWait) await exitWait; return true },
  } }
  t.mock.method(authApi, "me", async () => { if (offline) throw new Error("offline"); return { userId: "u", role: "member" } })
  function Consumer() { state = useAuth(); return h("div", null, state.session?.accessToken ?? "signed out") }
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: "zh-CN", timeZone: "Asia/Shanghai", messages: JSON.parse(readFileSync(new URL("../messages/zh-CN.json", import.meta.url))) }, h(AuthProvider, null, h(Consumer)))))
  t.after(async () => { await act(async () => root.unmount()); container.remove(); delete window.desktopWorkbench })
  return { get state() { return state }, get imports() { return imports }, update: async (value) => { snapshot = value; await act(async () => listener(value)) } }
}
test("offline startup retains durable login and exposes a retryable error", async (t) => {
  const f = await render(t, { offline: true }); assert.equal(f.state.session.accessToken, "a0"); assert.match(f.state.error, /offline/)
})
test("same-login refresh updates mirror without replacing realtime closure token", async (t) => {
  const f = await render(t); await f.update({ ...initial, accessToken: "a1", credentialVersion: 1 })
  assert.equal(f.state.session.accessToken, "a0"); assert.equal(JSON.parse(window.localStorage.getItem("aa.session.v1")).accessToken, "a1")
  await f.update({ ...initial, accessToken: "other", userId: "other", loginGeneration: "g2" })
  assert.equal(f.state.session.accessToken, "other"); assert.equal(f.state.me.userId, "other")
})
test("native localStorage mirror cannot resurrect a cleared Main session", async (t) => {
  const f = await render(t, { noDiskSession: true }); assert.equal(f.state.session, null); assert.equal(f.imports, 0)
})
test("old access-only installation is imported exactly once", async (t) => {
  const f = await render(t, { noDiskSession: true, legacy: true }); assert.equal(f.state.session.accessToken, "a0"); assert.equal(f.imports, 1); assert.equal(f.state.screen, "app")
})
test("late successful logout cannot clear a newer account or its mirror", async (t) => {
  let finishExit; const exitWait = new Promise(r => { finishExit = r })
  const f = await render(t, { exitWait })
  await act(async () => f.state.signOut())
  await f.update({ ...initial, accessToken: "B", userId: "B", loginGeneration: "B-generation" })
  await act(async () => finishExit())
  assert.equal(f.state.session.accessToken, "B")
  assert.equal(f.state.me.userId, "B")
  assert.equal(JSON.parse(window.localStorage.getItem("aa.session.v1")).accessToken, "B")
  assert.notEqual(f.state.screen, "signed-out")
})
