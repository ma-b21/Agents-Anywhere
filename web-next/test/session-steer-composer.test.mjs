import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test, { after } from "node:test"
import vm from "node:vm"
import React, { act } from "react"
import { JSDOM } from "jsdom"
import ts from "typescript"

const require = createRequire(import.meta.url)
const { window } = new JSDOM("<!doctype html><html><body></body></html>")
const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
globalThis.window = window
globalThis.document = window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// Initialize React's event system after the DOM exists, so keyboard/input events
// follow the browser path rather than the legacy non-DOM input polyfill.
const { createRoot } = await import("react-dom/client")
after(() => {
  globalThis.window = previous.window
  globalThis.document = previous.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
  window.close()
})

function loadSource(path, stubs = {}) {
  const source = ts.transpileModule(readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const context = vm.createContext({ exports: {}, require: name => stubs[name] ?? require(name) })
  vm.runInContext(source, context, { filename: path })
  return context.exports
}

const dependencies = {
  "@/components/session/capabilities": loadSource("components/session/capabilities.ts"),
  "@/components/session/session-message-action": loadSource("components/session/session-message-action.ts"),
  "@/components/session/catalog-selection": loadSource("components/session/catalog-selection.ts"),
  "@/features/dashboard/runtime-instances": loadSource("features/dashboard/runtime-instances.ts"),
}
const capabilities = (ids = ["session.steer", "session.interrupt", "runtime.attachment"]) => ({
  capabilities: ids.map(capabilityId => ({ capabilityId, supported: true, available: true, allowed: true })),
})
const attachment = { id: "attachment-1", name: "note.txt", uploadStatus: "uploaded", uploaded: { path: "note.txt" } }
const noop = () => {}

async function mount(t, { value = "补充要求", files = [], onSend, ...overrides } = {}) {
  const container = window.document.createElement("div")
  window.document.body.append(container)
  const root = createRoot(container)
  const calls = { send: [], interrupt: 0, clear: 0, draftChanges: [] }
  const controls = {}
  const stubs = {
    ...dependencies,
    "next-intl": { useTranslations: () => key => key },
    "lucide-react": Object.fromEntries(["ArrowUp", "Check", "ChevronDown", "Loader2", "Square"].map(name => [name, () => React.createElement("span", { "data-icon": name })])),
    "@/components/ui/button": { Button: ({ variant, size, ...props }) => React.createElement("button", props) },
    "@/components/ui/textarea": { Textarea: props => React.createElement("textarea", props) },
    "@/components/ui/switch": { Switch: () => null },
    "@/components/ui/dropdown-menu": {},
    "@/components/session/selection-settings-drawer": { SelectionSettingsDrawer: () => null },
    "@/hooks/use-element-width": { useElementWidth: () => 800 },
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    "@/components/attachment-input": {
      AttachmentButton: () => null,
      DragOverlay: () => null,
      AttachmentPreviewList: ({ attachments }) => React.createElement("ul", { "data-attachments": true }, attachments.map(file => React.createElement("li", { key: file.id }, file.name))),
      useAttachments: () => {
        const [attachments, setAttachments] = React.useState(files)
        controls.setAttachments = setAttachments
        return {
          attachments, attachmentsAllowed: true, attachmentError: null,
          isDragging: false, uploadsPending: false, uploadFailed: false, allUploaded: true,
          add: noop, remove: noop,
          clear: () => { calls.clear += 1; setAttachments([]) },
          onDragEnter: noop, onDragLeave: noop, onDragOver: noop, onDrop: noop,
        }
      },
    },
  }
  const { SessionComposer } = loadSource("components/session/session-composer.tsx", stubs)
  let props = {
    token: "token",
    session: { id: "s1", runtime: "codex", runtimeType: "codex", connectorStatus: "online", takeover: true, archived: false, status: "running" },
    runtimeState: { status: "running", metadata: {}, selections: {} },
    pendingInteractionCount: 0, sending: false, interrupting: false, takeoverBusy: false,
    effectiveCapabilities: capabilities(), modelCatalog: null, permissionCatalog: null,
    runtimeCommands: [], onCommandQueryChange: noop, onSelectionChange: async () => true,
    onSend: async (...args) => { calls.send.push(args); return onSend ? onSend(...args) : true },
    onInterrupt: () => { calls.interrupt += 1 }, onCommand: noop, onToggleTakeover: noop,
    ...overrides,
  }
  function Harness() {
    const [draft, setDraft] = React.useState(value)
    const [retryAction, setRetryAction] = React.useState(props.retryAction)
    controls.setDraft = setDraft
    const onValueChange = React.useCallback(next => {
      calls.draftChanges.push(next)
      setDraft(next)
      setRetryAction(undefined)
    }, [])
    return React.createElement(SessionComposer, { ...props, retryAction, value: draft, onValueChange })
  }
  t.after(async () => { await act(() => root.unmount()); container.remove() })
  await act(() => root.render(React.createElement(Harness)))
  const textarea = () => container.querySelector("textarea")
  return {
    container, calls, textarea,
    sendButton: () => container.querySelector('button[aria-label="steer"], button[aria-label="send"]'),
    stopButton: () => container.querySelector('button[aria-label="interrupt"]'),
    key: (options = {}) => textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...options })),
    type: async draft => act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea(), draft)
      textarea().dispatchEvent(new window.Event("input", { bubbles: true }))
    }),
    setFiles: async next => act(() => controls.setAttachments(next)),
    update: async next => act(() => { props = { ...props, ...next }; root.render(React.createElement(Harness)) }),
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test("running steer button submits the real composer action while keeping Stop separate", async t => {
  const ui = await mount(t)
  assert.equal(ui.sendButton().disabled, false)
  assert.ok(ui.stopButton())
  await act(() => ui.sendButton().click())
  assert.equal(ui.calls.send.length, 1)
  assert.equal(ui.calls.send[0][0], "补充要求")
  assert.equal(ui.calls.send[0][3], "steer")
  assert.equal(ui.calls.interrupt, 0)
  assert.equal(ui.textarea().value, "")
})

