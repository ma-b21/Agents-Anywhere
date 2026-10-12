package com.agentsanywhere.app.feature.auth

import org.junit.Test

class NativeAuthCoordinatorTest {
    @Test fun renewableSessionStateMachine() = NativeAuthCoordinatorChecks.runAll()
}
