package com.agentsanywhere.app.feature.sessiondetail

/** Match the server's send/steer states; never reinterpret a failed submission. */
internal fun sessionMessageAction(
    status: SessionRuntimeStatus,
    canSendMessage: Boolean,
    canSteer: Boolean,
    retryAction: RuntimeMessageAction? = null,
): RuntimeMessageAction? {
    val action = when (status) {
        SessionRuntimeStatus.Idle, SessionRuntimeStatus.Error ->
            RuntimeMessageAction.Send.takeIf { canSendMessage }
        SessionRuntimeStatus.Running -> RuntimeMessageAction.Steer.takeIf { canSteer }
        else -> null
    }
    return action?.takeIf { retryAction == null || it == retryAction }
}

internal fun sessionCommandsAllowed(status: SessionRuntimeStatus): Boolean =
    status == SessionRuntimeStatus.Idle || status == SessionRuntimeStatus.Error
