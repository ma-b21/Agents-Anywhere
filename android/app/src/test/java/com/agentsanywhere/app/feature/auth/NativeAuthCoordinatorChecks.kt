package com.agentsanywhere.app.feature.auth

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Also runnable without Android SDK: compile this file with NativeAuthCoordinator.kt. */
object NativeAuthCoordinatorChecks {
    private class Unauthorized : Exception()
    private class Store : NativeAuthStorage {
        var failRead = false
        @Volatile var value: NativeAuthSnapshot? = NativeAuthSnapshot("https://self.test", "a0", "user", "user", refreshToken = "r0", sessionId = "sid")
        var failWrite = false
        val writes = mutableListOf<NativeAuthSnapshot>()
        @Synchronized override fun readSnapshot(): NativeAuthSnapshot? { if (failRead) throw IOException("Keystore unavailable"); return value }
        @Synchronized override fun replace(expected: NativeAuthSnapshot, replacement: NativeAuthSnapshot): Boolean {
            if (value != expected) return false
            if (failWrite) throw IOException("disk unavailable")
            writes.add(replacement); value = replacement; return true
        }
        @Synchronized override fun clear(expected: NativeAuthSnapshot): Boolean {
            if (value?.loginGeneration != expected.loginGeneration) return false
            value = null; return true
        }
    }
    private class Fixture {
        val store = Store()
        var now = 1000L
        val calls = AtomicInteger()
        val attempts = mutableListOf<String>()
        val revoked = AtomicInteger()
        val loggedOut = CountDownLatch(1)
        var onRefresh: (NativeAuthSnapshot, String) -> RenewableCredentials = { snap, _ -> credentials(snap) }
        var onUpgrade: (NativeAuthSnapshot, String) -> RenewableCredentials? = { _, _ -> null }
        val auth = NativeAuthCoordinator(store, object : NativeAuthTransport {
            override fun refresh(snapshot: NativeAuthSnapshot, attempt: String): RenewableCredentials {
                calls.incrementAndGet(); synchronized(attempts) { attempts.add(attempt) }
                check(store.value?.pendingRefresh == attempt)
                return onRefresh(snapshot, attempt)
            }
            override fun upgrade(snapshot: NativeAuthSnapshot, attempt: String) = onUpgrade(snapshot, attempt)
            override fun logout(snapshot: NativeAuthSnapshot) { check(store.value == null); loggedOut.countDown() }
        }, { it is Unauthorized }, { revoked.incrementAndGet() }, { now })
        fun token(rejected: Boolean = false) = auth.accessToken("https://self.test", "a0", "a0".takeIf { rejected })
        fun credentials(snap: NativeAuthSnapshot, ttl: Long = 900) = RenewableCredentials("a" + (snap.credentialVersion + 1), "r" + (snap.credentialVersion + 1), "sid", "user", ttl, snap.credentialVersion + 1)
    }
    private fun fails(action: () -> Unit): Throwable = try { action(); error("Expected failure") } catch (e: Exception) { e }
    @JvmStatic fun main(args: Array<String>) { runAll() }
    fun runAll() {
        var passed = 0
        fun test(name: String, block: () -> Unit) { block(); passed++; println("PASS " + name) }
        test("20 callers share one durable refresh") {
            val f = Fixture(); val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.onRefresh = { s, _ -> entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); f.credentials(s) }
            val pool = Executors.newFixedThreadPool(20)
            try {
                val gate = CountDownLatch(1)
                val work = (1..20).map { pool.submit<String> { gate.await(); f.token() } }
                gate.countDown(); check(entered.await(5, TimeUnit.SECONDS)); release.countDown()
                check(work.all { it.get(5, TimeUnit.SECONDS) == "a1" }); check(f.calls.get() == 1)
                check(f.store.value!!.refreshToken == "r1" && f.store.value!!.pendingRefresh == null)
            } finally { pool.shutdownNow() }
        }
        test("late old401 uses already renewed credentials") { val f=Fixture(); f.token(); check(f.token(true)=="a1"); check(f.calls.get()==1) }
        test("authentication replay only once") {
            val f=Fixture(); f.store.value=f.store.value!!.copy(refreshAtMs=999999); var n=0
            check(f.auth.execute("https://self.test", "a0") { token -> n++; if(token=="a0")throw Unauthorized(); token }=="a1")
            check(n==2 && f.calls.get()==1)
        }
        test("business network failure is not replayed") {
            val f=Fixture(); f.store.value=f.store.value!!.copy(refreshAtMs=999999); var n=0
            check(fails { f.auth.execute("https://self.test", "a0") { n++; throw IOException() } } is IOException)
            check(n==1 && f.revoked.get()==0)
        }
        test("temporary failure preserves stable attempt") {
            val f=Fixture(); f.onRefresh={_,_->throw IOException()}; fails { f.token() }
            val pending=f.store.value!!.pendingRefresh; check(pending!=null && f.revoked.get()==0)
            f.onRefresh={s,_->f.credentials(s)}; f.token(); check(f.attempts==listOf(pending,pending))
        }
        test("restart resumes persisted attempt") {
            val f=Fixture(); f.store.value=f.store.value!!.copy(pendingRefresh="persisted")
            f.token(); check(f.attempts==listOf("persisted"))
        }
        test("persistence failure never sends refresh") {
            val f=Fixture(); f.store.failWrite=true; check(fails { f.token() } is IOException); check(f.calls.get()==0 && f.revoked.get()==0)
        }
        test("response commit failure preserves attempt") {
            val f=Fixture(); f.onRefresh={s,_->f.store.failWrite=true; f.credentials(s)}; fails { f.token() }
            check(f.store.value!!.pendingRefresh!=null && f.store.value!!.refreshToken=="r0" && f.revoked.get()==0)
        }
        test("account switch fences refresh and business replay") {
            val f=Fixture(); f.onRefresh={s,_->f.store.value=s.copy(loginGeneration="new",accessToken="new-account"); f.credentials(s)}
            check(fails { f.token() } is LoginContextChanged); check(f.store.value!!.accessToken=="new-account" && f.revoked.get()==0)
        }
        test("different server never receives refreshed account token") {
            val f=Fixture(); check(fails { f.auth.execute("https://other.test", "a0") { error("Must not send") } } is LoginContextChanged); check(f.calls.get()==0)
            check(fails { f.auth.accessToken("https://other.test", "a0") } is LoginContextChanged)
        }
        test("definite expiry notifies once") {
            val f=Fixture(); f.onRefresh={_,_->throw SessionAuthDenied()}; fails { f.token() }; fails { f.token() }; check(f.revoked.get()==1)
        }
        test("second unauthorized stops instead of loops") {
            val f=Fixture(); f.store.value=f.store.value!!.copy(refreshAtMs=999999); var n=0
            fails { f.auth.execute("https://self.test", "a0") { n++; throw Unauthorized() } }; check(n==2 && f.revoked.get()==1)
        }
        test("legacy unavailable preserves login with cooldown") {
            val f=Fixture(); f.store.value=f.store.value!!.copy(refreshToken=null,sessionId=null); var n=0
            f.onUpgrade={_,_->n++; null}; check(f.token()=="a0"); check(f.token()=="a0" && n==1 && f.revoked.get()==0)
        }
        test("legacy upgrade saves full pair") {
            val f=Fixture(); f.store.value=f.store.value!!.copy(refreshToken=null,sessionId=null)
            f.onUpgrade={s,_->f.credentials(s)}; check(f.token()=="a1" && f.store.value!!.sessionId=="sid")
        }
        test("zero-TTL recovered token renews on next use") {
            val f=Fixture(); f.onRefresh={s,_->f.credentials(s,if(f.calls.get()==1)0 else 900)}
            check(f.token()=="a1"); check(f.token()=="a2" && f.calls.get()==2)
        }
        test("cancelled waiter does not cancel shared operation") {
            val f=Fixture(); val entered=CountDownLatch(1); val release=CountDownLatch(1)
            f.onRefresh={s,_->entered.countDown(); check(release.await(5,TimeUnit.SECONDS)); f.credentials(s)}
            val waiting=Thread { fails { f.token() } }; waiting.start(); check(entered.await(5,TimeUnit.SECONDS)); waiting.interrupt(); waiting.join(1000)
            release.countDown(); check(f.token()=="a1" && f.calls.get()==1)
        }
        test("non-first terminal token remains usable after 65 rotations") {
            val f=Fixture(); val opened=f.token()
            repeat(65) { f.store.value=f.store.value!!.copy(refreshAtMs=0); f.auth.accessToken("https://self.test", f.store.value!!.accessToken) }
            check(f.auth.accessToken("https://self.test",opened)=="a66")
        }
        test("memory-before-disk failure blocks until durable retry") {
            val barrier=DurableWriteBarrier(); var memory="old"; var disk="old"; var fail=true; var calls=0
            fails { barrier.persist { calls++; memory="pending"; if(!fail)disk=memory; !fail } }
            check(memory=="pending" && disk=="old"); fails { barrier.ensureDurable() }; check(disk=="old")
            fail=false; barrier.ensureDurable(); check(disk=="pending" && calls==3)
            fail=true; fails { barrier.persist { memory="rotated"; if(!fail)disk=memory; !fail } }
            check(disk=="pending"); fail=false; barrier.ensureDurable(); check(disk=="rotated")
        }
        test("revocation read failure completes shared future") {
            val f=Fixture(); f.onRefresh={_,_->f.store.failRead=true; throw SessionAuthDenied()}
            val pool=Executors.newSingleThreadExecutor()
            try { check(pool.submit<Throwable> { fails { f.token() } }.get(5,TimeUnit.SECONDS) is SessionAuthDenied) } finally {pool.shutdownNow()}
        }
        test("notification exception cannot strand waiter") {
            val f=Fixture(); val coordinator=NativeAuthCoordinator(f.store,object: NativeAuthTransport {
                override fun refresh(s:NativeAuthSnapshot,a:String):RenewableCredentials=throw SessionAuthDenied()
                override fun upgrade(s:NativeAuthSnapshot,a:String):RenewableCredentials?=null
                override fun logout(s:NativeAuthSnapshot) {}
            },{false},{throw IllegalStateException("UI gone")})
            check(fails {coordinator.accessToken("https://self.test","a0")} is SessionAuthDenied)
        }
        test("logout clears before network and rejects stale completion") {
            val f=Fixture(); f.auth.signOut(); check(f.store.value==null); check(f.loggedOut.await(5,TimeUnit.SECONDS))
        }
        test("late second unauthorized preserves a newer concurrent token") {
            val f = Fixture(); f.store.value = f.store.value!!.copy(refreshAtMs = 999999)
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val pool = Executors.newSingleThreadExecutor(); val sends = AtomicInteger()
            try {
                val pending = pool.submit<Throwable> {
                    fails { f.auth.execute("https://self.test", "a0") { token ->
                        if (sends.incrementAndGet() == 1) throw Unauthorized()
                        check(token == "a1"); entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); throw Unauthorized()
                    } }
                }
                check(entered.await(5, TimeUnit.SECONDS)); check(f.auth.accessToken("https://self.test", "a1", "a1") == "a2")
                release.countDown(); check(pending.get(5, TimeUnit.SECONDS) is Unauthorized)
                check(sends.get() == 2 && f.store.value!!.accessToken == "a2" && f.revoked.get() == 0)
            } finally { release.countDown(); pool.shutdownNow() }
        }
        println("Native auth checks: " + passed + " passed")
    }
}
