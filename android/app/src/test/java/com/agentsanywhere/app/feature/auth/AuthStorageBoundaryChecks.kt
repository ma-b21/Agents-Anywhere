package com.agentsanywhere.app.feature.auth

import com.agentsanywhere.app.api.*
import com.agentsanywhere.app.feature.sessions.*
import com.agentsanywhere.app.feature.sessiondetail.*
import com.agentsanywhere.app.feature.realtime.*
import kotlinx.coroutines.*
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

object AuthStorageBoundaryChecks {
    private class Unreadable : AuthSessionReader {
        val read = CountDownLatch(1)
        override fun readSnapshot(): NativeAuthSnapshot? { read.countDown(); throw IOException("secure store temporarily unavailable") }
        override fun readServerUrl()="https://self.test"
        override fun readAccessToken()="must not use separate reads"
    }
    @JvmStatic fun main(args:Array<String>) { runAll() }
    fun runAll() = runBlocking {
        var n=0
        suspend fun test(name:String,block:suspend ()->Unit) {block();n++;println("PASS "+name)}
        test("session list returns storage failure without crashing") {
            val reader=Unreadable(); val controller=SessionsController(SessionsApi(),DevicesApi(),FilesApi(),reader)
            check(controller.loadSessions().exceptionOrNull() is IOException)
            check(controller.loadProjects().isFailure)
        }
        test("create outcome uses its failure contract") {
            val controller=SessionsController(SessionsApi(),DevicesApi(),FilesApi(),Unreadable())
            val draft=NewSessionCreateDraft("c","codex",null,"/workspace","hello",NewSessionSelections(),emptyList(),"message",emptySet())
            val result=controller.createAndStartSession(draft,emptyList())
            check(result is NewSessionCreateOutcome.Failed && result.error is IOException)
        }
        test("new-session nullable helper returns failure without crash") {
            val controller=SessionsController(SessionsApi(),DevicesApi(),FilesApi(),Unreadable())
            check(controller.loadNewSessionRuntimeCapabilities("c","codex").isFailure)
        }
        test("image context and download survive storage failure") {
            val controller=SessionDetailController(SessionsApi(),Unreadable())
            check(controller.attachmentLoginContext().isEmpty())
            check(controller.downloadAttachment("s",TimelineAttachment("f","x.png","image/png",1)).exceptionOrNull() is IOException)
        }
        test("dashboard and session realtime keep retrying unreadable store") {
            val scope=CoroutineScope(SupervisorJob()+Dispatchers.Default)
            try {
                val dashReader=Unreadable()
                val dash=DashboardRealtimeController(RealtimeApi(),dashReader,"test").start(scope,onSnapshot={})
                check(dashReader.read.await(5,TimeUnit.SECONDS)); delay(20); check(dash.isActive)
                val sessionReader=Unreadable()
                val session=SessionRealtimeController(RealtimeApi(),sessionReader,"test").start(scope,"s",cursor={"0"},onEvents={},onCursorAdvanced={},onSnapshotRequired={},onRuntimeRefreshRequired={_,_->},onConnectionChanged={_,_,_,_->})
                check(sessionReader.read.await(5,TimeUnit.SECONDS)); delay(20); check(session.isActive)
                dash.cancelAndJoin();session.cancelAndJoin()
            } finally {scope.cancel()}
        }
        println("Storage boundary checks: "+n+" passed")
    }
}
