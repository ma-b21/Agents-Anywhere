import assert from "node:assert/strict"
import test from "node:test"
import { blockingNotices, legacyFailure, visibleInteractions } from "./helpers/notice-policy.mjs"

test("legacy informational failure is still visible but does not block", () => {
  const notice = legacyFailure()
  assert.deepEqual(blockingNotices([notice]), [])
  assert.deepEqual(visibleInteractions([notice]), [notice])
  assert.equal(notice.message, "Exploded")
})

test("new nonblocking failure is still visible", () => {
  const notice = { ...legacyFailure(), blocking: null }
  assert.deepEqual(blockingNotices([notice]), [])
  assert.deepEqual(visibleInteractions([notice]), [notice])
})

test("all open legacy failure statuses are nonblocking", () => {
  for (const status of ["open", "responding", "response_accepted", "resolving", "failed"]) {
    assert.deepEqual(blockingNotices([{ ...legacyFailure(), status }]), [])
  }
})

test("approval and input request blocking is unchanged", () => {
  for (const interactionType of ["approval", "input_request"]) {
    const notice = { ...legacyFailure(), interactionType, responseRequired: true, actions: [{ actionId: "answer" }] }
    assert.deepEqual(blockingNotices([notice]), [notice])
  }
})

test("execution errors with response or action remain blocking", () => {
  for (const patch of [{ responseRequired: true }, { actions: [{ actionId: "retry" }] }]) {
    const notice = { ...legacyFailure(), ...patch }
    assert.deepEqual(blockingNotices([notice]), [notice])
  }
})

test("unknown or incomplete error notices are not silently unblocked", () => {
  for (const patch of [{ interactionType: "other_error" }, { interactionType: undefined }, { responseRequired: undefined }, { actions: undefined }]) {
    const notice = { ...legacyFailure(), ...patch }
    assert.deepEqual(blockingNotices([notice]), [notice])
  }
})

test("blocking target, scope and terminal statuses still apply", () => {
  const approval = { ...legacyFailure(), interactionType: "approval" }
  assert.deepEqual(blockingNotices([approval], "other_session"), [])
  assert.deepEqual(blockingNotices([{ ...approval, blocking: { scope: "timeline_item", targetId: "s1" } }]), [])
  for (const status of ["resolved", "closed", "cancelled", "expired"]) {
    assert.deepEqual(blockingNotices([{ ...approval, status }]), [])
  }
})

test("restored failure never hides a simultaneous genuine approval", () => {
  const snapshot = JSON.parse(JSON.stringify([legacyFailure()]))
  const approval = { ...legacyFailure(), noticeId: "approval", interactionType: "approval" }
  assert.deepEqual(blockingNotices([...snapshot, approval]), [approval])
  assert.deepEqual(blockingNotices(snapshot), [])
})
