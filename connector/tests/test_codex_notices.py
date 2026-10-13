from dataclasses import replace

from connector.runtime_protocol import SessionNotice
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry


def _error(turn_id: str) -> SessionNotice:
    return SessionNotice(
        notice_id=f"error_{turn_id}",
        session_id="session",
        runtime="codex",
        type="interaction",
        title="Codex turn failed",
        interaction_type="execution_error",
        source={"turnId": turn_id},
    )


def test_consecutive_failures_close_old_error_and_preserve_current_error() -> None:
    registry = CodexNoticeRegistry()
    registry.upsert(_error("first"))
    assert not registry.open_blocking_for_session("session")
    closed = registry.close_open_for_session("session", "closed", "failed", "test")
    assert [notice.notice_id for notice in closed] == ["error_first"]
    registry.upsert(_error("second"))
    assert registry.get("error_first").status == "closed"
    assert registry.current_for_session("session") == (_error("second"),)
    assert not registry.open_blocking_for_session("session")


def test_terminal_cleanup_does_not_close_unrelated_nonblocking_notices() -> None:
    registry = CodexNoticeRegistry()
    notices = (
        replace(_error("other_session"), session_id="other"),
        replace(_error("notification"), type="notification", interaction_type=None),
        replace(_error("other_type"), interaction_type="other_error"),
        replace(_error("requires_response"), response_required=True),
        replace(_error("has_actions"), actions=({"actionId": "retry"},)),
    )
    for notice in notices:
        registry.upsert(notice)
    assert not registry.close_open_for_session("session", "closed", "completed", "test")
    assert all(registry.get(notice.notice_id).status == "open" for notice in notices)


def test_terminal_cleanup_still_closes_real_blocking_approvals() -> None:
    registry = CodexNoticeRegistry()
    registry.upsert(
        replace(
            _error("approval"),
            interaction_type="approval",
            blocking={"scope": "session", "targetId": "session"},
            response_required=True,
            actions=({"actionId": "approve"},),
        )
    )
    closed = registry.close_open_for_session("session", "closed", "failed", "test")
    assert len(closed) == 1
    assert closed[0].blocking is None
    assert closed[0].response_required is False
    assert not closed[0].actions
