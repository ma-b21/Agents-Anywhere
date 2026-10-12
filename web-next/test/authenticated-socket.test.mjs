import assert from "node:assert/strict"
import test from "node:test"
import { connectAuthenticatedSocket } from "../src/lib/authenticated-socket.ts"

const flush = async () => { await Promise.resolve(); await Promise.resolve() }
function fixture(getToken = async () => "fresh") {
  const sockets = []; let opens = 0; let reconnects = 0
  const connection = connectAuthenticatedSocket({
    getToken, url: (token) => "wss://self.example/?token=" + token,
    opened: () => { opens++ }, message: () => {}, reconnecting: () => { reconnects++ },
    failed: () => {}, shouldReconnect: () => true,
    create: (url) => { const socket = { url, readyState: 1, send() {}, close() {} }; sockets.push(socket); return socket },
  })
  return { connection, sockets, get opens() { return opens }, get reconnects() { return reconnects } }
}
test("terminal close reacquires current token and reconnects without rebuilding caller state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const flags = []; const f = fixture(async (rejected) => { flags.push(rejected); return "token-" + flags.length })
  await flush(); f.sockets[0].onopen(); f.sockets[0].onclose({ code: 4401 })
  t.mock.timers.tick(500); await flush()
  assert.deepEqual(flags, [false, true]); assert.match(f.sockets[1].url, /token-2/)
  f.connection.close()
})
test("cleanup while renewal is pending cannot create a late socket", async () => {
  let resolve; const f = fixture(() => new Promise(r => { resolve = r }))
  f.connection.close(); resolve("late"); await flush(); assert.equal(f.sockets.length, 0)
})
test("ambiguous auth failure can force renewal only once until connection opens", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const flags = []; const f = fixture(async (flag) => { flags.push(flag); return "t" })
  await flush(); f.sockets[0].onclose({ code: 1006 }); t.mock.timers.tick(500); await flush()
  f.sockets[1].onclose({ code: 1006 }); t.mock.timers.tick(1000); await flush()
  assert.deepEqual(flags, [false, true, false]); f.connection.close()
})
