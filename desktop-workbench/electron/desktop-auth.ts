import { createHash, randomUUID } from "node:crypto";
import type { DesktopAuthSession } from "../shared/desktop-auth";
import type { DesktopServerConnection } from "./desktop-server";

export type DesktopCredentials = {
  accessToken: string;
  refreshToken?: string;
  sessionId?: string;
  userId?: string;
  expiresIn?: number;
  credentialVersion?: number;
};
export type DesktopAuthSnapshot = DesktopAuthSession & {
  apiNamespace: string;
  refreshToken?: string;
  refreshAt: number;
  pendingRefresh?: string;
  pendingUpgrade?: string;
};
export interface DesktopAuthStorage {
  read(): DesktopAuthSnapshot | null;
  write(value: DesktopAuthSnapshot): void;
  clear(): void;
}
export class DesktopLoginChanged extends Error {
  constructor() { super("The login or server changed during the request."); }
}
export class DesktopAuthDenied extends Error {
  constructor(readonly code = "reauth_required") { super("This login has expired or been revoked."); }
}
export function publicDesktopSession(value: DesktopAuthSnapshot): DesktopAuthSession {
  const { serverUrl, accessToken, userId, role, loginGeneration, sessionId, credentialVersion } = value;
  return { serverUrl, accessToken, userId, role, loginGeneration, sessionId, credentialVersion };
}
export function parseDesktopCredentials(raw: Record<string, unknown>, snake = false): DesktopCredentials {
  const name = (camel: string, underscore: string) => snake ? underscore : camel;
  const access = raw[name("accessToken", "access_token")];
  if (typeof access !== "string" || !access) throw new Error("Invalid access credential response.");
  const refresh = raw[name("refreshToken", "refresh_token")];
  const sid = raw[name("sessionId", "session_id")];
  if (typeof sid !== "string" || !sid) return { accessToken: access }; // Old server.
  const user = raw[name("userId", "user_id")];
  const ttl = raw[name("accessExpiresIn", "expires_in")];
  const version = raw[name("credentialVersion", "credential_version")];
  if (typeof refresh !== "string" || !refresh.startsWith("aar_") || typeof user !== "string" || !user ||
      typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0 ||
      typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new Error("Incomplete renewable credential response.");
  }
  return { accessToken: access, refreshToken: refresh, sessionId: sid, userId: user, expiresIn: ttl, credentialVersion: version };
}
function renewalTime(ttl: number, now: number): number {
  const duration = ttl * 1000;
  return now + duration - Math.min(60_000, duration / 10);
}
export class DesktopAuthCoordinator {
  private flight: { login: string; promise: Promise<DesktopAuthSnapshot> } | null = null;
  private generation: string | null = null;
  private fingerprints = new Set<string>();
  private upgradeUnavailableUntil = 0;
  constructor(
    private readonly storage: DesktopAuthStorage,
    private readonly fetcher: typeof fetch,
    private readonly changed: (value: DesktopAuthSession | null) => void = () => undefined,
    private readonly clock: () => number = Date.now,
  ) {}
  private fingerprint(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  private read(): DesktopAuthSnapshot | null {
    const state = this.storage.read();
    if ((state?.loginGeneration ?? null) !== this.generation) {
      this.generation = state?.loginGeneration ?? null;
      this.fingerprints.clear(); this.upgradeUnavailableUntil = 0;
    }
    if (state) this.fingerprints.add(this.fingerprint(state.accessToken));
    return state;
  }
  getSession(): DesktopAuthSession | null { const state = this.read(); return state ? publicDesktopSession(state) : null; }
  handles(origin: string, token: string): boolean {
    const state = this.read();
    return !!state && state.serverUrl === origin && this.fingerprints.has(this.fingerprint(token));
  }
  login(server: DesktopServerConnection, tokens: DesktopCredentials, me: { userId: string; role: "admin" | "member" }): DesktopAuthSession {
    if (tokens.userId && tokens.userId !== me.userId) throw new Error("Login subject did not match.");
    const state: DesktopAuthSnapshot = {
      serverUrl: server.serverUrl, apiNamespace: server.apiNamespace,
      accessToken: tokens.accessToken, userId: me.userId, role: me.role, loginGeneration: randomUUID(),
      sessionId: tokens.sessionId, refreshToken: tokens.refreshToken,
      credentialVersion: tokens.credentialVersion ?? 0,
      refreshAt: tokens.refreshToken ? renewalTime(tokens.expiresIn ?? 0, this.clock()) : 0,
    };
    this.storage.write(state); this.read(); this.notify(publicDesktopSession(state)); return publicDesktopSession(state);
  }
  importLegacy(server: DesktopServerConnection, value: { serverUrl?: string; accessToken: string; userId: string; role: "admin" | "member" }): DesktopAuthSession | null {
    const current = this.getSession(); if (current) return current;
    if (value.serverUrl && value.serverUrl !== server.serverUrl) throw new DesktopLoginChanged();
    if (!value.accessToken || !value.userId || !["admin", "member"].includes(value.role)) throw new Error("Invalid legacy session.");
    return this.login(server, { accessToken: value.accessToken }, value);
  }
  private context(origin: string, token: string): DesktopAuthSnapshot {
    const state = this.read();
    if (!state || state.serverUrl !== origin || !this.fingerprints.has(this.fingerprint(token))) throw new DesktopLoginChanged();
    return state;
  }
  async accessToken(origin: string, token: string, rejected = false): Promise<string> {
    return (await this.ensure(this.context(origin, token), rejected ? token : undefined)).accessToken;
  }
  async execute(origin: string, token: string, action: (token: string) => Promise<Response>): Promise<Response> {
    const captured = this.context(origin, token);
    let state = await this.ensure(captured);
    let response = await action(state.accessToken);
    if (this.read()?.loginGeneration !== captured.loginGeneration) throw new DesktopLoginChanged();
    if (!this.unauthorized(response)) return response;
    await response.body?.cancel().catch(() => undefined);
    state = await this.ensure(captured, state.accessToken);
    response = await action(state.accessToken);
    if (this.read()?.loginGeneration !== captured.loginGeneration) throw new DesktopLoginChanged();
    const latest = this.read();
    if (this.unauthorized(response) && latest?.accessToken === state.accessToken && latest.credentialVersion <= state.credentialVersion) this.revoke(captured.loginGeneration);
    return response;
  }
  private unauthorized(response: Response): boolean {
    return response.status === 401 || (response.status === 403 && response.headers.get("X-AA-Auth-Error") === "account_disabled");
  }
  private async ensure(captured: DesktopAuthSnapshot, rejected?: string): Promise<DesktopAuthSnapshot> {
    const latest = this.read();
    if (!latest || latest.loginGeneration !== captured.loginGeneration) throw new DesktopLoginChanged();
    const needed = latest.pendingRefresh || latest.pendingUpgrade ||
      (rejected && latest.accessToken === rejected) ||
      (latest.refreshToken ? this.clock() >= latest.refreshAt : this.clock() >= this.upgradeUnavailableUntil);
    if (!needed) return latest;
    if (!this.flight || this.flight.login !== latest.loginGeneration) {
      const promise = this.refresh(latest);
      const flight = { login: latest.loginGeneration, promise };
      this.flight = flight;
      void promise.finally(() => { if (this.flight === flight) this.flight = null; }).catch(() => undefined);
    }
    const updated = await this.flight.promise;
    if (this.read()?.loginGeneration !== captured.loginGeneration) throw new DesktopLoginChanged();
    return updated;
  }
  private async refresh(original: DesktopAuthSnapshot): Promise<DesktopAuthSnapshot> {
    const pending = original.refreshToken
      ? { ...original, pendingRefresh: original.pendingRefresh ?? randomUUID() }
      : { ...original, pendingUpgrade: original.pendingUpgrade ?? randomUUID() };
    this.storage.write(pending); // Confirm disk BEFORE spending a single-use secret.
    try {
      const credentials = await this.requestRenewal(pending);
      const latest = this.read();
      if (!latest || latest.loginGeneration !== pending.loginGeneration) throw new DesktopLoginChanged();
      if (latest.credentialVersion > pending.credentialVersion) return latest;
      let updated: DesktopAuthSnapshot;
      if (credentials === null) {
        updated = { ...pending, pendingUpgrade: undefined };
        this.upgradeUnavailableUntil = this.clock() + 30 * 60_000;
      } else {
        if (credentials.userId !== pending.userId || (pending.sessionId && credentials.sessionId !== pending.sessionId) ||
            (credentials.credentialVersion ?? -1) < pending.credentialVersion || !credentials.refreshToken) {
          throw new Error("Refresh returned a different or incomplete session.");
        }
        updated = { ...pending, ...credentials, credentialVersion: credentials.credentialVersion!,
          refreshAt: renewalTime(credentials.expiresIn!, this.clock()), pendingRefresh: undefined, pendingUpgrade: undefined };
      }
      this.storage.write(updated);
      this.fingerprints.add(this.fingerprint(pending.accessToken));
      this.fingerprints.add(this.fingerprint(updated.accessToken));
      this.notify(publicDesktopSession(updated)); return updated;
    } catch (error) {
      if (error instanceof DesktopAuthDenied) {
        const latest = this.read();
        if (error.code === "refresh_superseded" && latest?.loginGeneration === pending.loginGeneration && latest.credentialVersion > pending.credentialVersion) return latest;
        this.revoke(pending.loginGeneration);
      }
      throw error; // Temporary errors preserve the exact pending transaction.
    }
  }
  private async requestRenewal(state: DesktopAuthSnapshot): Promise<DesktopCredentials | null> {
    const native = !!state.refreshToken;
    const response = await this.fetcher(state.serverUrl + state.apiNamespace + (native ? "/oauth/token" : "/auth/session/upgrade"), {
      method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15_000),
      headers: native ? { "content-type": "application/x-www-form-urlencoded" } : { "content-type": "application/json", authorization: "Bearer " + state.accessToken },
      body: native ? new URLSearchParams({ grant_type: "refresh_token", client_id: "agents-anywhere-desktop",
        refresh_token: state.refreshToken!, refresh_attempt_id: state.pendingRefresh! }).toString()
        : JSON.stringify({ clientId: "agents-anywhere-desktop", upgradeAttemptId: state.pendingUpgrade }),
    });
    const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
    const code = response.headers.get("X-AA-Auth-Error") || String(raw.code ?? (typeof raw.detail === "object" && raw.detail ? (raw.detail as Record<string, unknown>).code : ""));
    if (!native && ([404, 405].includes(response.status) || code === "upgrade_unavailable")) return null;
    if (response.status === 401 || (response.status === 403 && code === "account_disabled") || (native && response.status === 400 && ["reauth_required", "refresh_superseded"].includes(code))) throw new DesktopAuthDenied(code);
    if (!response.ok) throw new Error("Login renewal temporarily unavailable (HTTP " + response.status + ").");
    return parseDesktopCredentials(raw, native);
  }
  private notify(value: DesktopAuthSession | null): void { try { this.changed(value); } catch { /* UI notification is not part of persistence. */ } }
  private revoke(login: string): void {
    if (this.read()?.loginGeneration !== login) return;
    this.storage.clear(); this.read(); this.notify(null);
  }
  signOut(expectedLogin: string): boolean {
    const state = this.read(); if (!state || state.loginGeneration !== expectedLogin) return false;
    this.storage.clear(); this.read(); this.notify(null);
    if (state.sessionId) void this.fetcher(state.serverUrl + state.apiNamespace + "/auth/session/logout", {
      method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSessionId: state.sessionId, clientId: "agents-anywhere-desktop", refreshToken: state.refreshToken }),
    }).catch(() => undefined);
    return true;
  }
}
