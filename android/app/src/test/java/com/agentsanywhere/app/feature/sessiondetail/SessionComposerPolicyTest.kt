package com.agentsanywhere.app.feature.sessiondetail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class SessionComposerPolicyTest {
    @Test
    fun runningRequiresSteerEvenIfSendCapabilityIsStale() {
        assertEquals(RuntimeMessageAction.Steer, sessionMessageAction(SessionRuntimeStatus.Running, false, true))
        assertEquals(RuntimeMessageAction.Steer, sessionMessageAction(SessionRuntimeStatus.Running, true, true))
        assertNull(sessionMessageAction(SessionRuntimeStatus.Running, true, false))
        assertFalse(sessionCommandsAllowed(SessionRuntimeStatus.Running))
    }

    @Test
    fun idleAndErrorSendNormallyButNeverSteer() {
        for (status in listOf(SessionRuntimeStatus.Idle, SessionRuntimeStatus.Error)) {
            assertEquals(RuntimeMessageAction.Send, sessionMessageAction(status, true, true))
            assertNull(sessionMessageAction(status, false, true))
        }
    }

    @Test
    fun blockedStatesRejectStaleCapabilities() {
        val blocked = SessionRuntimeStatus.entries - setOf(
            SessionRuntimeStatus.Idle, SessionRuntimeStatus.Error, SessionRuntimeStatus.Running,
        )
        for (status in blocked) {
            assertNull(sessionMessageAction(status, true, true))
            assertFalse(sessionCommandsAllowed(status))
        }
    }

    @Test
    fun retriesKeepTheirOriginalAction() {
        assertNull(sessionMessageAction(SessionRuntimeStatus.Idle, true, true, RuntimeMessageAction.Steer))
        assertNull(sessionMessageAction(SessionRuntimeStatus.Running, true, true, RuntimeMessageAction.Send))
        assertEquals(RuntimeMessageAction.Steer, sessionMessageAction(
            SessionRuntimeStatus.Running, false, true, RuntimeMessageAction.Steer,
        ))
        assertEquals(RuntimeMessageAction.Send, sessionMessageAction(
            SessionRuntimeStatus.Idle, true, false, RuntimeMessageAction.Send,
        ))
    }
}
