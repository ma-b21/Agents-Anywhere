package com.agentsanywhere.app.api

import com.agentsanywhere.app.feature.auth.*
import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** Real localhost HTTP/JSON/multipart transport tests, no live server credentials. */
object AuthHttpChecks {
    private class Fixture : AutoCloseable {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val workers = Executors.newCachedThreadPool()
        val origin = "http://127.0.0.1:" + server.address.port
        var snapshot: NativeAuthSnapshot? = NativeAuthSnapshot(origin,"old","u","user",refreshToken="aar_old",sessionId="sid",refreshAtMs=Long.MAX_VALUE)
        val refreshes=AtomicInteger(); val business=AtomicInteger(); val revoked=AtomicInteger()
        var mode="ok"
        val bodies=mutableListOf<String>()
        val storage=object : NativeAuthStorage {
            @Synchronized override fun readSnapshot() = snapshot
            @Synchronized override fun replace(expected: NativeAuthSnapshot, replacement: NativeAuthSnapshot): Boolean {
                if(snapshot!=expected)return false; snapshot=replacement; return true
            }
            @Synchronized override fun clear(expected: NativeAuthSnapshot): Boolean { snapshot=null; return true }
        }
        val auth=NativeAuthCoordinator(storage,NativeAuthApiTransport(),{ it is ApiException && it.statusCode==401 },{revoked.incrementAndGet()})
        val client=ApiClient(sessionAuth=auth)
        init {
            server.executor=workers
            server.createContext("/") { ex ->
                val text=ex.requestBody.bufferedReader().readText()
                val refresh=ex.requestURI.path.endsWith("/oauth/token")
                val token=ex.requestHeaders.getFirst("Authorization")
                var status=200
                val response=if(refresh) {
                    refreshes.incrementAndGet()
                    val fields=text.split("&").associate { val pair=it.split("=",limit=2); pair[0] to URLDecoder.decode(pair[1],"UTF-8") }
                    check(fields["refresh_attempt_id"]==snapshot!!.pendingRefresh && fields["client_id"]=="agents-anywhere-mobile")
                    if(mode=="denied") { status=400; """{"error":"invalid_grant","code":"reauth_required"}""" }
                    else """{"access_token":"fresh","refresh_token":"aar_fresh","session_id":"sid","user_id":"u","expires_in":900,"credential_version":1}"""
                } else {
                    business.incrementAndGet(); synchronized(bodies) { bodies.add(text) }
                    when(mode) {
                        "disconnect" -> { ex.close(); return@createContext }
                        "redirect" -> { status=302; ex.responseHeaders.add("Location",origin+"/sink"); """{}""" }
                        "denied" -> { status=401; """{"detail":"expired"}""" }
                        else -> if(token=="Bearer old") { status=401; """{"detail":"expired"}""" } else """{"ok":true}"""
                    }
                }
                ex.responseHeaders.add("Content-Type","application/json")
                val bytes=response.toByteArray(); ex.sendResponseHeaders(status,bytes.size.toLong()); ex.responseBody.use { it.write(bytes) }
            }
            server.start()
        }
        override fun close() { server.stop(0); workers.shutdownNow() }
    }
    private fun fails(action: () -> Unit) { var thrown=false; try { action() } catch(e: Exception) { thrown=true }; check(thrown) }
    @JvmStatic fun main(args: Array<String>) { runAll() }
    fun runAll() {
        var count=0
        fun test(name: String, block: (Fixture)->Unit) { Fixture().use(block); count++; println("PASS "+name) }
        test("JSON auth401 refreshes and retries once") { f ->
            check(f.client.postJson(f.origin,"/send",JSONObject().put("message","hello"),"old").getBoolean("ok"))
            check(f.business.get()==2 && f.refreshes.get()==1 && f.revoked.get()==0)
            check(f.bodies[0]==f.bodies[1] && f.snapshot!!.refreshToken=="aar_fresh")
        }
        test("multipart replay uses new bearer and identical file") { f ->
            check(f.client.postMultipart(f.origin,"/upload",listOf(UploadFilePart("x.txt","text/plain","file-content".toByteArray())),"old").getBoolean("ok"))
            check(f.business.get()==2 && f.refreshes.get()==1 && f.bodies.all { it.contains("file-content") })
        }
        test("HTTP disconnect never replays message") { f -> f.mode="disconnect"; fails { f.client.postJson(f.origin,"/send",JSONObject(),"old") }; check(f.business.get()==1 && f.refreshes.get()==0 && f.revoked.get()==0) }
        test("JSON redirects never forward bearer") { f -> f.mode="redirect"; fails { f.client.postJson(f.origin,"/send",JSONObject(),"old") }; check(f.business.get()==1) }
        test("multipart redirects never forward bearer") { f -> f.mode="redirect"; fails { f.client.postMultipart(f.origin,"/upload",emptyList(),"old") }; check(f.business.get()==1) }
        test("structured refresh failure revokes only once") { f -> f.mode="denied"; repeat(2) { fails { f.client.getJson(f.origin,"/me","old") } }; check(f.revoked.get()==1 && f.refreshes.get()==1) }
        test("terminal URL updates token but preserves path/seq") { f ->
            f.snapshot=f.snapshot!!.copy(refreshAtMs=0)
            val api=TerminalApi(f.client)
            val url=api.streamUrl(f.origin,"old","c","t",7)
            check(url.contains("token=fresh") && url.contains("fromSeq=7") && f.refreshes.get()==1)
            check(api.refreshStreamUrl(url,false)==url)
            fails { api.refreshStreamUrl(url.replace("127.0.0.1","localhost"),false) }
        }
        test("current account token never sent to a different host") { f ->
            fails { f.client.getJson(f.origin.replace("127.0.0.1","localhost"),"/me","old") }
            check(f.business.get()==0 && f.refreshes.get()==0)
        }
        test("snake/camel metadata preserved") { _ ->
            val camel=JSONObject("""{"accessToken":"a","refreshToken":"r","sessionId":"s","userId":"u","accessExpiresIn":12,"credentialVersion":3}""").toRenewableCredentials()!!
            check(camel.expiresIn==12L && camel.credentialVersion==3L)
            check(JSONObject("""{"accessToken":"legacy"}""").toRenewableCredentials()==null)
        }
        println("Auth HTTP checks: "+count+" passed")
    }
}