test("Enter steers, but Shift+Enter and IME composition do not submit", async t => {
  const ui = await mount(t)
  await act(() => { ui.key({ shiftKey: true }); ui.key({ isComposing: true }) })
  assert.equal(ui.calls.send.length, 0)
  await act(() => ui.key())
  assert.equal(ui.calls.send.length, 1)
  assert.equal(ui.calls.send[0][3], "steer")
})

test("Stop invokes only interrupt and retains the typed draft", async t => {
  const ui = await mount(t)
  await act(() => ui.stopButton().click())
  assert.equal(ui.calls.interrupt, 1)
  assert.equal(ui.calls.send.length, 0)
  assert.equal(ui.textarea().value, "补充要求")
})

test("missing steer, blocked and read-only states reject both click and Enter", async t => {
  const ui = await mount(t)
  const cases = [
    { effectiveCapabilities: capabilities(["session.send_message", "session.interrupt"]) },
    { effectiveCapabilities: capabilities(), runtimeState: { status: "blocked", metadata: {}, selections: {} } },
    { runtimeState: { status: "running", metadata: {}, selections: {} }, session: { id: "s1", runtime: "codex", connectorStatus: "online", takeover: false, status: "running" } },
  ]
  for (const patch of cases) {
    await ui.update(patch)
    assert.equal(ui.sendButton().disabled, true)
    await act(() => { ui.sendButton().click(); ui.key() })
    assert.equal(ui.calls.send.length, 0)
  }
})

