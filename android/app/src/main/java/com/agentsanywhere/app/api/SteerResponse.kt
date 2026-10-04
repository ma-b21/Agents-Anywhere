package com.agentsanywhere.app.api

import org.json.JSONObject

/** The HTTP envelope can succeed while the Connector rejects the steer operation. */
internal fun JSONObject.requireSuccessfulSteerResult() {
    // Keep transport-level failures on the existing RemoteRpcResponse error path.
    if (!optBoolean("ok", false)) return
    val result = optJSONObject("result") ?: return
    val error = result.opt("error").takeUnless { it == JSONObject.NULL }
    val rejected = result.opt("ok") == false || result.opt("steered") == false || error != null
    if (!rejected) return

    val errorObject = error as? JSONObject
    val message = result.nonBlankString("message")
        ?: errorObject?.nonBlankString("message")
        ?: (error as? String)?.takeIf(String::isNotBlank)
        ?: result.nonBlankString("code")
        ?: errorObject?.nonBlankString("code")
        ?: "Runtime rejected the steer message."
    throw IllegalStateException(message)
}

private fun JSONObject.nonBlankString(key: String): String? =
    (opt(key) as? String)?.takeIf(String::isNotBlank)
