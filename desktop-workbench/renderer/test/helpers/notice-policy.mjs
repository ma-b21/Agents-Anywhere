import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../../src/components/session-detail.tsx", import.meta.url), "utf8")
const ast = ts.createSourceFile("session-detail.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = ["openInteractions", "blockingInteractions", "isSessionBlockingInteraction"]
const helpers = names.map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(declaration, `missing helper ${name}`)
  return declaration.getText(ast)
}).join("\n")
const context = vm.createContext({})
vm.runInContext(ts.transpileModule(helpers, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context)

export const blockingNotices = (notices, sessionId = "s1") => Array.from(context.blockingInteractions(notices, sessionId))
export const visibleInteractions = notices => Array.from(context.openInteractions(notices))
export const legacyFailure = () => ({
  noticeId: "failure", type: "interaction", sessionId: "s1", status: "open",
  interactionType: "execution_error", responseRequired: false, actions: [],
  blocking: { scope: "session", targetId: "s1" },
  message: "Exploded", source: { turnId: "failed_turn" },
})
