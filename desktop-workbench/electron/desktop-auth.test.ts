import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DesktopAuthCoordinator, DesktopAuthDenied, DesktopLoginChanged, type DesktopAuthSnapshot, type DesktopAuthStorage } from "./desktop-auth";
import { DesktopAuthFileStore } from "./desktop-auth-store";
import { proxyDesktopApi } from "./api-proxy";

const server = { serverUrl: "https://self.example", apiNamespace: "/api/v2", oauthWebOrigin: "https://self.example" };
const native = (n = 0) => ({ accessToken: "access-" + n, refreshToken: "aar_secret-" + n, sessionId: "sid", userId: "u", expiresIn: 60, credentialVersion: n });
const response = (n = 1) => Response.json({ access_token: "access-" + n, refresh_token: "aar_secret-" + n, session_id: "sid", user_id: "u", expires_in: 60, credential_version: n });
class MemoryStore implements DesktopAuthStorage {
  value: DesktopAuthSnapshot | null = null;
  fail = false;
  read() { return this.value ? structuredClone(this.value) : null; }
  write(value: DesktopAuthSnapshot) { if (this.fail) throw new Error("disk"); this.value = structuredClone(value); }
  clear() { if (this.fail) throw new Error("disk"); this.value = null; }
}
function setup(fetcher: typeof fetch, changed: ConstructorParameters<typeof DesktopAuthCoordinator>[2] = () => undefined) {
  const store = new MemoryStore(); let now = 0;
  const auth = new DesktopAuthCoordinator(store, fetcher, changed, () => now);
  auth.login(server, native(), { userId: "u", role: "member" });
  return { auth, store, advance: () => { now += 61_000; } };
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

test("twenty expired requests share one persisted refresh and only expose public fields", async () => {
  const wait = deferred<Response>(); let refreshes = 0;
  const { auth, store, advance } = setup(async (_, init) => {
    refreshes++; const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("refresh_attempt_id"), store.value?.pendingRefresh);
    assert.equal(form.get("client_id"), "agents-anywhere-desktop");
    assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    return wait.promise;
  });
  advance();
  const calls = Array.from({ length: 20 }, () => auth.accessToken(server.serverUrl, "access-0"));
  wait.resolve(response()); assert.deepEqual(await Promise.all(calls), Array(20).fill("access-1"));
  assert.equal(refreshes, 1); assert.equal("refreshToken" in auth.getSession()!, false);
});
test("lost response survives restart with the exact same attempt", async () => {
  let attempt = "";
  const { auth, store, advance } = setup(async (_, init) => { attempt = new URLSearchParams(String(init?.body)).get("refresh_attempt_id")!; throw new Error("offline"); });
  advance(); await assert.rejects(auth.accessToken(server.serverUrl, "access-0"), /offline/);
  const restarted = new DesktopAuthCoordinator(store, async (_, init) => {
    assert.equal(new URLSearchParams(String(init?.body)).get("refresh_attempt_id"), attempt); return response();
  });
  assert.equal(await restarted.accessToken(server.serverUrl, "access-0"), "access-1");
});
test("failed pending write spends no refresh secret", async () => {
  let calls = 0; const { auth, store, advance } = setup(async () => { calls++; return response(); });
  advance(); store.fail = true; await assert.rejects(auth.accessToken(server.serverUrl, "access-0"), /disk/);
  assert.equal(calls, 0); assert.equal(store.value?.pendingRefresh, undefined);
});
test("failed result write does not expose unpersisted tokens and recovers same transaction", async () => {
  let calls = 0; let attempt = "";
  const { auth, store, advance } = setup(async (_, init) => {
    const actual = new URLSearchParams(String(init?.body)).get("refresh_attempt_id")!;
    if (calls++) assert.equal(actual, attempt); else attempt = actual;
    if (calls === 1) store.fail = true; return response();
  });
  advance(); await assert.rejects(auth.accessToken(server.serverUrl, "access-0"), /disk/);
  assert.equal(auth.getSession()?.accessToken, "access-0"); store.fail = false;
  assert.equal(await auth.accessToken(server.serverUrl, "access-0"), "access-1");
});
test("late old 401 uses the already rotated token without another refresh", async () => {
  let n = 0; const { auth } = setup(async () => response(++n));
  const oldResponse = deferred<Response>();
  const business = auth.execute(server.serverUrl, "access-0", async (token) => token === "access-0" ? oldResponse.promise : Response.json({ token }));
  await Promise.resolve(); await Promise.resolve();
  await auth.accessToken(server.serverUrl, "access-0", true);
  oldResponse.resolve(new Response(null, { status: 401 }));
  assert.equal((await (await business).json()).token, "access-1"); assert.equal(n, 1);
});
test("network failure never replays a business POST", async () => {
  const { auth } = setup(async () => response()); let calls = 0;
  await assert.rejects(auth.execute(server.serverUrl, "access-0", async () => { calls++; throw new Error("timeout after send"); }), /timeout/);
  assert.equal(calls, 1); assert.ok(auth.getSession());
});
test("second auth rejection stops retry and notifies logout once", async () => {
  const events: unknown[] = []; const { auth } = setup(async () => response(), (value) => events.push(value)); let calls = 0;
  const result = await auth.execute(server.serverUrl, "access-0", async () => { calls++; return new Response(null, { status: 401 }); });
  assert.equal(result.status, 401); assert.equal(calls, 2); assert.equal(auth.getSession(), null); assert.equal(events.filter(v => v === null).length, 1);
});
test("refresh logout/account switch fencing prevents late result resurrection", async () => {
  const wait = deferred<Response>(); const { auth, advance } = setup(async () => wait.promise); advance();
  const old = auth.accessToken(server.serverUrl, "access-0");
  const login = auth.getSession()!.loginGeneration; auth.signOut(login);
  const next = auth.login(server, { ...native(), accessToken: "new-account", userId: "other", sessionId: "other-sid" }, { userId: "other", role: "admin" });
  wait.resolve(response()); await assert.rejects(old, DesktopLoginChanged);
  assert.equal(auth.getSession()?.loginGeneration, next.loginGeneration);
  assert.equal(auth.signOut(login), false);
});
test("wrong host and unknown bearer never receive current credentials", async () => {
  const { auth } = setup(async () => response());
  await assert.rejects(auth.accessToken("https://evil.example", "access-0"), DesktopLoginChanged);
  await assert.rejects(auth.accessToken(server.serverUrl, "unknown"), DesktopLoginChanged);
});
test("long lived closures are recognized after seventy rotations without keeping old bearer plaintext", async () => {
  let n = 0; const { auth, advance } = setup(async () => response(++n));
  for (let i = 0; i < 70; i++) { advance(); await auth.accessToken(server.serverUrl, "access-0"); }
  assert.equal(await auth.accessToken(server.serverUrl, "access-0"), "access-70");
});
test("legacy upgrade returns camel credentials; unavailable old servers keep access login", async () => {
  const store = new MemoryStore(); let calls = 0;
  const auth = new DesktopAuthCoordinator(store, async () => { calls++; return new Response(null, { status: 404 }); });
  auth.importLegacy(server, { accessToken: "legacy", userId: "u", role: "member" });
  assert.equal(await auth.accessToken(server.serverUrl, "legacy"), "legacy");
  assert.equal(await auth.accessToken(server.serverUrl, "legacy"), "legacy"); assert.equal(calls, 1);
  const upgraded = new DesktopAuthCoordinator(store, async () => Response.json({ ...native(1), accessExpiresIn: 60 }));
  assert.equal(await upgraded.accessToken(server.serverUrl, "legacy"), "access-1");
});
test("revocation clears login while temporary failures preserve pending attempt", async () => {
  const { auth, advance } = setup(async () => Response.json({ code: "reauth_required" }, { status: 400 })); advance();
  await assert.rejects(auth.accessToken(server.serverUrl, "access-0"), DesktopAuthDenied); assert.equal(auth.getSession(), null);
});
test("proxy replays identical multipart only after explicit auth rejection", async () => {
  const { auth } = setup(async () => response()); const seen: string[] = [];
  const form = new FormData(); form.set("file", new Blob(["中文文件"]), "中文.txt");
  const request = new Request("aa-workbench://web/api/v2/sessions/files?token=access-0", { method: "POST", body: form });
  const result = await proxyDesktopApi(request, server.serverUrl, [], async (url, init) => {
    assert.equal(new URL(String(url)).origin, server.serverUrl); assert.equal(init?.redirect, "error");
    seen.push(await new Request(String(url), init).text());
    return new Response("ok", { status: seen.length === 1 ? 401 : 200 });
  }, auth);
  assert.equal(result.status, 200); assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]);
});
test("cancelled proxy waiter does not cancel the shared refresh or send its business request", async () => {
  const wait = deferred<Response>(); const { auth, advance } = setup(async () => wait.promise); advance();
  const cancel = new AbortController(); let sent = 0;
  const request = new Request("aa-workbench://web/api/v2/sessions", { headers: { authorization: "Bearer access-0" }, signal: cancel.signal });
  const aborted = proxyDesktopApi(request, server.serverUrl, [], async () => { sent++; return new Response(); }, auth);
  const other = auth.accessToken(server.serverUrl, "access-0"); cancel.abort(); wait.resolve(response());
  await assert.rejects(aborted); assert.equal(await other, "access-1"); assert.equal(sent, 0);
});
test("encrypted file store survives restart, never stores plaintext, preserves previous file on cipher failure", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-auth-test-")); const file = path.join(directory, "session.bin");
  const key = randomBytes(32);
  const cipher = {
    encrypt: (plain: string) => { const iv = randomBytes(12); const enc = createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, enc.update(plain), enc.final(), enc.getAuthTag()]); },
    decrypt: (data: Buffer) => { const dec = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12)); dec.setAuthTag(data.subarray(-16)); return Buffer.concat([dec.update(data.subarray(12, -16)), dec.final()]).toString(); },
  };
  try {
    const store = new DesktopAuthFileStore(file, cipher);
    const auth = new DesktopAuthCoordinator(store, async () => response()); auth.login(server, native(), { userId: "u", role: "member" });
    assert.equal(fs.readFileSync(file).includes(Buffer.from("aar_secret")), false);
    assert.equal(new DesktopAuthFileStore(file, cipher).read()?.accessToken, "access-0");
    const failed = new DesktopAuthFileStore(file, { ...cipher, encrypt: () => { throw new Error("cipher unavailable"); } });
    assert.throws(() => failed.write({ ...store.read()!, accessToken: "different" }), /cipher/);
    assert.equal(store.read()?.accessToken, "access-0");
    store.clear(); assert.equal(store.read(), null);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
test("late second 401 cannot revoke a newer concurrent credential", async () => {
  let refreshes = 0, notifications = 0, sends = 0;
  const waiting = deferred<Response>(), entered = deferred<void>();
  const { auth, store } = setup(async () => response(++refreshes), value => { if (!value) notifications++; });
  const pending = auth.execute(server.serverUrl, "access-0", async token => {
    sends++; if (sends === 1) return new Response(null, { status: 401 });
    assert.equal(token, "access-1"); entered.resolve(); return waiting.promise;
  });
  await entered.promise; await auth.accessToken(server.serverUrl, "access-1", true);
  waiting.resolve(new Response(null, { status: 401 }));
  assert.equal((await pending).status, 401); assert.equal(sends, 2); assert.equal(refreshes, 2);
  assert.equal(store.value?.accessToken, "access-2"); assert.equal(notifications, 0);
});
