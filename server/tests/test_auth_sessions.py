from __future__ import annotations

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import select
from test_auth import bearer, make_client, pkce_challenge, register

from agent_server.core.auth import create_user_access_token
from agent_server.infra.db.schema import auth_refresh_history
from agent_server.services.auth_sessions import AuthSessions, SessionError


def fixture_session(tmp_path, monkeypatch, *, transport="native"):
    monkeypatch.setenv("AGENT_SERVER_SESSION_ACCESS_SECONDS", "2")
    monkeypatch.setenv("AGENT_SERVER_SESSION_IDLE_SECONDS", "100")
    monkeypatch.setenv("AGENT_SERVER_SESSION_MAX_SECONDS", "300")
    client = make_client(tmp_path)
    user = register(client, "renewal").json()["userId"]
    clock = [int(time.time())]
    service = AuthSessions(client.app.state.store, clock=lambda: clock[0])
    client_id = (
        "agents-anywhere-web" if transport == "web" else "agents-anywhere-mobile"
    )
    result, secret = asyncio.run(
        service.create(user, client_id, transport=transport, scope="sessions:read")
    )
    return client, service, result, secret, clock


def test_access_expiry_renews_and_slides_idle_deadline(tmp_path, monkeypatch):
    _, service, initial, _, clock = fixture_session(tmp_path, monkeypatch)
    start = clock[0]
    clock[0] += 90
    with pytest.raises(SessionError):
        asyncio.run(service.verify_access(initial["accessToken"]))
    renewed = asyncio.run(
        service.native_refresh(
            initial["refreshToken"], "agents-anywhere-mobile", "attempt1"
        )
    )
    assert renewed["refreshToken"] != initial["refreshToken"]
    assert renewed["sessionId"] == initial["sessionId"]
    assert renewed["credentialVersion"] == 2
    assert renewed["scope"] == "sessions:read"
    clock[0] = start + 101  # Beyond original refresh expiry, new one still works.
    again = asyncio.run(
        service.native_refresh(
            renewed["refreshToken"], "agents-anywhere-mobile", "attempt2"
        )
    )
    assert (
        asyncio.run(service.verify_access(again["accessToken"]))["sid"]
        == initial["sessionId"]
    )


def test_same_attempt_recovers_after_lost_response_and_new_service(
    tmp_path, monkeypatch
):
    client, service, original, _, clock = fixture_session(tmp_path, monkeypatch)
    result = asyncio.run(
        service.native_refresh(
            original["refreshToken"], "agents-anywhere-mobile", "stable-attempt"
        )
    )
    clock[0] += 1
    restarted = AuthSessions(client.app.state.store, clock=lambda: clock[0])
    recovered = asyncio.run(
        restarted.native_refresh(
            original["refreshToken"], "agents-anywhere-mobile", "stable-attempt"
        )
    )
    assert recovered["refreshToken"] == result["refreshToken"]
    assert recovered["accessToken"] == result["accessToken"]
    assert recovered["accessExpiresIn"] == 1
    assert recovered["idleExpiresAt"] == result["idleExpiresAt"]


def test_different_attempt_replay_revokes_whole_family(tmp_path, monkeypatch):
    _, service, original, _, _ = fixture_session(tmp_path, monkeypatch)
    new = asyncio.run(
        service.native_refresh(
            original["refreshToken"], "agents-anywhere-mobile", "first"
        )
    )
    with pytest.raises(SessionError):
        asyncio.run(
            service.native_refresh(
                original["refreshToken"], "agents-anywhere-mobile", "other"
            )
        )
    with pytest.raises(SessionError):
        asyncio.run(
            service.native_refresh(
                new["refreshToken"], "agents-anywhere-mobile", "next"
            )
        )
    with pytest.raises(SessionError):
        asyncio.run(service.verify_access(new["accessToken"]))


def test_wrong_client_does_not_revoke_legitimate_session(tmp_path, monkeypatch):
    _, service, original, _, _ = fixture_session(tmp_path, monkeypatch)
    with pytest.raises(SessionError):
        asyncio.run(
            service.native_refresh(
                original["refreshToken"], "agents-anywhere-desktop", "wrong"
            )
        )
    assert (
        asyncio.run(
            service.native_refresh(
                original["refreshToken"], "agents-anywhere-mobile", "right"
            )
        )["userId"]
        == original["userId"]
    )


