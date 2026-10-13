import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import { legacyFailure } from "./helpers/notice-policy.mjs"

const require = createRequire(import.meta.url)
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
const modules = new Map()
function loadSource(path) {
  if (modules.has(path)) return modules.get(path)
  const source = ts.transpileModule(readFileSync(new URL(`../src/${path}.ts`, import.meta.url), "utf8"), { compilerOptions }).outputText
  const context = vm.createContext({ exports: {}, Error, require: name => name.startsWith("@/") ? loadSource(name.slice(2)) : require(name) })
  vm.runInContext(source, context, { filename: path })
  modules.set(path, context.exports)
  return context.exports
}

const source = readFileSync(new URL("../src/components/session-detail.tsx", import.meta.url), "utf8")
const ast = ts.createSourceFile("session-detail.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "SessionDetail")
assert.ok(component?.body)
const handler = component.body.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find(node => node.name.getText(ast) === "handleSend")
assert.ok(handler?.initializer && ts.isArrowFunction(handler.initializer))
const helperNames = [
  "nextOptimisticRuntimeState", "selectionPatchFromComposerSelections", "runtimeStateWithSelections", "runtimeStateWithSelectionResult",
  "composerDraftStorageKey", "readComposerDraft", "readComposerDraftState", "writeComposerDraft",
  "sessionSourceErrorCode", "sourceAvailabilityFromError", "sourceErrorDialogContent", "sourceErrorMessage",
  "blockingInteractions", "openInteractions", "isSessionBlockingInteraction",
]
const helpers = helperNames.map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(declaration, `missing helper ${name}`)
  return declaration.getText(ast)
}).join("\n")
const prefix = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "COMPOSER_DRAFT_STORAGE_PREFIX"))
assert.ok(prefix)
// Freeze each render's closure values, matching React. State setters and refs
// remain shared so a delayed response can encounter a different active session.
const captured = [
  "session", "sessionId", "state", "runtimeState", "runtimeStatus", "sessionRuntimeScope", "effectiveCapabilities", "composerDraftState",
  "token", "interrupting", "messageInFlightRef", "activeSessionIdRef", "timelineFollowRef", "eventSequenceCursor",
  "setState", "setComposerDraftState", "setSending", "setSourceErrorCode", "addOptimisticMessage", "markOptimisticMessageFailed",
  "createClientId", "dashboardApi", "toast", "tSession", "tNew", "onSessionUpdated",
]
const fixture = ts.transpileModule(`${prefix.getText(ast)}\n${helpers}\nfunction createHandleSend({ ${captured.join(", ")} }) { return ${handler.initializer.getText(ast)}; }`, { compilerOptions }).outputText
const plain = value => JSON.parse(JSON.stringify(value))
const file = { id: "local-1", name: "note.txt", type: "file", size: 3, mediaType: "text/plain", uploaded: { fileId: "file-1", name: "note.txt" } }

