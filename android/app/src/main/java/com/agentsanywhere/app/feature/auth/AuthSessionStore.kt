package com.agentsanywhere.app.feature.auth

import android.content.Context
import com.agentsanywhere.app.api.AuthResponse
import com.agentsanywhere.app.api.MobileLoginExchangeResponse
import com.agentsanywhere.app.api.normalizeServerOrigin
import org.json.JSONObject

class AuthSessionStore(context: Context) : AuthSessionReader, NativeAuthStorage {
    private val preferences = context.applicationContext.getSharedPreferences("agents_anywhere_auth", Context.MODE_PRIVATE)
    private val cipher = AndroidCredentialCipher()

    override fun readServerUrl(): String = synchronized(STATE_LOCK) {
        // Non-secret UI metadata only. Authenticated traffic must readSnapshot().
        normalizeServerOrigin(preferences.getString(KEY_SERVER_URL, "").orEmpty()).orEmpty()
    }
    override fun readAccessToken(): String = runCatching { readSnapshot()?.accessToken }.getOrNull().orEmpty()
    fun readUserId(): String = preferences.getString(KEY_USER_ID, "").orEmpty()
    fun readRole(): String = preferences.getString(KEY_ROLE, "").orEmpty()
    // Presence is not authentication. Keep the existing screen during a temporary
    // Keystore/disk failure; IO request paths return a recoverable Result error.
    fun hasAuthSession(): Boolean = readServerUrl().isNotBlank() &&
        (preferences.contains(KEY_SNAPSHOT) || !preferences.getString(KEY_ACCESS_TOKEN, "").isNullOrBlank())

    fun beginLogin(serverUrl: String): Long = synchronized(STATE_LOCK) {
        saveServerUrl(serverUrl)
        ++loginEpoch
    }
    fun requireLoginEpoch(expected: Long) = synchronized(STATE_LOCK) {
        if (loginEpoch != expected) throw LoginContextChanged()
    }

    fun saveServerUrl(serverUrl: String) = synchronized(STATE_LOCK) {
        val normalized = serverUrl.asServerOrigin()
        if (normalized != readServerUrl()) {
            loginEpoch++
            // Never combine an old server's credential with a newly selected host.
            DURABILITY.persist { preferences.edit().clear().putString(KEY_SERVER_URL, normalized).commit() }
        }
    }

    fun saveAuthSession(serverUrl: String, auth: AuthResponse, expectedEpoch: Long? = null) = synchronized(STATE_LOCK) {
        expectedEpoch?.let(::requireLoginEpoch)
        loginEpoch++
        val initial = NativeAuthSnapshot(serverUrl.asServerOrigin(), auth.accessToken, auth.userId, auth.role)
        writeSnapshot(auth.renewal?.let { initial.renewed(it, System.currentTimeMillis()) } ?: initial)
    }

    fun saveMobileAuthSession(serverUrl: String, exchange: MobileLoginExchangeResponse, expectedEpoch: Long? = null) = synchronized(STATE_LOCK) {
        expectedEpoch?.let(::requireLoginEpoch)
        loginEpoch++
        val initial = NativeAuthSnapshot(serverUrl.asServerOrigin(), exchange.auth.accessToken, exchange.auth.userId, exchange.auth.role)
        val snapshot = exchange.auth.renewal?.let { initial.renewed(it, System.currentTimeMillis()) }
            ?: initial.copy(refreshToken = exchange.refreshToken.takeIf { it.startsWith("aar_") })
        writeSnapshot(snapshot)
    }

    override fun readSnapshot(): NativeAuthSnapshot? = synchronized(STATE_LOCK) {
        DURABILITY.ensureDurable()
        val encrypted = preferences.getString(KEY_SNAPSHOT, null)
        if (encrypted != null) return@synchronized decodeSnapshot(JSONObject(cipher.decrypt(encrypted)))
        val server = readServerUrl()
        val access = preferences.getString(KEY_ACCESS_TOKEN, "").orEmpty()
        if (server.isBlank() || access.isBlank()) return@synchronized null
        val legacy = NativeAuthSnapshot(
            server, access, readUserId(), readRole(),
            refreshToken = preferences.getString(KEY_REFRESH_TOKEN, null)?.takeIf { it.startsWith("aar_") },
        )
        // Migration is durable and removes all plaintext secrets in the same edit.
        writeSnapshot(legacy)
        legacy
    }