@pytest.mark.parametrize("offset", [100, 101])
def test_idle_expired_cannot_be_revived(tmp_path, monkeypatch, offset):
    _, service, original, _, clock = fixture_session(tmp_path, monkeypatch)
    clock[0] += offset
    with pytest.raises(SessionError):
        asyncio.run(
            service.native_refresh(
                original["refreshToken"], "agents-anywhere-mobile", "late"
            )
        )


def test_absolute_deadline_and_optional_native_unlimited_age(tmp_path, monkeypatch):
    _, service, original, _, clock = fixture_session(tmp_path, monkeypatch)
    current = original
    for index in range(3):
        clock[0] += 90
        current = asyncio.run(
            service.native_refresh(
                current["refreshToken"], "agents-anywhere-mobile", str(index)
            )
        )
    clock[0] += 30
    with pytest.raises(SessionError):
        asyncio.run(
            service.native_refresh(
                current["refreshToken"], "agents-anywhere-mobile", "limit"
            )
        )
    monkeypatch.setenv("AGENT_SERVER_SESSION_MAX_SECONDS", "0")
    unlimited, _ = asyncio.run(
        service.create(original["userId"], "agents-anywhere-mobile")
    )
    assert unlimited["absoluteExpiresAt"] is None


def test_twenty_parallel_same_attempts_commit_one_rotation(tmp_path, monkeypatch):
    client, _, original, _, _ = fixture_session(tmp_path, monkeypatch)

    def refresh(_):
        return asyncio.run(
            AuthSessions(client.app.state.store).native_refresh(
                original["refreshToken"], "agents-anywhere-mobile", "shared-attempt"
            )
        )

    with ThreadPoolExecutor(max_workers=8) as workers:
        results = list(workers.map(refresh, range(20)))
    assert len({item["refreshToken"] for item in results}) == 1
    assert {item["credentialVersion"] for item in results} == {2}


def test_failed_rotation_transaction_keeps_original_usable(tmp_path, monkeypatch):
    _, service, original, _, _ = fixture_session(tmp_path, monkeypatch)
    bundle = service.bundle
    monkeypatch.setattr(
        service,
        "bundle",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("injected failure")),
    )
    with pytest.raises(RuntimeError):
        asyncio.run(
            service.native_refresh(
                original["refreshToken"], "agents-anywhere-mobile", "attempt"
            )
        )
    monkeypatch.setattr(service, "bundle", bundle)
    assert (
        asyncio.run(
            service.native_refresh(
                original["refreshToken"], "agents-anywhere-mobile", "attempt"
            )
        )["credentialVersion"]
        == 2
    )


def test_recovery_data_encrypted_and_cleanup_retains_replay_detection(
    tmp_path, monkeypatch
):
    _, service, original, _, clock = fixture_session(tmp_path, monkeypatch)
    monkeypatch.setenv("AGENT_SERVER_REFRESH_RECOVERY_SECONDS", "1")
    renewed = asyncio.run(
        service.native_refresh(
            original["refreshToken"], "agents-anywhere-mobile", "attempt"
        )
    )

    async def stored():
        async with service.store.engine.connect() as conn:
            return (await conn.execute(select(auth_refresh_history))).mappings().one()

    entry = asyncio.run(stored())
    assert renewed["refreshToken"] not in entry["response_encrypted"]
    clock[0] += 1
    asyncio.run(service.cleanup())
    assert asyncio.run(stored())["response_encrypted"] == ""
    with pytest.raises(SessionError):
        asyncio.run(
            service.native_refresh(
                original["refreshToken"], "agents-anywhere-mobile", "attempt"
            )
        )


def test_refresh_api_has_no_authorization_code_fields_and_no_store(
    tmp_path, monkeypatch
):
    client, _, original, _, _ = fixture_session(tmp_path, monkeypatch)
    response = client.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "client_id": "agents-anywhere-mobile",
            "refresh_token": original["refreshToken"],
            "refresh_attempt_id": "attempt",
        },
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["scope"] == "sessions:read"
    assert response.json()["refresh_token"] != original["refreshToken"]
    invalid = client.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "client_id": "agents-anywhere-mobile",
            "refresh_token": "invalid",
            "refresh_attempt_id": "attempt",
        },
    )
    assert invalid.status_code == 400
    assert invalid.json()["error"] == "invalid_grant"


