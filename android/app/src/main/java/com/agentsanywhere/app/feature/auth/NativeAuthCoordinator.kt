package com.agentsanywhere.app.feature.auth

import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/** No Android/network dependencies: independently testable credential state machine. */
data class RenewableCredentials(
    val accessToken: String,
    val refreshToken: String,
    val sessionId: String,
    val userId: String,
    val expiresIn: Long,
    val credentialVersion: Long,
    val refreshExpiresAt: String? = null,
    val absoluteExpiresAt: String? = null,
)

data class NativeAuthSnapshot(
    val serverUrl: String,
    val accessToken: String,
    val userId: String,
    val role: String,
    val loginGeneration: String = UUID.randomUUID().toString(),
    val refreshToken: String? = null,
    val sessionId: String? = null,
    val credentialVersion: Long = 0,
    val refreshAtMs: Long = 0,
    val pendingRefresh: String? = null,
    val pendingUpgrade: String? = null,
    val refreshExpiresAt: String? = null,
    val absoluteExpiresAt: String? = null,
) {
    fun renewed(value: RenewableCredentials, now: Long): NativeAuthSnapshot {
        require(value.userId == userId && (sessionId == null || value.sessionId == sessionId)) {
            "Refresh returned a different login session."
        }
        require(value.credentialVersion >= credentialVersion && value.refreshToken.isNotBlank())
        val duration = value.expiresIn.coerceAtLeast(0) * 1000
        return copy(
            accessToken = value.accessToken, refreshToken = value.refreshToken,
            sessionId = value.sessionId, credentialVersion = value.credentialVersion,
            refreshAtMs = now + duration - minOf(60_000L, duration / 10),
            pendingRefresh = null, pendingUpgrade = null,
            refreshExpiresAt = value.refreshExpiresAt, absoluteExpiresAt = value.absoluteExpiresAt,
        )
    }
}

interface NativeAuthStorage {
    fun readSnapshot(): NativeAuthSnapshot?
    /** Durable whole-snapshot CAS, including the pending attempt. */
    fun replace(expected: NativeAuthSnapshot, replacement: NativeAuthSnapshot): Boolean
    fun clear(expected: NativeAuthSnapshot): Boolean
}

interface NativeAuthTransport {
    fun refresh(snapshot: NativeAuthSnapshot, attempt: String): RenewableCredentials
    /** Null means old server/upgrade window unavailable, not authentication revoked. */
    fun upgrade(snapshot: NativeAuthSnapshot, attempt: String): RenewableCredentials?
    fun logout(snapshot: NativeAuthSnapshot)
}

class SessionAuthDenied(val superseded: Boolean = false) : Exception("This login has expired or been revoked.")
class LoginContextChanged : Exception("The login or server changed during the request.")