    override fun replace(expected: NativeAuthSnapshot, replacement: NativeAuthSnapshot): Boolean = synchronized(STATE_LOCK) {
        if (readSnapshot() != expected) return@synchronized false
        require(replacement.loginGeneration == expected.loginGeneration && replacement.serverUrl == expected.serverUrl)
        writeSnapshot(replacement)
        true
    }

    override fun clear(expected: NativeAuthSnapshot): Boolean = synchronized(STATE_LOCK) {
        if (readSnapshot()?.loginGeneration != expected.loginGeneration) return@synchronized false
        clearAuthSessionKeepingServerUrl()
        true
    }

    fun clearAuthSession() = synchronized(STATE_LOCK) { clearAuthSessionKeepingServerUrl() }

    fun clearAuthSessionIfTokenMatches(accessToken: String): Boolean = synchronized(STATE_LOCK) {
        if (!shouldClearAuthSession(readAccessToken(), accessToken)) return@synchronized false
        clearAuthSessionKeepingServerUrl()
        true
    }

    private fun clearAuthSessionKeepingServerUrl() {
        loginEpoch++
        val serverUrl = readServerUrl()
        DURABILITY.persist { preferences.edit().clear().putString(KEY_SERVER_URL, serverUrl).commit() }
    }

    private fun writeSnapshot(snapshot: NativeAuthSnapshot) {
        val value = JSONObject().put("serverUrl", snapshot.serverUrl).put("accessToken", snapshot.accessToken)
            .put("userId", snapshot.userId).put("role", snapshot.role).put("loginGeneration", snapshot.loginGeneration)
            .put("refreshToken", snapshot.refreshToken).put("sessionId", snapshot.sessionId)
            .put("credentialVersion", snapshot.credentialVersion).put("refreshAtMs", snapshot.refreshAtMs)
            .put("pendingRefresh", snapshot.pendingRefresh).put("pendingUpgrade", snapshot.pendingUpgrade)
            .put("refreshExpiresAt", snapshot.refreshExpiresAt).put("absoluteExpiresAt", snapshot.absoluteExpiresAt)
        val encrypted = cipher.encrypt(value.toString())
        DURABILITY.persist {
            preferences.edit().clear().putString(KEY_SNAPSHOT, encrypted)
                .putString(KEY_SERVER_URL, snapshot.serverUrl).putString(KEY_USER_ID, snapshot.userId)
                .putString(KEY_ROLE, snapshot.role).commit()
        }
    }

    private fun decodeSnapshot(value: JSONObject): NativeAuthSnapshot {
        fun nullable(key: String): String? = if (value.isNull(key)) null else value.optString(key).takeIf(String::isNotBlank)
        return NativeAuthSnapshot(
            serverUrl = value.getString("serverUrl"), accessToken = value.getString("accessToken"),
            userId = value.getString("userId"), role = value.getString("role"), loginGeneration = value.getString("loginGeneration"),
            refreshToken = nullable("refreshToken"), sessionId = nullable("sessionId"),
            credentialVersion = value.optLong("credentialVersion"), refreshAtMs = value.optLong("refreshAtMs"),
            pendingRefresh = nullable("pendingRefresh"), pendingUpgrade = nullable("pendingUpgrade"),
            refreshExpiresAt = nullable("refreshExpiresAt"), absoluteExpiresAt = nullable("absoluteExpiresAt"),
        )
    }

    private fun String.asServerOrigin(): String = requireNotNull(normalizeServerOrigin(this)) { "Server URL must be an HTTP(S) origin." }

    companion object {
        private val DURABILITY = DurableWriteBarrier()
        private var loginEpoch = 0L
        private val STATE_LOCK = Any() // Shared by login view models and the app.
        private const val KEY_SNAPSHOT = "encrypted_auth_snapshot_v2"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_ROLE = "role"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
    }
}

internal fun shouldClearAuthSession(currentAccessToken: String, unauthorizedAccessToken: String): Boolean =
    unauthorizedAccessToken.isNotBlank() && currentAccessToken == unauthorizedAccessToken
