package com.agentsanywhere.app.feature.sessiondetail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeNoticePolicyTest {
    private fun failure() = RuntimeNotice(
        noticeId = "failure", type = "interaction", sessionId = "session",
        title = "Codex turn failed", message = "Exploded", severity = "error",
        status = "open", interactionType = "execution_error",
        blocking = RuntimeNoticeBlocking("session", "session"), responseRequired = false,
        revision = 1, updatedSeq = 1, source = mapOf("turnId" to "failed_turn"),
        actions = emptyList(), context = emptyMap(), metadata = emptyMap(),
        expiresAt = null, createdAt = null, updatedAt = null, resolvedAt = null,
    )

    private fun action() = RuntimeNoticeAction(
        actionId = "answer", label = "Answer", style = "primary",
        input = RuntimeNoticeActionInput(false, null, null), unknown = emptyMap(),
    )

    private fun blockers(notices: List<RuntimeNotice>) =
        notices.filter { it.openInteraction && it.blocksSession("session") }

    @Test
    fun legacyFailureDoesNotBlockButRemainsVisible() {
        val notice = failure()
        assertFalse(notice.blocksSession("session"))
        assertTrue(notice.openInteraction)
        assertFalse(notice.respondable)
        assertEquals("Exploded", notice.message)
        assertEquals(RuntimeMessageAction.Send, sessionMessageAction(SessionRuntimeStatus.Error, true, false))
    }

    @Test
    fun newNonblockingFailureRemainsVisible() {
        val notice = failure().copy(blocking = null)
        assertTrue(notice.openInteraction)
        assertFalse(notice.blocksSession("session"))
    }

    @Test
    fun restoredAndUpdatedFailuresUseTheSameNonblockingPolicy() {
        val snapshot = failure().copy(revision = 4, updatedSeq = 12)
        val update = snapshot.copy(revision = 5, updatedSeq = 13)
        assertTrue(blockers(listOf(snapshot)).isEmpty())
        assertTrue(blockers(listOf(update)).isEmpty())
    }

    @Test
    fun allOpenLegacyFailureStatusesAreNonblocking() {
        for (status in listOf("open", "responding", "response_accepted", "resolving", "failed")) {
            assertTrue(blockers(listOf(failure().copy(status = status))).isEmpty())
        }
    }

    @Test
    fun approvalsAndInputRequestsRemainBlocking() {
        for (type in listOf("approval", "input_request")) {
            val notice = failure().copy(interactionType = type, responseRequired = true, actions = listOf(action()))
            assertTrue(notice.blocksSession("session"))
            assertTrue(notice.respondable)
        }
    }

    @Test
    fun actionableOrResponseRequiredExecutionErrorsRemainBlocking() {
        assertTrue(failure().copy(responseRequired = true).blocksSession("session"))
        assertTrue(failure().copy(actions = listOf(action())).blocksSession("session"))
    }

    @Test
    fun unknownTypesAndNotificationsAreNotSilentlyUnblocked() {
        assertTrue(failure().copy(interactionType = "unknown_error").blocksSession("session"))
        assertTrue(failure().copy(interactionType = null).blocksSession("session"))
        assertTrue(failure().copy(type = "notification").blocksSession("session"))
    }

    @Test
    fun blockingScopeAndTargetStillApply() {
        val approval = failure().copy(interactionType = "approval")
        assertFalse(approval.blocksSession("other"))
        assertFalse(approval.copy(blocking = RuntimeNoticeBlocking("timeline_item", "session")).blocksSession("session"))
        assertFalse(approval.copy(blocking = null).blocksSession("session"))
    }

    @Test
    fun realApprovalStillBlocksAlongsideHistoricalFailure() {
        val approval = failure().copy(noticeId = "approval", interactionType = "approval", actions = listOf(action()))
        assertEquals(listOf(approval), blockers(listOf(failure(), approval)))
        assertTrue(blockers(listOf(failure(), approval.copy(status = "resolved"))).isEmpty())
    }
}