def test_native_oauth_code_issues_full_renewable_credentials(tmp_path):
    client = make_client(tmp_path)
    user = register(client, "code-user").json()["userId"]
    verifier = "long-pkce-verifier" * 4
    code = asyncio.run(
        client.app.state.store.create_oauth_authorization_code(
            client_id="agents-anywhere-desktop",
            user_id=user,
            redirect_uri="agents-anywhere-desktop://oauth/callback",
            scope="",
            code_challenge=pkce_challenge(verifier),
            code_challenge_method="S256",
        )
    )
    response = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": "agents-anywhere-desktop",
            "code": code,
            "redirect_uri": "agents-anywhere-desktop://oauth/callback",
            "code_verifier": verifier,
            "refresh_protocol_version": 1,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["refresh_token"].startswith("aar_")
    assert response.json()["session_id"]


def test_logout_and_password_change_revoke_new_and_legacy_tokens(tmp_path, monkeypatch):
    client, service, original, _, _ = fixture_session(tmp_path, monkeypatch)
    old = create_user_access_token(original["userId"])
    response = client.post(
        "/auth/session/logout",
        json={
            "expectedSessionId": original["sessionId"],
            "clientId": "agents-anywhere-mobile",
            "refreshToken": original["refreshToken"],
        },
    )
    assert response.status_code == 204
    assert (
        client.get("/auth/me", headers=bearer(original["accessToken"])).status_code
        == 401
    )
    password_response = client.post(
        "/auth/change-password", headers=bearer(old), json={"newPassword": "different"}
    )
    assert password_response.status_code == 204
    assert client.get("/auth/me", headers=bearer(old)).status_code == 401


def test_valid_legacy_upgrade_is_idempotent_and_expired_token_rejected(tmp_path):
    client = make_client(tmp_path)
    initial = register(client, "upgrade").json()
    body = {
        "clientId": "agents-anywhere-desktop",
        "upgradeAttemptId": "installation-attempt",
    }
    first = client.post(
        "/auth/session/upgrade", headers=bearer(initial["accessToken"]), json=body
    )
    second = client.post(
        "/auth/session/upgrade", headers=bearer(initial["accessToken"]), json=body
    )
    assert first.status_code == second.status_code == 200
    assert first.json()["refreshToken"] == second.json()["refreshToken"]
    expired = create_user_access_token(initial["userId"], expires_in=-1)
    assert (
        client.post(
            "/auth/session/upgrade", headers=bearer(expired), json=body
        ).status_code
        == 401
    )


def web_client(tmp_path):
    client = make_client(tmp_path)
    client.base_url = "https://testserver"
    initial = client.get("/auth/session/bootstrap").json()
    headers = {
        "origin": "https://testserver",
        "x-aa-session-protocol": "1",
        "x-csrf-token": initial["csrfToken"],
    }
    client.get("/auth/config")
    setup = client.app.state.setup_token.peek()
    response = client.post(
        "/auth/register",
        headers=headers,
        json={
            "email": "web@example.test",
            "displayName": "Web test",
            "password": "secret",
            "setupToken": setup,
        },
    )
    assert response.status_code == 200, response.text
    state = client.get("/auth/session/bootstrap").json()
    headers["x-csrf-token"] = state["csrfToken"]
    return client, response.json(), headers


