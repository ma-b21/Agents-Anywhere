package com.agentsanywhere.app.feature.auth

interface AuthSessionReader {
    fun readServerUrl(): String
    fun readAccessToken(): String
    /** Origin, user and credentials must be captured as one confirmed snapshot. */
    fun readSnapshot(): NativeAuthSnapshot?
}
