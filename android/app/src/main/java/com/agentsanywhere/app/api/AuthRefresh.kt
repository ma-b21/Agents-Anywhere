package com.agentsanywhere.app.api

import com.agentsanywhere.app.feature.auth.NativeAuthSnapshot
import com.agentsanywhere.app.feature.auth.NativeAuthTransport
import com.agentsanywhere.app.feature.auth.RenewableCredentials
import com.agentsanywhere.app.feature.auth.SessionAuthDenied
import org.json.JSONObject

internal fun JSONObject.toRenewableCredentials(snakeCase: Boolean = false): RenewableCredentials? {
    fun name(camel: String, snake: String) = if (snakeCase) snake else camel
    val refresh = optNullableString(name("refreshToken", "refresh_token")) ?: return null
    val sid = optNullableString(name("sessionId", "session_id")) ?: return null
    return RenewableCredentials(
        accessToken = getString(name("accessToken", "access_token")),
        refreshToken = refresh,
        sessionId = sid,
        userId = getString(name("userId", "user_id")),
        expiresIn = getLong(name("accessExpiresIn", "expires_in")),
        credentialVersion = getLong(name("credentialVersion", "credential_version")),
        refreshExpiresAt = optNullableString(name("refreshExpiresAt", "refresh_expires_at")),
        absoluteExpiresAt = optNullableString(name("absoluteExpiresAt", "absolute_expires_at")),
    )
}

/** Deliberately uses an unauthenticated client, never the business retry layer. */
class NativeAuthApiTransport(private val client: ApiClient = ApiClient()) : NativeAuthTransport {
    override fun refresh(snapshot: NativeAuthSnapshot, attempt: String): RenewableCredentials = try {
        requireNotNull(client.postForm(snapshot.serverUrl, "/oauth/token", linkedMapOf(
            "grant_type" to "refresh_token", "client_id" to "agents-anywhere-mobile",
            "refresh_token" to requireNotNull(snapshot.refreshToken), "refresh_attempt_id" to attempt,
        )).toRenewableCredentials(snakeCase = true)) { "Refresh response is incomplete." }
    } catch (error: ApiException) {
        if (error.statusCode == 400 && error.errorCode in setOf("reauth_required", "refresh_superseded")) throw SessionAuthDenied(superseded = error.errorCode == "refresh_superseded")
        throw error
    }

    override fun upgrade(snapshot: NativeAuthSnapshot, attempt: String): RenewableCredentials? = try {
        client.postJson(snapshot.serverUrl, "/auth/session/upgrade", JSONObject()
            .put("clientId", "agents-anywhere-mobile").put("upgradeAttemptId", attempt), snapshot.accessToken)
            .toRenewableCredentials()
    } catch (error: ApiException) {
        when {
            error.statusCode in setOf(404, 405) || error.errorCode == "upgrade_unavailable" -> null
            error.statusCode == 401 && error.errorCode != "upgrade_unavailable" -> throw SessionAuthDenied()
            else -> throw error
        }
    }

    override fun logout(snapshot: NativeAuthSnapshot) {
        val sid = snapshot.sessionId ?: return
        client.postJson(snapshot.serverUrl, "/auth/session/logout", JSONObject()
            .put("expectedSessionId", sid).put("clientId", "agents-anywhere-mobile")
            .apply { snapshot.refreshToken?.let { put("refreshToken", it) } },
            snapshot.accessToken.takeIf { snapshot.refreshToken == null })
    }
}