function harness({ status = "running", api = {}, value = "follow up", notices = [] } = {}) {
  const entries = new Map()
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: key => entries.delete(key),
  }
  const context = vm.createContext({
    Error, window: { localStorage: storage },
    ...loadSource("components/session/capabilities"),
    ...loadSource("components/session/session-message-action"),
    ...loadSource("components/session/optimistic-timeline"),
    ...loadSource("components/session/session-utils"),
    ...loadSource("features/dashboard/runtime-instances"),
    ...loadSource("lib/api/errors"),
  })
  vm.runInContext(fixture, context)
  let currentState = {
    session: { id: "s1", runtime: "codex", status, connectorStatus: "online", takeover: true, archived: false, updatedSeq: 1 },
    state: { status, selections: { model: "old-model", permission: "old-permission" }, metadata: {} },
    notices, items: [], nextSeq: 1,
  }
  let draft = { sessionId: "s1", value }
  let nextId = 0
  const calls = { api: [], sending: [], optimistic: [], failed: [], errors: [], sourceErrors: [], updatedSessions: [], states: [] }
  const messageInFlightRef = { current: new Set() }
  const activeSessionIdRef = { current: "s1" }
  const dashboardApi = Object.fromEntries(["steerSessionMessage", "sendSessionMessage", "updateSessionSelections"].map(method => [method, async (...args) => {
    calls.api.push({ method, args: plain(args) })
    return api[method] ? api[method](...args) : { state: null }
  }]))
  const env = () => ({
    session: currentState.session, sessionId: currentState.session.id, state: currentState,
    runtimeState: currentState.state, runtimeStatus: currentState.state.status,
    sessionRuntimeScope: { runtimeId: "codex", runtimeType: "codex" },
    effectiveCapabilities: { capabilities: ["session.send_message", "session.steer"].map(capabilityId => ({ capabilityId, supported: true, available: true, allowed: true })) },
    composerDraftState: draft, token: "token", interrupting: false, messageInFlightRef, activeSessionIdRef,
    timelineFollowRef: { current: { resume() {} } }, eventSequenceCursor: { current: () => 1 },
    setState: update => { currentState = update(currentState); calls.states.push(currentState) },
    setComposerDraftState: update => { draft = update(draft) },
    setSending: sending => calls.sending.push(sending),
    setSourceErrorCode: code => calls.sourceErrors.push(code),
    addOptimisticMessage: message => calls.optimistic.push(message),
    markOptimisticMessageFailed: (...args) => calls.failed.push(args),
    createClientId: () => `msg-${++nextId}`, dashboardApi,
    toast: { error: error => calls.errors.push(error) },
    tSession: key => key, tNew: key => key, onSessionUpdated: session => calls.updatedSessions.push(session),
  })
  context.writeComposerDraft("s1", value)
  return {
    calls, context, storage, messageInFlightRef,
    get state() { return currentState },
    get draft() { return draft },
    send: (...args) => context.createHandleSend(env())(...args),
    renderHandler: () => context.createHandleSend(env()),
    setStatus: status => { currentState = { ...currentState, state: { ...currentState.state, status } } },
    editDraft: value => {
      draft = { sessionId: currentState.session.id, value }
      context.writeComposerDraft(draft.sessionId, value)
    },
    switchSession: (sessionId = "s2") => {
      activeSessionIdRef.current = sessionId
      currentState = { ...currentState, session: { ...currentState.session, id: sessionId }, state: { status: "idle", selections: {}, metadata: {} }, items: [] }
      if (sessionId !== "s1") context.writeComposerDraft(sessionId, "other draft")
      draft = context.readComposerDraftState(sessionId)
      return currentState
    },
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

test("error-state ordinary send reaches API despite historical non-actionable failure", async () => {
  const h = harness({ status: "error", notices: [legacyFailure()] })
  assert.equal(await h.send("continue", [], {}, "send"), true)
  assert.deepEqual(h.calls.api.map(call => call.method), ["sendSessionMessage"])
  assert.deepEqual(h.calls.sending, [true, false])
  assert.equal(h.messageInFlightRef.current.size, 0)
})

test("real submit guard still rejects approval and actionable errors after turn failure", async () => {
  for (const patch of [{ interactionType: "approval" }, { interactionType: "input_request" }, { responseRequired: true }, { actions: [{ actionId: "retry" }] }]) {
    const h = harness({ status: "error", notices: [legacyFailure(), { ...legacyFailure(), ...patch }] })
    assert.equal(await h.send("continue", [], {}, "send"), false)
    assert.deepEqual(h.calls.api, [])
  }
})

test("failed steer retry is not converted to send when turn fails with an old notice", async () => {
  const h = harness({ notices: [legacyFailure()], api: { steerSessionMessage: async () => { throw new Error("turn failed") } } })
  assert.equal(await h.send("follow up", [], {}, "steer"), false)
  h.setStatus("error")
  assert.equal(await h.send("follow up", [], {}, "send"), false)
  assert.deepEqual(h.calls.api.map(call => call.method), ["steerSessionMessage"])
})

test("running steer uses only steer API, preserves running and skips selection patches", async () => {
  const pending = deferred()
  const h = harness({ api: { steerSessionMessage: () => pending.promise } })
  const sent = h.send("follow up", [file], { model: "new-model", permission: "new-permission" }, "steer")
  assert.equal(h.state.state.status, "running")
  assert.equal(h.state.state.selections.model, "old-model")
  assert.equal(h.state.items.length, 1)
  assert.deepEqual(h.calls.api, [{ method: "steerSessionMessage", args: ["token", "s1", "follow up", { attachments: [{ fileId: "file-1" }], clientMessageId: "msg-1" }] }])
  pending.resolve({})
  assert.equal(await sent, true)
  assert.deepEqual(h.calls.sending, [true, false])
  assert.equal(h.context.readComposerDraft("s1"), "")
  assert.equal(h.draft.value, "")
  assert.equal(h.draft.submission, undefined)
})

test("ordinary idle send still patches selections and uses waiting optimistic status", async () => {
  const pending = deferred()
  const h = harness({ status: "idle", api: { updateSessionSelections: () => pending.promise } })
  const sent = h.send("follow up", [], { model: "new-model" }, "send")
  assert.equal(h.state.state.status, "waiting")
  assert.deepEqual(h.calls.api, [{ method: "updateSessionSelections", args: ["token", "s1", { model: "new-model" }] }])
  pending.resolve({ state: { selections: { model: "new-model" } } })
  assert.equal(await sent, true)
  assert.deepEqual(h.calls.api.map(call => call.method), ["updateSessionSelections", "sendSessionMessage"])
  assert.equal(h.state.state.selections.model, "new-model")
  assert.equal(h.state.state.selections.permission, "old-permission")
})

test("failed steer never falls back and retries retain action plus client message ID", async () => {
  const h = harness({ api: { steerSessionMessage: async () => { throw new Error("turn ended") } } })
  assert.equal(await h.send("follow up", [file], {}, "steer"), false)
  assert.equal(h.state.state.status, "running")
  assert.equal(h.state.items[0].status, "failed")
  assert.deepEqual(plain(h.context.readComposerDraftState("s1")), {
    sessionId: "s1", value: "follow up", submission: { action: "steer", clientMessageId: "msg-1", fileIds: ["file-1"] },
  })
  assert.equal(await h.send("follow up", [file], {}, "steer"), false)
  assert.deepEqual(h.calls.api.map(call => [call.method, call.args[3].clientMessageId]), [["steerSessionMessage", "msg-1"], ["steerSessionMessage", "msg-1"]])
  h.setStatus("idle")
  assert.equal(await h.send("follow up", [file], {}, "send"), false)
  assert.equal(h.calls.api.length, 2)
  assert.equal(h.draft.submission.action, "steer")
})

test("a changed retry attachment set cannot reuse an old submission ID", async () => {
  const h = harness({ api: { steerSessionMessage: async () => { throw new Error("network") } } })
  await h.send("follow up", [file], {}, "steer")
  assert.equal(await h.send("follow up", [], {}, "steer"), false)
  assert.equal(h.calls.api.length, 1)
  assert.equal(h.calls.errors.at(-1), "messageActionUnavailable")
})

test("synchronous repeated handlers share one in-flight request lock", async () => {
  const pending = deferred()
  const h = harness({ api: { steerSessionMessage: () => pending.promise } })
  const handleSend = h.renderHandler()
  const first = handleSend("follow up", [], {}, "steer")
  assert.equal(await handleSend("follow up", [], {}, "steer"), false)
  assert.equal(h.calls.api.length, 1)
  assert.equal(h.calls.optimistic.length, 1)
  pending.resolve({})
  assert.equal(await first, true)
  assert.equal(h.messageInFlightRef.current.size, 0)
})

test("late steer failure cannot alter the newly active session or clear its sending flag", async () => {
  const pending = deferred()
  const h = harness({ api: { steerSessionMessage: () => pending.promise } })
  const sent = h.send("follow up", [], {}, "steer")
  const otherState = h.switchSession()
  pending.reject(new Error("network"))
  assert.equal(await sent, false)
  assert.equal(h.state, otherState)
  assert.deepEqual(h.calls.sending, [true])
  assert.equal(h.context.readComposerDraft("s2"), "other draft")
  assert.equal(h.draft.sessionId, "s2")
  assert.equal(h.messageInFlightRef.current.size, 0)
})

test("late normal-send selection response leaves the newly active session untouched", async () => {
  const pending = deferred()
  const h = harness({ status: "idle", api: { updateSessionSelections: () => pending.promise } })
  const sent = h.send("follow up", [], { model: "new-model" }, "send")
  const otherState = h.switchSession()
  pending.resolve({ state: { selections: { model: "new-model" } } })
  assert.equal(await sent, true)
  assert.equal(h.state, otherState)
  assert.equal(h.calls.api[1].args[1], "s1")
  assert.deepEqual(h.calls.sending, [true])
  assert.equal(h.context.readComposerDraft("s2"), "other draft")
})

test("late success preserves a newer draft stored during the original request", async () => {
  const pending = deferred()
  const h = harness({ api: { steerSessionMessage: () => pending.promise } })
  const sent = h.send("follow up", [], {}, "steer")
  h.editDraft("new draft")
  pending.resolve({})
  assert.equal(await sent, true)
  assert.equal(h.context.readComposerDraft("s1"), "new draft")
  assert.equal(h.draft.value, "new draft")
})

test("returning to the original session lets its late success clear only the matching submission", async () => {
  const pending = deferred()
  const h = harness({ api: { steerSessionMessage: () => pending.promise } })
  const sent = h.send("follow up", [], {}, "steer")
  h.switchSession("s2")
  h.switchSession("s1")
  assert.equal(h.draft.submission.clientMessageId, "msg-1")
  pending.resolve({})
  assert.equal(await sent, true)
  assert.equal(h.draft.value, "")
  assert.equal(h.draft.submission, undefined)
  assert.equal(h.context.readComposerDraft("s2"), "other draft")
  assert.deepEqual(h.calls.sending, [true, false])
})

test("a late source error reports the original session without changing the new session", async () => {
  const pending = deferred()
  const h = harness({ api: { steerSessionMessage: () => pending.promise } })
  const sent = h.send("follow up", [], {}, "steer")
  const otherState = h.switchSession()
  pending.reject(new h.context.ApiError({ status: 410, detail: "archived", kind: "notFound", code: "session_archived" }))
  assert.equal(await sent, false)
  assert.equal(h.state, otherState)
  assert.equal(h.calls.updatedSessions[0].id, "s1")
  assert.equal(h.calls.updatedSessions[0].sourceAvailability, "archived")
  assert.deepEqual(h.calls.sourceErrors, [])
  assert.deepEqual(h.calls.sending, [true])
})

test("real draft persistence rejects stale or malformed retry metadata", () => {
  const h = harness()
  const metadata = { action: "steer", clientMessageId: "stable-id", fileIds: ["file-1"] }
  h.context.writeComposerDraft("s1", "saved", metadata)
  assert.deepEqual(plain(h.context.readComposerDraftState("s1").submission), metadata)
  const key = h.context.composerDraftStorageKey("s1")
  h.storage.setItem(key, "edited")
  assert.equal(h.context.readComposerDraftState("s1").submission, undefined)
  h.storage.setItem(`${key}.submission`, "{invalid")
  assert.equal(h.context.readComposerDraftState("s1").submission, undefined)
  h.storage.setItem(`${key}.submission`, JSON.stringify({ value: "edited", action: "steer", clientMessageId: "id", fileIds: [7] }))
  assert.equal(h.context.readComposerDraftState("s1").submission, undefined)
  h.context.writeComposerDraft("s1", "replacement")
  assert.equal(h.storage.getItem(`${key}.submission`), null)
})
