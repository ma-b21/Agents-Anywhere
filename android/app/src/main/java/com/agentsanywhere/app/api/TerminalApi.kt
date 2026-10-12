package com.agentsanywhere.app.api

import org.json.JSONObject

class TerminalApi(
    private val client: ApiClient = ApiClient(),
) {
    fun createTerminal(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        root: String,
        cols: Int,
        rows: Int,
        cwd: String = ".",
        ephemeralGroupId: String,
        label: String = "Agents Anywhere",
    ): RemoteTerminal {
        val body = JSONObject().apply {
            put("cols", cols)
            put("rows", rows)
            put("cwd", cwd)
            put("ephemeralGroupId", ephemeralGroupId)
            put("label", label)
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/terminals-v2?root=${root.urlEncode()}",
            body = body,
            authorizationToken = authorizationToken,
        ).getJSONObject("result").toRemoteTerminal()
    }

    fun listTerminals(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
    ): List<RemoteTerminal> {
        val terminals = client.getJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/terminals-v2",
            authorizationToken = authorizationToken,
        ).getJSONObject("result").optJSONArray("terminals") ?: return emptyList()
        return buildList {
            for (index in 0 until terminals.length()) {
                val terminal = terminals.optJSONObject(index) ?: continue
                add(terminal.toRemoteTerminal())
            }
        }
    }

    fun closeTerminal(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        terminalId: String,
    ) {
        client.deleteJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/terminals-v2/${terminalId.urlEncode()}",
            authorizationToken = authorizationToken,
        )
    }

    fun streamUrl(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        terminalId: String,
        fromSeq: Long = 0,
    ): String {
        return webSocketApiUrl(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/terminals-v2/${terminalId.urlEncode()}/stream" +
                "?fromSeq=$fromSeq&token=${client.authorizationToken(serverUrl, authorizationToken).urlEncode()}",
        )
    }

    fun refreshStreamUrl(url: String, rejected: Boolean): String {
        val parsed = java.net.URI(url)
        val origin = java.net.URI(if (parsed.scheme == "wss") "https" else "http", null, parsed.host, parsed.port, null, null, null).toString()
        val query = parsed.rawQuery.orEmpty().split("&")
        val oldToken = query.firstOrNull { it.startsWith("token=") }?.substringAfter("=")
            ?.let { java.net.URLDecoder.decode(it, "UTF-8") } ?: error("Missing terminal authentication.")
        val token = client.terminalToken(origin, oldToken, rejected)
        val nextQuery = query.joinToString("&") { if (it.startsWith("token=")) "token=${token.urlEncode()}" else it }
        return "${url.substringBefore('?')}?$nextQuery"
    }

    fun rejectStreamUrl(url: String) {
        val parsed = java.net.URI(url)
        val origin = java.net.URI(if (parsed.scheme == "wss") "https" else "http", null, parsed.host, parsed.port, null, null, null).toString()
        val token = parsed.rawQuery.orEmpty().split("&").firstOrNull { it.startsWith("token=") }?.substringAfter("=") ?: return
        client.rejectTerminalToken(origin, java.net.URLDecoder.decode(token, "UTF-8"))
    }

    internal fun notifyUnauthorized(authorizationToken: String) {
        client.notifyUnauthorized(statusCode = 401, authorizationToken = authorizationToken)
    }

    private fun JSONObject.toRemoteTerminal(): RemoteTerminal {
        return RemoteTerminal(
            terminalId = getString("terminalId"),
            sessionId = optString("sessionId", ""),
            label = optString("label", "zsh").ifBlank { "zsh" },
            cwd = optString("cwd", ""),
            cols = optInt("cols", 80),
            rows = optInt("rows", 24),
            purpose = optString("purpose", "user"),
            pid = if (has("pid") && !isNull("pid")) optInt("pid") else null,
            status = optString("status", "starting"),
            exitCode = if (has("exitCode") && !isNull("exitCode")) optInt("exitCode") else null,
            scrollbackBytes = optLong("scrollbackBytes", 0L),
            scrollbackSeq = optInt("scrollbackSeq", 0),
        )
    }

}
