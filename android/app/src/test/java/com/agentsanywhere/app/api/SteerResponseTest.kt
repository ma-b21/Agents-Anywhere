package com.agentsanywhere.app.api

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SteerResponseTest {
    @Test
    fun successfulConnectorPayloadDoesNotRequireAnInnerOkFlag() {
        JSONObject(
            """{"ok":true,"result":{"steered":true,"turnId":"turn-1","externalSessionId":"thread-1","runtime":"codex","runtimeId":"codex"}}""",
        ).requireSuccessfulSteerResult()
    }

    @Test
    fun explicitOperationSuccessIsAccepted() {
        JSONObject("""{"ok":true,"result":{"ok":true,"steered":true,"error":null}}""")
            .requireSuccessfulSteerResult()
    }

    @Test
    fun noActiveTurnPayloadIsRejectedDespiteSuccessfulHttpEnvelope() {
        assertRejected(
            """{"ok":true,"result":{"ok":false,"code":"codex_no_active_turn","message":"Codex runtime has no active turn to steer","externalSessionId":"thread-1","runtime":"codex","runtimeId":"codex"}}""",
            "Codex runtime has no active turn to steer",
        )
    }

    @Test
    fun unavailableTurnPayloadIsRejected() {
        assertRejected(
            """{"ok":true,"result":{"ok":false,"code":"codex_turn_not_found","message":"Codex turn was unavailable to steer","steered":false,"turnId":"turn-1","runtime":"codex","runtimeId":"codex"}}""",
            "Codex turn was unavailable to steer",
        )
    }

    @Test
    fun falseSteeredFlagWithoutAnOkFlagIsAlsoRejected() {
        assertRejected(
            """{"ok":true,"result":{"steered":false,"code":"turn_finished"}}""",
            "turn_finished",
        )
    }

    @Test
    fun nestedErrorMessageIsRetained() {
        assertRejected(
            """{"ok":true,"result":{"error":{"code":"turn_finished","message":"Turn finished"}}}""",
            "Turn finished",
        )
    }

    @Test
    fun stringErrorIsRetained() {
        assertRejected(
            """{"ok":true,"result":{"ok":false,"error":"Turn finished"}}""",
            "Turn finished",
        )
    }

    @Test
    fun missingMessageFallsBackToCode() {
        assertRejected(
            """{"ok":true,"result":{"ok":false,"message":null,"code":"codex_no_active_turn"}}""",
            "codex_no_active_turn",
        )
    }

    @Test
    fun blankErrorDetailsHaveAUsefulFallback() {
        assertRejected(
            """{"ok":true,"result":{"ok":false,"message":" ","code":null}}""",
            "Runtime rejected the steer message.",
        )
    }

    @Test
    fun transportFailuresStayOnTheExistingRpcResponsePath() {
        JSONObject(
            """{"ok":false,"error":{"code":"connector_offline","message":"Connector is offline"},"result":{"ok":false,"message":"Do not replace the transport error"}}""",
        ).requireSuccessfulSteerResult()
    }

    @Test
    fun successfulPayloadIsNotRecursivelyScannedForUnrelatedErrors() {
        JSONObject("""{"ok":true,"result":{"steered":true,"metadata":{"ok":false,"error":"old error"}}}""")
            .requireSuccessfulSteerResult()
    }

    private fun assertRejected(payload: String, expectedMessage: String) {
        val error = assertThrows(IllegalStateException::class.java) {
            JSONObject(payload).requireSuccessfulSteerResult()
        }
        assertEquals(expectedMessage, error.message)
    }
}
