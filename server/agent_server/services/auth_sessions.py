"""Database-atomic login renewal, independent of HTTP/cookie transport."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from cryptography.fernet import Fernet, MultiFernet
from sqlalchemy import delete, insert, or_, select, update

from agent_server.core.auth import (
    DEFAULT_USER_EXPIRES_IN,
    _secret,
    create_user_access_token,
    verify_user_access_claims,
)
from agent_server.infra.db.schema import auth_refresh_history as history
from agent_server.infra.db.schema import auth_session_upgrades as upgrades
from agent_server.infra.db.schema import auth_sessions as sessions
from agent_server.infra.db.schema import instance_settings, users

NATIVE_CLIENTS = {"agents-anywhere-mobile", "agents-anywhere-desktop"}
WEB_CLIENT = "agents-anywhere-web"


class SessionError(Exception):
    def __init__(self, code="reauth_required"):
        self.code = code
        super().__init__(code)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def timestamp(value: int | None) -> str | None:
    return (
        datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")
        if value is not None
        else None
    )


def setting(name, default, *, minimum=1):
    return max(minimum, int(os.environ.get(name, str(default))))


def recovery_cipher():
    # Comma-separated Fernet keys, newest first. Domain-separated signing-key
    # derivation is a backwards-compatible default; configure independent keys.
    configured = os.environ.get("AGENT_SERVER_REFRESH_ENCRYPTION_KEYS")
    keys = (
        configured.split(",")
        if configured
        else [
            base64.urlsafe_b64encode(
                hashlib.sha256(b"aa-refresh-recovery:" + _secret()).digest()
            ).decode()
        ]
    )
    return MultiFernet([Fernet(key.strip().encode()) for key in keys])


class AuthSessions:
    def __init__(self, store, *, clock=None):
        self.store = store
        self.clock = clock or time.time

    @asynccontextmanager
    async def transaction(self):
        async with self.store.engine.connect() as conn:
            try:
                # A DB writer reservation, not an in-process mutex. PG uses row
                # locks below; SQLite must reserve before any read/modify/write.
                if self.store.backend == "sqlite":
                    await conn.exec_driver_sql("BEGIN IMMEDIATE")
                else:
                    await conn.begin()
                yield conn
                await conn.commit()
            except BaseException:
                await conn.rollback()
                raise

    def now(self):
        return int(self.clock())

    def idle_deadline(self, now, absolute):
        deadline = now + setting("AGENT_SERVER_SESSION_IDLE_SECONDS", 30 * 86400)
        return min(deadline, absolute) if absolute is not None else deadline

    async def checked(self, conn, row, *, client=None):
        if (
            not row
            or row["revoked_at"] is not None
            or self.now() >= row["idle_expires_at"]
            or (
                row["absolute_expires_at"] is not None
                and self.now() >= row["absolute_expires_at"]
            )
        ):
            raise SessionError()
        if client is not None and row["client_id"] != client:
            raise SessionError()
        user = (
            await conn.execute(
                select(users.c.disabled).where(users.c.id == row["user_id"])
            )
        ).first()
        if not user or user.disabled:
            raise SessionError()
        return dict(row)

    def bundle(self, row, refresh=None, *, access_seconds=None):
        now = self.now()
        ttl = (
            access_seconds
            if access_seconds is not None
            else setting("AGENT_SERVER_SESSION_ACCESS_SECONDS", DEFAULT_USER_EXPIRES_IN)
        )
        ttl = min(ttl, row["idle_expires_at"] - now)
        return {
            "userId": row["user_id"],
            "sessionId": row["id"],
            "scope": row["scope"],
            "accessToken": create_user_access_token(
                row["user_id"], ttl, session_id=row["id"], issued_at=now
            ),
            "tokenType": "bearer",
            "accessExpiresAt": timestamp(now + ttl),
            "accessExpiresIn": ttl,
            "refreshToken": refresh,
            "refreshExpiresAt": timestamp(row["idle_expires_at"]) if refresh else None,
            "idleExpiresAt": timestamp(row["idle_expires_at"]),
            "absoluteExpiresAt": timestamp(row["absolute_expires_at"]),
            "credentialVersion": row["generation"],
            "refreshProtocolVersion": 1,
            "serverTime": timestamp(now),
        }

    async def create(
        self,
        user_id,
        client,
        *,
        transport="native",
        scope="",
        access_seconds=None,
        expected_auth_version=None,
    ):
        async with self.transaction() as conn:
            return await self.create_in(
                conn,
                user_id,
                client,
                transport=transport,
                scope=scope,
                access_seconds=access_seconds,
                expected_auth_version=expected_auth_version,
            )

    async def create_in(
        self,
        conn,
        user_id,
        client,
        *,
        transport,
        scope="",
        access_seconds=None,
        expected_auth_version=None,
    ):
        now = self.now()
        user = (
            await conn.execute(
                select(users.c.disabled, users.c.auth_version)
                .where(users.c.id == user_id)
                .with_for_update()
            )
        ).first()
        if not user or user.disabled:
            raise SessionError()
        if (
            expected_auth_version is not None
            and user.auth_version != expected_auth_version
        ):
            raise SessionError()
        maximum = setting("AGENT_SERVER_SESSION_MAX_SECONDS", 90 * 86400, minimum=0)
        if transport == "web" and maximum == 0:
            maximum = 90 * 86400  # Web fixed cookie lifetime needs a finite cap.
        absolute = now + maximum if maximum else None
        secret = "aar_" + secrets.token_urlsafe(32)
        row = dict(
            id="asl_" + secrets.token_urlsafe(24),
            user_id=user_id,
            client_id=client,
            transport=transport,
            scope=scope,
            credential_hash=digest(secret),
            generation=1,
            created_at=now,
            idle_expires_at=self.idle_deadline(now, absolute),
            absolute_expires_at=absolute,
            revoked_at=None,
        )
        await conn.execute(insert(sessions).values(**row))
        return self.bundle(
            row,
            secret if transport == "native" else None,
            access_seconds=access_seconds,
        ), secret

    async def verify_access(self, token):
        async with self.store.engine.connect() as conn:
            return await self.verify_access_in(conn, token)

    async def verify_access_in(self, conn, token, *, lock=False):
        claims = verify_user_access_claims(token, now=self.now())
        if not claims:
            raise SessionError("access_token_invalid")
        if claims.get("sid"):
            statement = select(sessions).where(sessions.c.id == claims["sid"])
            if lock:
                statement = statement.with_for_update()
            row = (await conn.execute(statement)).mappings().first()
            checked = await self.checked(conn, row)
            if checked["user_id"] != claims["sub"]:
                raise SessionError()
        else:
            user = (
                await conn.execute(
                    select(users.c.disabled, users.c.legacy_auth_revoked).where(
                        users.c.id == claims["sub"]
                    )
                )
            ).first()
            if not user or user.disabled or user.legacy_auth_revoked:
                raise SessionError()
        blocked = (
            await conn.execute(
                select(upgrades.c.session_id)
                .join(sessions, sessions.c.id == upgrades.c.session_id)
                .where(
                    upgrades.c.legacy_hash == digest(token),
                    sessions.c.revoked_at.is_not(None),
                )
            )
        ).first()
        if blocked:
            raise SessionError()
        return claims

    async def native_refresh(self, token, client, attempt):
        if (
            client not in NATIVE_CLIENTS
            or not token
            or not attempt
            or len(attempt) > 128
            or len(token) > 1024
        ):
            raise SessionError()
        failure = False
        async with self.transaction() as conn:
            old = (
                (
                    await conn.execute(
                        select(history).where(
                            history.c.credential_hash == digest(token)
                        )
                    )
                )
                .mappings()
                .first()
            )
            condition = (
                sessions.c.id == old["session_id"]
                if old
                else sessions.c.credential_hash == digest(token)
            )
            row = (
                (
                    await conn.execute(
                        select(sessions).where(condition).with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if row is None and old is None:
                # READ COMMITTED: another PG worker can rotate while this
                # SELECT waits for its row lock; the old-hash predicate then
                # no longer matches. Re-read committed recovery state.
                old = (
                    (
                        await conn.execute(
                            select(history).where(
                                history.c.credential_hash == digest(token)
                            )
                        )
                    )
                    .mappings()
                    .first()
                )
                if old:
                    row = (
                        (
                            await conn.execute(
                                select(sessions)
                                .where(sessions.c.id == old["session_id"])
                                .with_for_update()
                            )
                        )
                        .mappings()
                        .first()
                    )
            row = await self.checked(conn, row, client=client)
            if row["transport"] not in {"native", "legacy"}:
                raise SessionError()
            if old:
                if (
                    old["attempt_hash"] == digest(attempt)
                    and row["generation"] != old["generation"]
                ):
                    raise SessionError("refresh_superseded")
                if (
                    old["attempt_hash"] == digest(attempt)
                    and self.now() < old["recover_until"]
                    and row["generation"] == old["generation"]
                ):
                    result = json.loads(
                        recovery_cipher().decrypt(old["response_encrypted"].encode())
                    )
                    result["serverTime"] = timestamp(self.now())
                    expiry = int(
                        datetime.fromisoformat(
                            result["accessExpiresAt"].replace("Z", "+00:00")
                        ).timestamp()
                    )
                    result["accessExpiresIn"] = max(0, expiry - self.now())
                    return result
                await conn.execute(
                    update(sessions)
                    .where(sessions.c.id == row["id"])
                    .values(revoked_at=self.now())
                )
                failure = True
            else:
                secret = "aar_" + secrets.token_urlsafe(32)
                row.update(
                    transport="native",
                    credential_hash=digest(secret),
                    generation=row["generation"] + 1,
                    idle_expires_at=self.idle_deadline(
                        self.now(), row["absolute_expires_at"]
                    ),
                )
                await conn.execute(
                    update(sessions)
                    .where(sessions.c.id == row["id"])
                    .values(
                        transport="native",
                        credential_hash=row["credential_hash"],
                        generation=row["generation"],
                        idle_expires_at=row["idle_expires_at"],
                    )
                )
                result = self.bundle(row, secret)
                await conn.execute(
                    insert(history).values(
                        credential_hash=digest(token),
                        session_id=row["id"],
                        attempt_hash=digest(attempt),
                        generation=row["generation"],
                        recover_until=self.now()
                        + setting("AGENT_SERVER_REFRESH_RECOVERY_SECONDS", 120),
                        response_encrypted=recovery_cipher()
                        .encrypt(json.dumps(result).encode())
                        .decode(),
                    )
                )
                return result
        if failure:
            raise SessionError()

    async def web_session(self, secret, *, expected=None):
        async with self.store.engine.connect() as conn:
            row = (
                (
                    await conn.execute(
                        select(sessions).where(
                            sessions.c.credential_hash == digest(secret)
                        )
                    )
                )
                .mappings()
                .first()
            )
            row = await self.checked(conn, row, client=WEB_CLIENT)
            if row["transport"] != "web":
                raise SessionError()
            if expected is not None and row["id"] != expected:
                raise SessionError("session_changed")
            return row

    def csrf(self, row):
        return hmac.new(
            _secret(),
            ("web-csrf:" + row["id"] + ":" + row["credential_hash"]).encode(),
            hashlib.sha256,
        ).hexdigest()

    async def web_refresh(self, secret, expected):
        async with self.transaction() as conn:
            row = (
                (
                    await conn.execute(
                        select(sessions)
                        .where(sessions.c.credential_hash == digest(secret))
                        .with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            row = await self.checked(conn, row, client=WEB_CLIENT)
            if row["transport"] != "web" or row["id"] != expected:
                raise SessionError("session_changed")
            row.update(
                generation=row["generation"] + 1,
                idle_expires_at=self.idle_deadline(
                    self.now(), row["absolute_expires_at"]
                ),
            )
            await conn.execute(
                update(sessions)
                .where(sessions.c.id == row["id"])
                .values(
                    generation=row["generation"], idle_expires_at=row["idle_expires_at"]
                )
            )
            return self.bundle(row)

    async def revoke(self, session_id, user_id):
        async with self.transaction() as conn:
            await conn.execute(
                update(sessions)
                .where(sessions.c.id == session_id, sessions.c.user_id == user_id)
                .values(revoked_at=self.now())
            )

    async def revoke_with_refresh(self, secret, client, expected):
        async with self.transaction() as conn:
            old = (
                await conn.execute(
                    select(history.c.session_id).where(
                        history.c.credential_hash == digest(secret)
                    )
                )
            ).first()
            condition = (
                sessions.c.id == old.session_id
                if old
                else sessions.c.credential_hash == digest(secret)
            )
            row = (
                (
                    await conn.execute(
                        select(sessions).where(condition).with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if row is None and old is None:
                old = (
                    await conn.execute(
                        select(history.c.session_id).where(
                            history.c.credential_hash == digest(secret)
                        )
                    )
                ).first()
                if old:
                    row = (
                        (
                            await conn.execute(
                                select(sessions)
                                .where(sessions.c.id == old.session_id)
                                .with_for_update()
                            )
                        )
                        .mappings()
                        .first()
                    )
            # Already revoked/expired secrets may still revoke this same family;
            # logout must work during a concurrent rotation or access expiry.
            if not row or row["client_id"] != client or row["id"] != expected:
                raise SessionError()
            await conn.execute(
                update(sessions)
                .where(sessions.c.id == row["id"])
                .values(revoked_at=self.now())
            )

    async def check_connection(self, user_id, session_id=None, legacy_hash=None):
        async with self.store.engine.connect() as conn:
            if session_id or legacy_hash:
                blocked = (
                    await conn.execute(
                        select(upgrades.c.session_id)
                        .join(sessions, sessions.c.id == upgrades.c.session_id)
                        .where(
                            or_(
                                upgrades.c.source_sid == session_id
                                if session_id
                                else False,
                                upgrades.c.legacy_hash == legacy_hash
                                if legacy_hash
                                else False,
                            ),
                            sessions.c.revoked_at.is_not(None),
                        )
                    )
                ).first()
                if blocked:
                    raise SessionError()
            if session_id:
                row = (
                    (
                        await conn.execute(
                            select(sessions).where(sessions.c.id == session_id)
                        )
                    )
                    .mappings()
                    .first()
                )
                row = await self.checked(conn, row)
                if row["user_id"] != user_id:
                    raise SessionError()
            else:
                user = (
                    await conn.execute(
                        select(users.c.disabled, users.c.legacy_auth_revoked).where(
                            users.c.id == user_id
                        )
                    )
                ).first()
                if not user or user.disabled or user.legacy_auth_revoked:
                    raise SessionError()

    async def upgrade(self, token, client, attempt, *, transport):
        configured = os.environ.get("AGENT_SERVER_LEGACY_UPGRADE_UNTIL")
        if configured is None:
            async with self.store.engine.connect() as conn:
                cutoff = (
                    await conn.execute(
                        select(instance_settings.c.value).where(
                            instance_settings.c.key == "auth_legacy_upgrade_until"
                        )
                    )
                ).scalar_one_or_none()
        else:
            cutoff = configured
        cutoff = int(cutoff or 0)
        if (
            cutoff == 0
            or self.now() >= cutoff
            or not attempt
            or len(attempt) > 128
            or client not in NATIVE_CLIENTS | {WEB_CLIENT}
        ):
            raise SessionError("upgrade_unavailable")
        claims = await self.verify_access(token)
        if claims.get("sid"):
            # Access-only sessions created by the new server are still eligible;
            # never grant upgrade from an already-renewable session.
            async with self.store.engine.connect() as conn:
                row = (
                    await conn.execute(
                        select(sessions.c.transport).where(
                            sessions.c.id == claims["sid"]
                        )
                    )
                ).first()
                if not row or row.transport != "legacy":
                    raise SessionError("upgrade_unavailable")
        key = digest(digest(token) + ":" + client + ":" + attempt)
        async with self.transaction() as conn:
            await conn.execute(
                select(users.c.id).where(users.c.id == claims["sub"]).with_for_update()
            )
            claims = await self.verify_access_in(conn, token, lock=True)
            old = (
                (
                    await conn.execute(
                        select(upgrades).where(upgrades.c.key == key).with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if old:
                row = (
                    (
                        await conn.execute(
                            select(sessions).where(sessions.c.id == old["session_id"])
                        )
                    )
                    .mappings()
                    .first()
                )
                await self.checked(conn, row, client=client)
                if self.now() >= old["recover_until"] or row["generation"] != 1:
                    raise SessionError("upgrade_unavailable")
                return json.loads(
                    recovery_cipher().decrypt(old["response_encrypted"].encode())
                )
            result, secret = await self.create_in(
                conn, claims["sub"], client, transport=transport
            )
            saved = {
                "credentials": result,
                "cookieSecret": secret if transport == "web" else None,
            }
            await conn.execute(
                insert(upgrades).values(
                    key=key,
                    legacy_hash=digest(token),
                    source_sid=claims.get("sid"),
                    session_id=result["sessionId"],
                    recover_until=self.now()
                    + setting("AGENT_SERVER_REFRESH_RECOVERY_SECONDS", 120),
                    response_encrypted=recovery_cipher()
                    .encrypt(json.dumps(saved).encode())
                    .decode(),
                )
            )
            return saved

    async def cleanup(self):
        async with self.transaction() as conn:
            await conn.execute(
                update(history)
                .where(
                    history.c.recover_until <= self.now(),
                    history.c.response_encrypted != "",
                )
                .values(response_encrypted="")
            )
            await conn.execute(
                update(upgrades)
                .where(
                    upgrades.c.recover_until <= self.now(),
                    upgrades.c.response_encrypted != "",
                )
                .values(response_encrypted="")
            )
            await conn.execute(
                delete(sessions).where(
                    or_(
                        sessions.c.idle_expires_at <= self.now(),
                        sessions.c.absolute_expires_at <= self.now(),
                    )
                )
            )
