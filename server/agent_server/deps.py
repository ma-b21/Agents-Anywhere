from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from starlette.requests import HTTPConnection

from agent_server.core.models import UserView
from agent_server.infra.connector_gateway import ConnectorGateway
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.attachments import AttachmentService
from agent_server.services.catalogs import CatalogService
from agent_server.services.connector_files import ConnectorFileService
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.connector_notifications import ConnectorNotificationService
from agent_server.services.connector_realtime import ConnectorRealtimeService
from agent_server.services.connector_shell import ConnectorShellService
from agent_server.services.device_runtimes import DeviceRuntimeService
from agent_server.services.event_recovery import EventRecoveryService
from agent_server.services.session_run import SessionRunService
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache
from agent_server.services.terminal import TerminalService
from agent_server.services.terminal_relay import TerminalRelayService
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer


def get_store(conn: HTTPConnection) -> Store:
    return conn.app.state.store


def get_attachment_service(conn: HTTPConnection) -> AttachmentService:
    return conn.app.state.store.attachments


def get_catalog_service(conn: HTTPConnection) -> CatalogService:
    return CatalogService(conn.app.state.store)


def get_event_recovery_service(conn: HTTPConnection) -> EventRecoveryService:
    return EventRecoveryService(
        conn.app.state.store,
        conn.app.state.rpc,
        conn.app.state.timeline_write_buffer,
    )


def get_connector_ingest_service(conn: HTTPConnection) -> ConnectorIngestService:
    realtime = get_connector_realtime_service(conn)
    return ConnectorIngestService(
        conn.app.state.store,
        ConnectorNotificationService(
            conn.app.state.store,
            realtime,
            conn.app.state.timeline_write_buffer,
        ),
        conn.app.state.timeline_broker,
        conn.app.state.device_runtime_service,
        conn.app.state.rpc,
        conn.app.state.session_runtime_state_cache,
    )


def get_connector_realtime_service(conn: HTTPConnection) -> ConnectorRealtimeService:
    return ConnectorRealtimeService(
        conn.app.state.shell_tasks,
        conn.app.state.terminal_broker,
        conn.app.state.terminal_stream_hub,
    )


def get_connector_shell_service(conn: HTTPConnection) -> ConnectorShellService:
    return ConnectorShellService(
        ConnectorGateway(conn.app.state.rpc),
        conn.app.state.shell_tasks,
    )


def get_connector_file_service(conn: HTTPConnection) -> ConnectorFileService:
    return ConnectorFileService(
        ConnectorGateway(conn.app.state.rpc),
        conn.app.state.fs_downloads,
    )


def get_session_run_service(conn: HTTPConnection) -> SessionRunService:
    return SessionRunService(
        conn.app.state.store,
        conn.app.state.rpc,
        conn.app.state.device_runtime_service,
    )


def get_device_runtime_service(conn: HTTPConnection) -> DeviceRuntimeService:
    return conn.app.state.device_runtime_service


def get_terminal_service(conn: HTTPConnection) -> TerminalService:
    return TerminalService(
        conn.app.state.store,
        conn.app.state.rpc,
        conn.app.state.terminal_broker,
    )


def get_terminal_relay_service(conn: HTTPConnection) -> TerminalRelayService:
    return TerminalRelayService(
        conn.app.state.store,
        conn.app.state.rpc,
        conn.app.state.terminal_broker,
    )


def get_rpc(conn: HTTPConnection) -> ConnectorRpcManager:
    return conn.app.state.rpc


def get_terminal_broker(conn: HTTPConnection) -> TerminalBroker:
    return conn.app.state.terminal_broker


def get_fs_downloads(conn: HTTPConnection) -> FsDownloadRelayManager:
    return conn.app.state.fs_downloads


def get_timeline_broker(conn: HTTPConnection) -> TimelineBroker:
    return conn.app.state.timeline_broker


def get_timeline_write_buffer(conn: HTTPConnection) -> TimelineWriteBuffer:
    return conn.app.state.timeline_write_buffer


def get_session_runtime_state_cache(
    conn: HTTPConnection,
) -> SessionRuntimeStateCache:
    return conn.app.state.session_runtime_state_cache


async def current_user_id(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Store = Depends(get_store),
) -> str:
    """Validate the bearer and its persistent login session before side effects.

    current_user additionally returns the profile and records platform activity.
    """
    prefix = "Bearer "
    if authorization is None or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="missing user access token")
    from agent_server.services.auth_sessions import AuthSessions, SessionError
    try:
        claims = await AuthSessions(db).verify_access(authorization[len(prefix) :])
    except SessionError as error:
        # Keep the existing disabled-account status for old callers.
        from agent_server.core.auth import verify_user_access_claims
        signed = verify_user_access_claims(authorization[len(prefix) :])
        if signed:
            try:
                user = await db.get_user(signed["sub"])
                if user.disabled:
                    raise HTTPException(status_code=403, detail="account disabled", headers={"X-AA-Auth-Error": "account_disabled"})
            except KeyError:
                pass
        raise HTTPException(status_code=401, detail="invalid user access token", headers={"X-AA-Auth-Error": error.code}) from None
    return claims["sub"]


async def current_user(
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    authorization: str | None = Header(None, alias="Authorization"),
) -> UserView:
    """Load the full user record. Rejects accounts that were disabled or deleted
    after the token was issued.
    """
    try:
        user = await db.get_user(user_id)
    except KeyError:
        raise HTTPException(status_code=401, detail="user no longer exists") from None
    if user.disabled:
        raise HTTPException(status_code=403, detail="account disabled")
    # The profile read must not launder a revoked request into a newer auth
    # epoch if a password change occurred after the first bearer validation.
    from agent_server.services.auth_sessions import AuthSessions, SessionError
    if isinstance(authorization, str) and authorization.startswith("Bearer "):
        try:
            await AuthSessions(db).verify_access(authorization[7:])
        except SessionError as error:
            raise HTTPException(401, "reauth_required", headers={"X-AA-Auth-Error": error.code}) from None
    await db.record_platform_activity(user.userId)
    return user


def require_admin(user: UserView = Depends(current_user)) -> UserView:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin role required")
    return user
