from __future__ import annotations

import hmac
import os
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from agent_server.core.api_namespace import API_V2_PREFIX
from agent_server.core.auth import (
    DEFAULT_USER_EXPIRES_IN,
    create_signed_token,
    verify_signed_token,
)
from agent_server.core.models import AuthResponse
from agent_server.deps import get_store
from agent_server.infra.repositories.facade import Store
from agent_server.services.auth_refresh_limit import (
    AuthRefreshLimit,
    RefreshRateLimited,
)
from agent_server.services.auth_sessions import (
    NATIVE_CLIENTS,
    WEB_CLIENT,
    AuthSessions,
    SessionError,
    digest,
    timestamp,
)

router = APIRouter(tags=["auth-session"])


async def limit_refresh(request, credential):
    limiter = getattr(request.app.state, "auth_refresh_limit", None)
    if limiter is None:
        limiter = AuthRefreshLimit(request.app.state.redis)
        request.app.state.auth_refresh_limit = limiter
    try:
        await limiter.check(
            request.client.host if request.client else "unknown", credential
        )
    except RefreshRateLimited:
        raise HTTPException(
            429,
            "refresh_rate_limited",
            headers={"Retry-After": "60", "Cache-Control": "no-store"},
        ) from None


def cookie_name(request):
    return "aa_session_" + digest(request.url.netloc + API_V2_PREFIX)[:12]


def no_store(response):
    response.headers["Cache-Control"] = "no-store"


def check_origin(request, *, required=True):
    origin = request.headers.get("origin")
    if origin is None and not required:
        return
    public = os.environ.get(
        "AGENT_SERVER_PUBLIC_ORIGIN", str(request.base_url).rstrip("/")
    )
    allowed = {public} | {
        value.strip()
        for value in os.environ.get("AGENT_SERVER_CORS_ORIGINS", "").split(",")
        if value.strip()
    }
    if origin not in allowed:
        raise HTTPException(
            403, "csrf_failed", headers={"X-AA-Auth-Error": "csrf_failed"}
        )


def secure_cookie(request):
    return (
        request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto") == "https"
    )


