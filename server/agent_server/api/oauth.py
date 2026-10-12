from __future__ import annotations

from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Form, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from agent_server.api.auth_session import limit_refresh
from agent_server.core.api_namespace import api_v2_path
from agent_server.core.auth import DEFAULT_USER_EXPIRES_IN
from agent_server.core.models import (
    OAuthAuthorizeRequest,
    OAuthAuthorizeResponse,
    OAuthMetadataResponse,
    OAuthTokenResponse,
    UserView,
)
from agent_server.core.oauth_clients import first_party_oauth_client
from agent_server.core.utc import utc_now
from agent_server.deps import current_user, get_store
from agent_server.infra.repositories.facade import Store
from agent_server.services.auth_sessions import (
    NATIVE_CLIENTS,
    AuthSessions,
    SessionError,
)

router = APIRouter(tags=["oauth"])


@router.get("/.well-known/oauth-authorization-server", response_model=OAuthMetadataResponse)
async def oauth_metadata(request: Request) -> OAuthMetadataResponse:
    issuer = _public_origin(request)
    return OAuthMetadataResponse(
        issuer=issuer,
        authorization_endpoint=f"{issuer}{api_v2_path('/oauth/authorize')}",
        token_endpoint=f"{issuer}{api_v2_path('/oauth/token')}",
        response_types_supported=["code"],
        grant_types_supported=["authorization_code", "refresh_token"],
        code_challenge_methods_supported=["S256"],
    )


@router.get("/oauth/authorize")
async def oauth_authorize(
    response_type: str,
    client_id: str,
    redirect_uri: str,
    code_challenge: str,
    code_challenge_method: str = "S256",
    scope: str = "",
    state: str | None = None,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> RedirectResponse:
    redirect_url = await _create_authorization_redirect(
        response_type=response_type,
        client_id=client_id,
        redirect_uri=redirect_uri,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
        scope=scope,
        state=state,
        user=user,
        db=db,
    )
    return RedirectResponse(redirect_url)


@router.post("/oauth/authorize", response_model=OAuthAuthorizeResponse)
async def oauth_authorize_json(
    payload: OAuthAuthorizeRequest,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> OAuthAuthorizeResponse:
    redirect_url = await _create_authorization_redirect(
        response_type=payload.response_type,
        client_id=payload.client_id,
        redirect_uri=payload.redirect_uri,
        code_challenge=payload.code_challenge,
        code_challenge_method=payload.code_challenge_method,
        scope=payload.scope,
        state=payload.state,
        user=user,
        db=db,
    )
    return OAuthAuthorizeResponse(redirectUrl=redirect_url, serverTime=utc_now())


async def _create_authorization_redirect(
    *,
    response_type: str,
    client_id: str,
    redirect_uri: str,
    code_challenge: str,
    code_challenge_method: str,
    scope: str,
    state: str | None,
    user: UserView,
    db: Store,
) -> str:
    if response_type != "code":
        raise HTTPException(status_code=422, detail="response_type must be code")
    client = first_party_oauth_client(client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="oauth client not found")
    if not client.allows_redirect(redirect_uri):
        raise HTTPException(status_code=422, detail="redirect uri is not allowed")
    try:
        code = await db.create_oauth_authorization_code(
            client_id=client_id,
            user_id=user.userId,
            redirect_uri=redirect_uri,
            scope=scope,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
            expected_auth_version=user.authVersion,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="oauth client not found") from None
    except ValueError as exc:
        if str(exc) == "login authorization revoked":
            raise HTTPException(401, "reauth_required", headers={"X-AA-Auth-Error": "reauth_required"}) from None
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    params = {"code": code}
    if state is not None:
        params["state"] = state
    return f"{redirect_uri}?{urlencode(params)}"


@router.post("/oauth/token", response_model=OAuthTokenResponse)
async def oauth_token(
    request: Request,
    response: Response,
    grant_type: str = Form(...),
    code: str | None = Form(None),
    client_id: str = Form(...),
    redirect_uri: str | None = Form(None),
    code_verifier: str | None = Form(None),
    refresh_token: str | None = Form(None),
    refresh_attempt_id: str | None = Form(None),
    refresh_protocol_version: int = Form(0),
    db: Store = Depends(get_store),
) -> OAuthTokenResponse:
    response.headers["Cache-Control"] = "no-store"
    if grant_type == "refresh_token":
        await limit_refresh(request, refresh_token)
        try:
            result = await AuthSessions(db).native_refresh(refresh_token, client_id, refresh_attempt_id)
        except SessionError as error:
            return JSONResponse(status_code=400, content={"error": "invalid_grant", "code": error.code}, headers={"Cache-Control": "no-store"})
        return _token_response(result, scope=result["scope"])
    if grant_type != "authorization_code":
        raise HTTPException(status_code=422, detail="grant_type must be authorization_code")
    client = first_party_oauth_client(client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="oauth client not found")
    if not code or not redirect_uri or not code_verifier:
        raise HTTPException(status_code=422, detail="authorization_code fields are required")
    if not client.allows_redirect(redirect_uri):
        raise HTTPException(status_code=422, detail="redirect uri is not allowed")
    try:
        user, scope = await db.consume_oauth_authorization_code(
            code=code,
            client_id=client_id,
            redirect_uri=redirect_uri,
            code_verifier=code_verifier,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        result, _ = await AuthSessions(db).create(user.userId, client_id, transport="native" if refresh_protocol_version == 1 and client_id in NATIVE_CLIENTS else "legacy", scope=scope, access_seconds=None if refresh_protocol_version == 1 and client_id in NATIVE_CLIENTS else DEFAULT_USER_EXPIRES_IN, expected_auth_version=user.authVersion)
    except SessionError:
        raise HTTPException(400, "invalid authorization code") from None
    return _token_response(result, scope=scope)


def _token_response(result, *, scope=""):
    return OAuthTokenResponse(access_token=result["accessToken"], token_type="Bearer", expires_in=result["accessExpiresIn"], scope=scope,
        refresh_token=result["refreshToken"], session_id=result["sessionId"], user_id=result["userId"],
        access_expires_at=result["accessExpiresAt"], refresh_expires_at=result["refreshExpiresAt"],
        idle_expires_at=result["idleExpiresAt"], absolute_expires_at=result["absoluteExpiresAt"],
        credential_version=result["credentialVersion"], server_time=result["serverTime"])


def _public_origin(request: Request) -> str:
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.url.netloc
    return f"{scheme}://{host}"