test("same-tick double click and repeated Enter dispatch only one in-flight steer", async t => {
  const pending = deferred()
  const ui = await mount(t, { onSend: () => pending.promise })
  await act(() => { ui.sendButton().click(); ui.sendButton().click(); ui.key(); ui.key({ repeat: true }) })
  assert.equal(ui.calls.send.length, 1)
  await act(async () => pending.resolve(true))
  assert.equal(ui.textarea().value, "")
})

test("delayed success preserves text typed after submission", async t => {
  const pending = deferred()
  const ui = await mount(t, { onSend: () => pending.promise })
  await act(() => ui.sendButton().click())
  await ui.type("下一条新草稿")
  assert.equal(ui.textarea().value, "下一条新草稿")
  await act(async () => pending.resolve(true))
  assert.equal(ui.textarea().value, "下一条新草稿")
  assert.equal(ui.calls.clear, 0)
})

test("delayed success preserves attachments added after submission", async t => {
  const pending = deferred()
  const ui = await mount(t, { files: [attachment], onSend: () => pending.promise })
  await act(() => ui.sendButton().click())
  await ui.setFiles([attachment, { ...attachment, id: "attachment-2", name: "new.txt" }])
  await act(async () => pending.resolve(true))
  assert.equal(ui.container.querySelectorAll("[data-attachments] li").length, 2)
  assert.equal(ui.textarea().value, "补充要求")
  assert.equal(ui.calls.clear, 0)
})

test("failed steer retains the original text and attachments and permits retry", async t => {
  const ui = await mount(t, { files: [attachment], onSend: async () => false })
  await act(() => ui.sendButton().click())
  assert.equal(ui.calls.send.length, 1)
  assert.equal(ui.calls.send[0][1][0], attachment)
  assert.equal(ui.textarea().value, "补充要求")
  assert.equal(ui.container.querySelector("[data-attachments] li").textContent, "note.txt")
  assert.equal(ui.calls.clear, 0)
  await act(() => ui.key())
  assert.equal(ui.calls.send.length, 2)
  assert.equal(ui.calls.send[1][3], "steer")
})

test("an original steer retry cannot silently become an idle send", async t => {
  const ui = await mount(t, {
    retryAction: "steer",
    runtimeState: { status: "idle", metadata: {}, selections: {} },
    effectiveCapabilities: capabilities(["session.send_message", "session.steer"]),
  })
  assert.equal(ui.sendButton().disabled, true)
  await act(() => ui.key())
  assert.equal(ui.calls.send.length, 0)
})

test("editing attachment identity clears retry intent and enables a fresh message", async t => {
  const ui = await mount(t, {
    files: [attachment], retryAction: "steer",
    runtimeState: { status: "idle", metadata: {}, selections: {} },
    effectiveCapabilities: capabilities(["session.send_message", "runtime.attachment"]),
  })
  assert.equal(ui.sendButton().disabled, true)
  assert.equal(ui.calls.draftChanges.length, 0)
  await ui.setFiles([])
  assert.deepEqual(ui.calls.draftChanges, ["补充要求"])
  assert.equal(ui.sendButton().disabled, false)
  await act(() => ui.sendButton().click())
  assert.equal(ui.calls.send[0][3], "send")
})

test("upload status changes with unchanged attachment identity retain retry intent", async t => {
  const ui = await mount(t, {
    files: [attachment], retryAction: "steer",
    runtimeState: { status: "idle", metadata: {}, selections: {} },
    effectiveCapabilities: capabilities(["session.send_message", "runtime.attachment"]),
  })
  await ui.setFiles([{ ...attachment, uploadStatus: "uploading" }])
  assert.equal(ui.sendButton().disabled, true)
  assert.equal(ui.calls.draftChanges.length, 0)
  await act(() => ui.key())
  assert.equal(ui.calls.send.length, 0)
})

test("running slash commands do not expose an enabled no-op send button", async t => {
  const ui = await mount(t, { value: "/plan" })
  assert.equal(ui.sendButton().disabled, true)
  await act(() => ui.key())
  assert.equal(ui.calls.send.length, 0)
})
