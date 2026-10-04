import assert from "node:assert/strict"
import test from "node:test"

import { sessionMessageAction } from "../src/components/session/session-message-action.ts"

test("idle and error require send capability and never select steer", () => {
  for (const status of ["idle", "error"]) {
    for (const canSteer of [false, true]) {
      assert.equal(sessionMessageAction({ status, canSendMessage: true, canSteer }), "send")
      assert.equal(sessionMessageAction({ status, canSendMessage: false, canSteer }), null)
    }
  }
})

test("running requires steer capability even when send capability is stale", () => {
  for (const canSendMessage of [false, true]) {
    assert.equal(sessionMessageAction({ status: "running", canSendMessage, canSteer: true }), "steer")
    assert.equal(sessionMessageAction({ status: "running", canSendMessage, canSteer: false }), null)
  }
})

test("other states block sending despite stale usable capabilities", () => {
  for (const status of ["waiting", "pending", "stopping", "waiting_approval", "blocked", "disconnected", "unknown"]) {
    for (const canSendMessage of [false, true]) {
      for (const canSteer of [false, true]) {
        assert.equal(sessionMessageAction({ status, canSendMessage, canSteer }), null)
      }
    }
  }
})

test("retry preserves its original action across runtime transitions", () => {
  const capabilities = { canSendMessage: true, canSteer: true }
  assert.equal(sessionMessageAction({ ...capabilities, status: "running", retryAction: "steer" }), "steer")
  assert.equal(sessionMessageAction({ ...capabilities, status: "running", retryAction: "send" }), null)
  for (const status of ["idle", "error"]) {
    assert.equal(sessionMessageAction({ ...capabilities, status, retryAction: "send" }), "send")
    assert.equal(sessionMessageAction({ ...capabilities, status, retryAction: "steer" }), null)
  }
  assert.equal(sessionMessageAction({ status: "running", canSendMessage: true, canSteer: false, retryAction: "steer" }), null)
  assert.equal(sessionMessageAction({ status: "idle", canSendMessage: false, canSteer: true, retryAction: "send" }), null)
})