def test_web_renewal_cookie_security_and_no_set_cookie_on_refresh(tmp_path):
    client, credentials, headers = web_client(tmp_path)
    response = client.post(
        "/auth/session/refresh",
        headers=headers,
        json={"expectedSessionId": credentials["sessionId"]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["refreshToken"] is None
    assert "set-cookie" not in response.headers
    assert response.headers["cache-control"] == "no-store"
    cookie = next(cookie for cookie in client.cookies.jar if "csrf" not in cookie.name)
    assert cookie.secure and cookie.has_nonstandard_attr("HttpOnly")


@pytest.mark.parametrize("kind", ["missing_csrf", "evil_origin", "wrong_sid"])
def test_web_csrf_origin_and_session_binding(tmp_path, kind):
    client, credentials, headers = web_client(tmp_path)
    sid = credentials["sessionId"]
    if kind == "missing_csrf":
        headers.pop("x-csrf-token")
    elif kind == "evil_origin":
        headers["origin"] = "https://evil.example"
    else:
        sid = "another-session"
    response = client.post(
        "/auth/session/refresh", headers=headers, json={"expectedSessionId": sid}
    )
    assert response.status_code == (401 if kind == "wrong_sid" else 403)


def test_web_invalid_csrf_does_not_create_user(tmp_path):
    client = make_client(tmp_path)
    client.base_url = "https://testserver"
    client.get("/auth/config")
    response = client.post(
        "/auth/register",
        headers={"origin": "https://testserver", "x-aa-session-protocol": "1"},
        json={
            "email": "bad@example.test",
            "password": "secret",
            "setupToken": client.app.state.setup_token.peek(),
        },
    )
    assert response.status_code == 403
    assert asyncio.run(client.app.state.store.count_users()) == 0


def test_web_logout_without_lock_only_revokes_expected_session(tmp_path):
    client, credentials, headers = web_client(tmp_path)
    response = client.post(
        "/auth/session/logout",
        headers=headers,
        json={"expectedSessionId": credentials["sessionId"], "clearCookie": False},
    )
    assert response.status_code == 204
    assert "set-cookie" not in response.headers
    assert (
        client.get("/auth/me", headers=bearer(credentials["accessToken"])).status_code
        == 401
    )


def test_superseded_recovery_does_not_revoke_current_credentials(tmp_path, monkeypatch):
    _, service, original, _, _ = fixture_session(tmp_path, monkeypatch)
    first = asyncio.run(
        service.native_refresh(
            original["refreshToken"], "agents-anywhere-mobile", "one"
        )
    )
    second = asyncio.run(
        service.native_refresh(first["refreshToken"], "agents-anywhere-mobile", "two")
    )
    with pytest.raises(SessionError, match="refresh_superseded"):
        asyncio.run(
            service.native_refresh(
                original["refreshToken"], "agents-anywhere-mobile", "one"
            )
        )
    asyncio.run(service.verify_access(second["accessToken"]))


def test_active_connection_survives_access_expiry_but_not_logout(tmp_path, monkeypatch):
    _, service, original, _, clock = fixture_session(tmp_path, monkeypatch)
    clock[0] += 3
    with pytest.raises(SessionError):
        asyncio.run(service.verify_access(original["accessToken"]))
    asyncio.run(service.check_connection(original["userId"], original["sessionId"]))
    asyncio.run(service.revoke(original["sessionId"], original["userId"]))
    with pytest.raises(SessionError):
        asyncio.run(service.check_connection(original["userId"], original["sessionId"]))


def test_recovery_key_rotation_supports_previous_key(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    old_key, new_key = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    monkeypatch.setenv("AGENT_SERVER_REFRESH_ENCRYPTION_KEYS", old_key)
    _, service, original, _, _ = fixture_session(tmp_path, monkeypatch)
    first = asyncio.run(
        service.native_refresh(
            original["refreshToken"], "agents-anywhere-mobile", "same"
        )
    )
    monkeypatch.setenv("AGENT_SERVER_REFRESH_ENCRYPTION_KEYS", new_key + "," + old_key)
    assert (
        asyncio.run(
            service.native_refresh(
                original["refreshToken"], "agents-anywhere-mobile", "same"
            )
        )["refreshToken"]
        == first["refreshToken"]
    )


def test_native_refresh_rate_limit_preserves_session(tmp_path, monkeypatch):
    client, service, original, _, _ = fixture_session(tmp_path, monkeypatch)
    monkeypatch.setenv("AGENT_SERVER_REFRESH_CREDENTIAL_PER_MINUTE", "2")
    body = {
        "grant_type": "refresh_token",
        "client_id": "agents-anywhere-mobile",
        "refresh_token": original["refreshToken"],
        "refresh_attempt_id": "same",
    }
    assert client.post("/oauth/token", data=body).status_code == 200
    assert client.post("/oauth/token", data=body).status_code == 200
    response = client.post("/oauth/token", data=body)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"
    assert response.headers["cache-control"] == "no-store"
    asyncio.run(service.check_connection(original["userId"], original["sessionId"]))


def test_ticket_issued_before_logout_cannot_open_dashboard(tmp_path, monkeypatch):
    from starlette.websockets import WebSocketDisconnect

    client, _, original, _, _ = fixture_session(tmp_path, monkeypatch)
    response = client.post(
        "/ws-ticket",
        headers=bearer(original["accessToken"]),
        json={"clientId": "test-client", "scope": {"dashboard": True}},
    )
    assert response.status_code == 200, response.text
    client.post(
        "/auth/session/logout",
        json={
            "expectedSessionId": original["sessionId"],
            "clientId": "agents-anywhere-mobile",
            "refreshToken": original["refreshToken"],
        },
    )
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect(
            "/dashboard/ws?ticket=" + response.json()["ticket"]
        ):
            pass
    assert error.value.code == 4401


@pytest.mark.parametrize("sidless", [False, True])
def test_upgraded_logout_revokes_legacy_http_and_connections(tmp_path, sidless):
    from agent_server.services.auth_sessions import digest

    client = make_client(tmp_path)
    initial = register(client, "old-connection").json()
    token = (
        create_user_access_token(initial["userId"])
        if sidless
        else initial["accessToken"]
    )
    service = AuthSessions(client.app.state.store)
    upgraded = asyncio.run(
        service.upgrade(token, "agents-anywhere-mobile", "stable", transport="native")
    )["credentials"]
    asyncio.run(service.revoke(upgraded["sessionId"], upgraded["userId"]))
    with pytest.raises(SessionError):
        asyncio.run(service.verify_access(token))
    with pytest.raises(SessionError):
        asyncio.run(
            service.check_connection(
                initial["userId"],
                None if sidless else initial["sessionId"],
                digest(token),
            )
        )


@pytest.mark.parametrize(
    "route",
    ["/connectors/any/terminals/any/stream", "/connectors/any/terminals-v2/any/stream"],
)
def test_connector_terminal_rejects_revoked_access(tmp_path, monkeypatch, route):
    from starlette.websockets import WebSocketDisconnect

    client, service, initial, _, _ = fixture_session(tmp_path, monkeypatch)
    asyncio.run(service.revoke(initial["sessionId"], initial["userId"]))
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect(route + "?token=" + initial["accessToken"]):
            pass
    assert error.value.code == 4401


def test_connector_download_bearer_rejects_revoked_access(tmp_path, monkeypatch):
    from agent_server.api.connector_files import _user_id_from_authorization

    client, service, initial, _, _ = fixture_session(tmp_path, monkeypatch)
    asyncio.run(service.revoke(initial["sessionId"], initial["userId"]))
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            _user_id_from_authorization(
                "Bearer " + initial["accessToken"], client.app.state.store
            )
        )
    assert error.value.status_code == 401


def test_password_change_invalidates_pending_oauth_code_and_qr(tmp_path):
    client = make_client(tmp_path)
    initial = register(client, "pending").json()
    verifier = "pkce-verifier" * 5
    code = asyncio.run(
        client.app.state.store.create_oauth_authorization_code(
            client_id="agents-anywhere-mobile",
            user_id=initial["userId"],
            redirect_uri="agents-anywhere://oauth/callback",
            scope="",
            code_challenge=pkce_challenge(verifier),
            code_challenge_method="S256",
        )
    )
    qr = client.post(
        "/auth/mobile-login/qr", headers=bearer(initial["accessToken"])
    ).json()
    client.post(
        "/auth/mobile-login/request",
        json={
            "userId": initial["userId"],
            "loginToken": qr["loginToken"],
            "deviceName": "fake-phone",
        },
    )
    assert (
        client.post(
            "/auth/mobile-login/confirm",
            headers=bearer(initial["accessToken"]),
            json={"loginToken": qr["loginToken"], "approved": True},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/auth/change-password",
            headers=bearer(initial["accessToken"]),
            json={"newPassword": "changed"},
        ).status_code
        == 204
    )
    assert (
        client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": "agents-anywhere-mobile",
                "redirect_uri": "agents-anywhere://oauth/callback",
                "code": code,
                "code_verifier": verifier,
                "refresh_protocol_version": 1,
            },
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/auth/mobile-login/exchange",
            json={
                "userId": initial["userId"],
                "loginToken": qr["loginToken"],
                "refreshProtocolVersion": 1,
            },
        ).status_code
        == 401
    )