def set_session_cookie(request, response, secret, expires):
    if not secure_cookie(request) and request.url.hostname not in {
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        raise HTTPException(400, "HTTPS is required for browser sessions")
    response.set_cookie(
        cookie_name(request),
        secret,
        httponly=True,
        secure=secure_cookie(request),
        samesite="lax",
        path=API_V2_PREFIX,
        expires=expires,
    )


async def check_csrf(request, service, row=None):
    check_origin(request)
    supplied = request.headers.get("x-csrf-token", "")
    if row:
        expected = service.csrf(row)
    else:
        expected = request.cookies.get(cookie_name(request) + "_csrf", "")
        if not verify_signed_token("web_login_csrf", expected):
            raise HTTPException(
                403, "csrf_failed", headers={"X-AA-Auth-Error": "csrf_failed"}
            )
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(
            403, "csrf_failed", headers={"X-AA-Auth-Error": "csrf_failed"}
        )


async def validate_auth_csrf(request, db):
    service = AuthSessions(db)
    web = request.headers.get("x-aa-session-protocol") == "1"
    if web:
        if not secure_cookie(request) and request.url.hostname not in {
            "localhost",
            "127.0.0.1",
            "::1",
        }:
            raise HTTPException(400, "HTTPS is required for browser sessions")
        row = None
        try:
            row = await service.web_session(
                request.cookies.get(cookie_name(request), "")
            )
        except SessionError:
            pass
        await check_csrf(request, service, row)


async def finish_auth(user, db, request, response):
    service = AuthSessions(db)
    web = request.headers.get("x-aa-session-protocol") == "1"
    try:
        credentials, secret = await service.create(
            user.userId,
            WEB_CLIENT,
            transport="web" if web else "legacy",
            access_seconds=None if web else DEFAULT_USER_EXPIRES_IN,
            expected_auth_version=user.authVersion,
        )
    except SessionError as error:
        raise auth_error(error) from None
    if web:
        from datetime import datetime

        set_session_cookie(
            request,
            response,
            secret,
            datetime.fromisoformat(
                credentials["absoluteExpiresAt"].replace("Z", "+00:00")
            ),
        )
    no_store(response)
    return AuthResponse(
        **credentials,
        role=user.role,
        email=user.email,
        emailVerified=user.emailVerified,
        displayName=user.displayName,
    )


class SessionRequest(BaseModel):
    expectedSessionId: str | None = Field(None, max_length=128)
    clientId: str | None = Field(None, max_length=128)
    refreshToken: str | None = Field(None, max_length=1024)
    upgradeAttemptId: str | None = Field(None, max_length=128)
    clearCookie: bool = True


def auth_error(error):
    return HTTPException(
        401,
        error.code,
        headers={"X-AA-Auth-Error": error.code, "Cache-Control": "no-store"},
    )


@router.get("/auth/session/bootstrap")
async def bootstrap(
    request: Request, response: Response, db: Store = Depends(get_store)
):
    check_origin(request, required=False)
    no_store(response)
    service = AuthSessions(db)
    try:
        row = await service.web_session(request.cookies.get(cookie_name(request), ""))
    except SessionError:
        token = create_signed_token(
            "web_login_csrf", {"nonce": secrets.token_urlsafe(24)}, 300
        )
        response.set_cookie(
            cookie_name(request) + "_csrf",
            token,
            max_age=300,
            httponly=True,
            secure=secure_cookie(request),
            samesite="lax",
            path=API_V2_PREFIX,
        )
        return {
            "authenticated": False,
            "csrfToken": token,
            "serverTime": timestamp(service.now()),
            "refreshProtocolVersion": 1,
        }
    return {
        "authenticated": True,
        "sessionId": row["id"],
        "userId": row["user_id"],
        "csrfToken": service.csrf(row),
        "serverTime": timestamp(service.now()),
        "refreshProtocolVersion": 1,
    }


@router.post("/auth/session/refresh")
async def refresh(
    payload: SessionRequest,
    request: Request,
    response: Response,
    db: Store = Depends(get_store),
):
    service = AuthSessions(db)
    no_store(response)
    try:
        secret = request.cookies.get(cookie_name(request), "")
        await limit_refresh(request, secret)
        row = await service.web_session(secret, expected=payload.expectedSessionId)
        await check_csrf(request, service, row)
        if not payload.expectedSessionId:
            raise SessionError("session_changed")
        return await service.web_refresh(secret, payload.expectedSessionId)
    except SessionError as error:
        raise auth_error(error) from None


@router.post("/auth/session/logout", status_code=204)
async def logout(
    payload: SessionRequest,
    request: Request,
    response: Response,
    db: Store = Depends(get_store),
):
    service = AuthSessions(db)
    no_store(response)
    try:
        if payload.refreshToken:
            if payload.clientId not in NATIVE_CLIENTS or not payload.expectedSessionId:
                raise SessionError()
            await service.revoke_with_refresh(
                payload.refreshToken, payload.clientId, payload.expectedSessionId
            )
        elif request.headers.get("authorization", "").startswith("Bearer "):
            claims = await service.verify_access(request.headers["authorization"][7:])
            if not claims.get("sid") or claims["sid"] != payload.expectedSessionId:
                raise SessionError("session_changed")
            await service.revoke(claims["sid"], claims["sub"])
        else:
            row = await service.web_session(
                request.cookies.get(cookie_name(request), ""),
                expected=payload.expectedSessionId,
            )
            await check_csrf(request, service, row)
            if not payload.expectedSessionId:
                raise SessionError("session_changed")
            await service.revoke(row["id"], row["user_id"])
            if payload.clearCookie:
                response.delete_cookie(
                    cookie_name(request),
                    path=API_V2_PREFIX,
                    httponly=True,
                    secure=secure_cookie(request),
                    samesite="lax",
                )
    except SessionError as error:
        raise auth_error(error) from None


@router.post("/auth/session/upgrade")
async def upgrade(
    payload: SessionRequest,
    request: Request,
    response: Response,
    db: Store = Depends(get_store),
):
    service = AuthSessions(db)
    web = payload.clientId == WEB_CLIENT
    await limit_refresh(request, "upgrade:" + request.headers.get("authorization", ""))
    if web:
        await validate_auth_csrf(request, db)
        if request.headers.get("x-aa-session-protocol") != "1":
            raise HTTPException(400, "browser session protocol is required")
    token = request.headers.get("authorization", "")
    no_store(response)
    try:
        if not token.startswith("Bearer "):
            raise SessionError()
        result = await service.upgrade(
            token[7:],
            payload.clientId,
            payload.upgradeAttemptId,
            transport="web" if web else "native",
        )
        if web:
            from datetime import datetime

            set_session_cookie(
                request,
                response,
                result["cookieSecret"],
                datetime.fromisoformat(
                    result["credentials"]["absoluteExpiresAt"].replace("Z", "+00:00")
                ),
            )
        return result["credentials"]
    except SessionError as error:
        raise auth_error(error) from None
