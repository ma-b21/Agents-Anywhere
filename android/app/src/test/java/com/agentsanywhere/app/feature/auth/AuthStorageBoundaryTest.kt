package com.agentsanywhere.app.feature.auth

import org.junit.Test

class AuthStorageBoundaryTest {
    @Test fun controllersReturnRecoverableStorageFailures() = AuthStorageBoundaryChecks.runAll()
}