def test_password_changed_between_verification_and_session_creation(
    tmp_path, monkeypatch
):
    client = make_client(tmp_path)
    initial = register(client, "login-race").json()
    store = client.app.state.store
    verify = store.verify_email_user

    async def raced(**kwargs):
        user = await verify(**kwargs)
        await store.update_user_password(initial["userId"], "new-password")
        return user

    monkeypatch.setattr(store, "verify_email_user", raced)
    response = client.post(
        "/auth/login", json={"email": "login-race@example.test", "password": "secret"}
    )
    assert response.status_code == 401, response.text


def test_credential_epoch_rejects_stale_issuance_after_password_change(
    tmp_path, monkeypatch
):
    client, service, initial, _, _ = fixture_session(tmp_path, monkeypatch)
    asyncio.run(
        client.app.state.store.update_user_password(initial["userId"], "changed")
    )
    with pytest.raises(SessionError):
        asyncio.run(
            service.create(
                initial["userId"], "agents-anywhere-mobile", expected_auth_version=0
            )
        )
    asyncio.run(
        service.create(
            initial["userId"], "agents-anywhere-mobile", expected_auth_version=1
        )
    )


def test_rate_limit_is_shared_across_workers(monkeypatch):
    import fakeredis.aioredis

    from agent_server.infra.redis_coordinator import RedisCoordinator
    from agent_server.services.auth_refresh_limit import (
        AuthRefreshLimit,
        RefreshRateLimited,
    )

    monkeypatch.setenv("AGENT_SERVER_REFRESH_CREDENTIAL_PER_MINUTE", "2")

    async def exercise():
        redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
        first = AuthRefreshLimit(RedisCoordinator(client=redis))
        second = AuthRefreshLimit(RedisCoordinator(client=redis))
        await first.check("fake-ip", "fake-secret")
        await second.check("fake-ip", "fake-secret")
        with pytest.raises(RefreshRateLimited):
            await first.check("fake-ip", "fake-secret")
        for key in await redis.keys("*"):
            assert "fake-secret" not in key
            assert await redis.ttl(key) > 0
        await redis.aclose()

    asyncio.run(exercise())


