package com.agentsanywhere.app.feature.auth

/** Some stores update their memory before confirming disk. Never expose that
 * memory as durable state until the exact failed transaction has been retried. */
class DurableWriteBarrier {
    private var pending: (() -> Boolean)? = null
    @Synchronized fun persist(write: () -> Boolean) {
        ensureDurable()
        pending = write
        ensureDurable()
    }
    @Synchronized fun ensureDurable() {
        val write = pending ?: return
        check(write()) { "Could not durably persist login credentials." }
        pending = null
    }
}
