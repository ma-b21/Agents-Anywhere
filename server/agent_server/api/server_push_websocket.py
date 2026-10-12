from __future__ import annotations

import asyncio
import os
from collections.abc import Coroutine

from fastapi import WebSocket, WebSocketDisconnect

_CLOSED_SEND_ERRORS = frozenset(
    {
        'Cannot call "send" once a close message has been sent.',
        (
            "Unexpected ASGI message 'websocket.send', after sending "
            "'websocket.close'."
        ),
    }
)


def is_closed_websocket_send_error(error: RuntimeError) -> bool:
    """Return whether an ASGI server rejected a send after closing the socket."""

    return str(error) in _CLOSED_SEND_ERRORS


def consume_cancelled_task_result(task: asyncio.Task[None]) -> None:
    """Retrieve the terminal state of a task cancelled during socket shutdown."""

    if task.cancelled():
        return
    task.exception()


def cancel_websocket_task(task: asyncio.Task[None]) -> None:
    """Request cancellation without delaying the WebSocket disconnect path."""

    if task.done():
        return
    task.add_done_callback(consume_cancelled_task_result)
    task.cancel()


async def wait_for_websocket_disconnect(websocket: WebSocket) -> None:
    """Consume inbound frames until the client disconnects.

    Server-push streams do not define client messages, so non-disconnect frames
    are intentionally ignored.
    """

    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return


async def run_server_push_until_disconnect(
    websocket: WebSocket,
    outbound_stream: Coroutine[object, object, None],
    authentication: Coroutine[object, object, None] | None = None,
) -> None:
    """Run an outbound stream while monitoring the client connection.

    Side effects:
    - consumes inbound WebSocket frames
    - cancels the unfinished task when the other side completes
    """

    outbound_task = asyncio.create_task(outbound_stream)
    disconnect_task = asyncio.create_task(wait_for_websocket_disconnect(websocket))
    auth_task = asyncio.create_task(authentication) if authentication is not None else None
    tasks = (outbound_task, disconnect_task) + ((auth_task,) if auth_task else ())

    try:
        completed, _pending = await asyncio.wait(
            tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )

        if auth_task is not None and auth_task in completed:
            cancel_websocket_task(outbound_task)
            cancel_websocket_task(disconnect_task)
            auth_task.result()
            return
        if auth_task is not None:
            cancel_websocket_task(auth_task)

        if disconnect_task in completed:
            try:
                disconnect_task.result()
            except WebSocketDisconnect:
                pass
            if outbound_task.done() and not outbound_task.cancelled():
                complete_outbound_stream(outbound_task)
            else:
                cancel_websocket_task(outbound_task)
            return

        cancel_websocket_task(disconnect_task)
        complete_outbound_stream(outbound_task)
    except asyncio.CancelledError:
        for task in tasks:
            cancel_websocket_task(task)
        raise


def complete_outbound_stream(outbound_task: asyncio.Task[None]) -> None:
    """Raise only errors that do not represent an already closed connection."""

    try:
        outbound_task.result()
    except WebSocketDisconnect:
        return
    except RuntimeError as error:
        if is_closed_websocket_send_error(error):
            return
        raise


async def wait_for_auth_revocation(websocket, db, user_id, login_session_id=None, legacy_hash=None):
    from agent_server.services.auth_sessions import AuthSessions, SessionError
    service = AuthSessions(db)
    while True:
        await asyncio.sleep(max(0.1, float(os.environ.get("AGENT_SERVER_WS_AUTH_CHECK_SECONDS", "1"))))
        try:
            await service.check_connection(user_id, login_session_id, legacy_hash)
        except SessionError:
            await websocket.close(code=4401, reason="reauth_required")
            return


async def receive_authenticated_json(websocket, authentication, user_id, session_id=None, legacy_hash=None):
    """Revalidate idle terminals and every input, not the original access expiry."""
    from agent_server.services.auth_sessions import SessionError
    while True:
        try:
            try:
                message = await asyncio.wait_for(websocket.receive_json(), timeout=1.0)
            except TimeoutError:
                await authentication.check_connection(user_id, session_id, legacy_hash)
                continue
            await authentication.check_connection(user_id, session_id, legacy_hash)
            return message
        except SessionError:
            await websocket.close(code=4401, reason="reauth_required")
            raise WebSocketDisconnect(code=4401) from None