class NativeAuthCoordinator(
    private val storage: NativeAuthStorage,
    private val transport: NativeAuthTransport,
    private val isUnauthorized: (Throwable) -> Boolean,
    private val onRevoked: (String) -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
    private val executor: Executor = WORKERS,
) {
    private val lock = Any()
    private var flight: Pair<String, CompletableFuture<NativeAuthSnapshot>>? = null
    private var generation: String? = null
    // Keep only fingerprints, for this login lifetime: long-lived closures remain
    // recognizable without retaining old bearer secrets or a 64-refresh cutoff.
    private val issuedTokens = HashSet<String>()
    private fun fingerprint(token: String) = java.security.MessageDigest.getInstance("SHA-256")
        .digest(token.toByteArray()).joinToString("") { "%02x".format(it) }
    private var revokedGeneration: String? = null
    private var upgradeUnavailableUntil = 0L

    private fun current(): NativeAuthSnapshot? = storage.readSnapshot().also { snapshot ->
        if (snapshot?.loginGeneration != generation) {
            generation = snapshot?.loginGeneration
            issuedTokens.clear()
            revokedGeneration = null
            upgradeUnavailableUntil = 0
        }
        snapshot?.let {
            issuedTokens.add(fingerprint(it.accessToken))
        }
    }

    private fun context(serverUrl: String, supplied: String): NativeAuthSnapshot = synchronized(lock) {
        val snapshot = current() ?: throw LoginContextChanged()
        if (snapshot.serverUrl != serverUrl || fingerprint(supplied) !in issuedTokens) throw LoginContextChanged()
        if (revokedGeneration == snapshot.loginGeneration) throw SessionAuthDenied()
        snapshot
    }

    fun accessToken(serverUrl: String, supplied: String, rejectedToken: String? = null): String {
        val captured = context(serverUrl, supplied)
        return ensure(captured, rejectedToken).accessToken
    }

    fun <T> execute(serverUrl: String, supplied: String, action: (String) -> T): T {
        val captured = context(serverUrl, supplied)
        val prepared = ensure(captured, null)
        try {
            return action(prepared.accessToken)
        } catch (error: Exception) {
            if (!isUnauthorized(error)) throw error
        }
        // Only a definite authentication rejection is replayed, exactly once.
        val renewed = ensure(captured, prepared.accessToken)
        try {
            return action(renewed.accessToken)
        } catch (error: Exception) {
            if (isUnauthorized(error)) revoke(captured.loginGeneration, renewed)
            throw error
        }
    }

    private fun ensure(captured: NativeAuthSnapshot, rejectedToken: String?): NativeAuthSnapshot {
        val future = synchronized(lock) {
            val latest = current() ?: throw LoginContextChanged()
            if (latest.loginGeneration != captured.loginGeneration) throw LoginContextChanged()
            if (revokedGeneration == latest.loginGeneration) throw SessionAuthDenied()
            val mustRefresh = latest.pendingRefresh != null || latest.pendingUpgrade != null ||
                (rejectedToken != null && latest.accessToken == rejectedToken) ||
                (latest.refreshToken != null && clock() >= latest.refreshAtMs) ||
                (latest.refreshToken == null && clock() >= upgradeUnavailableUntil)
            if (!mustRefresh) return latest
            val existing = flight
            if (existing?.first == latest.loginGeneration && !existing.second.isDone) return@synchronized existing.second
            val pending = if (latest.refreshToken != null) {
                latest.copy(pendingRefresh = latest.pendingRefresh ?: UUID.randomUUID().toString())
            } else {
                latest.copy(pendingUpgrade = latest.pendingUpgrade ?: UUID.randomUUID().toString())
            }
            if (pending != latest && !storage.replace(latest, pending)) throw LoginContextChanged()
            val started = CompletableFuture<NativeAuthSnapshot>()
            flight = latest.loginGeneration to started
            executor.execute { runRefresh(pending, started) }
            started
        }
        val result = try {
            future.get()
        } catch (error: ExecutionException) {
            throw (error.cause ?: error)
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            throw error // Never cancel the shared refresh when one waiter leaves.
        }
        synchronized(lock) {
            if (current()?.loginGeneration != captured.loginGeneration) throw LoginContextChanged()
        }
        return result
    }

    private fun runRefresh(pending: NativeAuthSnapshot, result: CompletableFuture<NativeAuthSnapshot>) {
        try {
            val credentials = if (pending.refreshToken != null) {
                transport.refresh(pending, requireNotNull(pending.pendingRefresh))
            } else {
                transport.upgrade(pending, requireNotNull(pending.pendingUpgrade))
            }
            val updated = if (credentials == null) pending.copy(pendingUpgrade = null) else pending.renewed(credentials, clock())
            synchronized(lock) {
                val latest = current() ?: throw LoginContextChanged()
                if (latest.loginGeneration != pending.loginGeneration) throw LoginContextChanged()
                if (!storage.replace(pending, updated)) {
                    if (latest.credentialVersion <= pending.credentialVersion) throw LoginContextChanged()
                    result.complete(latest)
                } else {
                    issuedTokens.add(fingerprint(pending.accessToken))
                    issuedTokens.add(fingerprint(updated.accessToken))
                    if (credentials == null) upgradeUnavailableUntil = clock() + 30 * 60_000L
                    result.complete(updated)
                }
            }
        } catch (error: Exception) {
            try {
                if (error is SessionAuthDenied && error.superseded) {
                    val latest = synchronized(lock) { current() }
                    if (latest?.loginGeneration == pending.loginGeneration && latest.credentialVersion > pending.credentialVersion) {
                        result.complete(latest)
                    }
                }
                if (!result.isDone && error is SessionAuthDenied) revoke(pending.loginGeneration)
            } catch (notificationError: Exception) {
                error.addSuppressed(notificationError)
            } finally {
                // Even a broken Keystore/read or notification cannot strand waiters.
                if (!result.isDone) result.completeExceptionally(error)
            }
        } finally {
            synchronized(lock) {
                if (flight?.second === result) flight = null
            }
        }
    }

    fun rejectToken(serverUrl: String, supplied: String) {
        val snapshot = context(serverUrl, supplied)
        revoke(snapshot.loginGeneration)
    }

    private fun revoke(login: String, rejected: NativeAuthSnapshot? = null) {
        val token = synchronized(lock) {
            val latest = current()
            if (latest?.loginGeneration != login || revokedGeneration == login) return
            if (rejected != null && (latest.accessToken != rejected.accessToken || latest.credentialVersion > rejected.credentialVersion)) return
            revokedGeneration = login
            latest.accessToken
        }
        runCatching { onRevoked(token) } // Notification failure must never strand shared waiters.
    }

    fun signOut() {
        val snapshot = synchronized(lock) {
            val existing = current() ?: return
            if (!storage.clear(existing)) return
            existing
        }
        executor.execute { runCatching { transport.logout(snapshot) } }
    }

    companion object {
        private val WORKERS = Executors.newFixedThreadPool(2) { task ->
            Thread(task, "aa-auth-refresh").apply { isDaemon = true }
        }
    }
}