def test_terminal_receive_rechecks_revocation_before_forwarding(tmp_path, monkeypatch):
    from starlette.websockets import WebSocketDisconnect

    from agent_server.api.server_push_websocket import receive_authenticated_json

    client, service, initial, _, _ = fixture_session(tmp_path, monkeypatch)
    asyncio.run(service.revoke(initial["sessionId"], initial["userId"]))

    class Socket:
        code = None

        async def receive_json(self):
            return {"type": "input", "data": "ignored"}

        async def close(self, *, code, reason):
            self.code = code

    socket = Socket()
    with pytest.raises(WebSocketDisconnect):
        asyncio.run(
            receive_authenticated_json(
                socket, service, initial["userId"], initial["sessionId"]
            )
        )
    assert socket.code == 4401


@pytest.mark.parametrize("kind", ["oauth", "qr"])
def test_authorization_issuance_rejects_password_change_after_request_auth(
    tmp_path, monkeypatch, kind
):
    client = make_client(tmp_path)
    initial = register(client, "issuance-race").json()
    store = client.app.state.store
    method = (
        "create_oauth_authorization_code"
        if kind == "oauth"
        else "record_mobile_login_token"
    )
    original = getattr(store, method)

    async def raced(**kwargs):
        await store.update_user_password(initial["userId"], "changed")
        return await original(**kwargs)

    monkeypatch.setattr(store, method, raced)
    if kind == "oauth":
        response = client.post(
            "/oauth/authorize",
            headers=bearer(initial["accessToken"]),
            json={
                "response_type": "code",
                "client_id": "agents-anywhere-mobile",
                "redirect_uri": "agents-anywhere://oauth/callback",
                "code_challenge": pkce_challenge("fake-verifier" * 5),
                "code_challenge_method": "S256",
            },
        )
    else:
        response = client.post(
            "/auth/mobile-login/qr", headers=bearer(initial["accessToken"])
        )
    assert response.status_code == 401, response.text


def test_profile_read_does_not_launder_revoked_bearer_into_new_epoch(
    tmp_path, monkeypatch
):
    client = make_client(tmp_path)
    initial = register(client, "profile-race").json()
    store = client.app.state.store
    original = store.get_user

    async def raced(user_id):
        await store.update_user_password(user_id, "changed")
        return await original(user_id)

    monkeypatch.setattr(store, "get_user", raced)
    response = client.post(
        "/auth/mobile-login/qr", headers=bearer(initial["accessToken"])
    )
    assert response.status_code == 401, response.text
