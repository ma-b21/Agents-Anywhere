import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/features/dashboard/api.ts", import.meta.url), "utf8")
const ast = ts.createSourceFile("api.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "DashboardApi")
assert.ok(declaration)
const code = ts.transpileModule(declaration.getText(ast).replace("export ", ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText
const DashboardApi = vm.runInNewContext(`${code}\nDashboardApi`)

function recorder() {
  const calls = []
  const response = { ok: true }
  const api = new DashboardApi({
    post: async (path, body, options) => {
      calls.push(JSON.parse(JSON.stringify({ path, body, options })))
      return response
    },
  })
  return { api, calls, response }
}

test("steer posts content to its dedicated encoded session route", async () => {
  const { api, calls, response } = recorder()
  assert.equal(await api.steerSessionMessage("auth-token", "session/中文", "补充要求"), response)
  assert.deepEqual(calls, [{
    path: `/sessions/${encodeURIComponent("session/中文")}/runtime/steer`,
    body: { content: "补充要求" },
    options: { token: "auth-token" },
  }])
})

test("steer and normal send preserve the same attachment and client message payload", async () => {
  const { api, calls } = recorder()
  const options = {
    attachments: [{ fileId: "uploaded-file-id" }],
    clientMessageId: "retry-stable-id",
  }
  await api.steerSessionMessage("auth-token", "s1", "follow up", options)
  await api.sendSessionMessage("auth-token", "s1", "follow up", options)
  assert.deepEqual(calls, [
    {
      path: "/sessions/s1/runtime/steer",
      body: { content: "follow up", ...options },
      options: { token: "auth-token" },
    },
    {
      path: "/sessions/s1/runtime/messages",
      body: { content: "follow up", ...options },
      options: { token: "auth-token" },
    },
  ])
})

test("steer omits empty optional fields just like normal send", async () => {
  const { api, calls } = recorder()
  await api.steerSessionMessage("auth-token", "s1", "message", { attachments: [], clientMessageId: "" })
  assert.deepEqual(calls[0].body, { content: "message" })
})

test("a rejected steer stays a steer failure and never falls back to send", async () => {
  const calls = []
  const error = new Error("turn already completed")
  const api = new DashboardApi({ post: async path => { calls.push(path); throw error } })
  await assert.rejects(api.steerSessionMessage("auth-token", "s1", "message"), failure => failure === error)
  assert.deepEqual(calls, ["/sessions/s1/runtime/steer"])
})

test("HTTP-success runtime rejections are failures, not accepted instructions", async () => {
  for (const response of [
    { ok: false, error: { message: "turn already completed" } },
    { ok: true, result: { ok: false, message: "turn already completed", code: "codex_no_active_turn" } },
    { ok: true, result: { ok: false, code: "codex_no_active_turn" } },
    { ok: true, result: { ok: false } },
    { ok: true, result: { steered: false, code: "codex_no_active_turn" } },
    { ok: true, result: { error: { message: "turn already completed" } } },
    { ok: true, result: { error: "turn already completed" } },
  ]) {
    const calls = []
    const api = new DashboardApi({ post: async path => { calls.push(path); return response } })
    await assert.rejects(api.steerSessionMessage("token", "s1", "keep draft"), /turn already completed|codex_no_active_turn|Steer request failed/)
    assert.deepEqual(calls, ["/sessions/s1/runtime/steer"])
  }
})

test("successful steer results retain the accepted payload", async () => {
  for (const result of [{}, { ok: true }, { accepted: true }, { steered: true, error: null }, { metadata: { ok: false } }, null]) {
    const response = { ok: true, result }
    const api = new DashboardApi({ post: async () => response })
    assert.equal(await api.steerSessionMessage("token", "s1", "follow up"), response)
  }
})
