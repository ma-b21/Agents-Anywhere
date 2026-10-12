export type WebAuthSession = {
  accessToken: string; userId: string; role: "admin" | "member";
  loginGeneration: string; sessionId?: string; credentialVersion: number;
}
export type WebAuthSnapshot = WebAuthSession & { refreshAt: number; pendingUpgrade?: string }
export type WebAuthStorage = { read: () => WebAuthSnapshot | null; revision: () => string; write: (value: WebAuthSnapshot) => void; clear: () => void }
export type WebAuthLock = <T>(job: () => Promise<T>) => Promise<T>
export class WebLoginChanged extends Error { constructor() { super("The browser login changed during this request.") } }
export class WebAuthUnavailable extends Error { constructor() { super("This browser needs Web Locks (HTTPS or localhost) to sign in safely. Please use a supported browser or secure address.") } }
export class WebAuthHttpError extends Error {
  status: number; code: string
  constructor(status: number, code: string) { super("Browser authentication failed (HTTP " + status + "): " + code); this.status = status; this.code = code }
}
type Bootstrap = { authenticated: boolean; csrfToken: string; sessionId?: string; userId?: string }
const publicSession = (value: WebAuthSnapshot): WebAuthSession => ({
  accessToken: value.accessToken, userId: value.userId, role: value.role, loginGeneration: value.loginGeneration,
  sessionId: value.sessionId, credentialVersion: value.credentialVersion,
})
export class WebAuthCoordinator {
  private readonly storage: WebAuthStorage
  private readonly fetcher: typeof fetch
  private readonly base: string
  private readonly lock?: WebAuthLock
  private readonly clock: () => number
  private readonly uuid: () => string
  private readonly changed: (value: WebAuthSession | null) => void
  private flight: { generation: string; promise: Promise<WebAuthSnapshot> } | null = null
  private generation: string | null = null
  private known = new Set<string>() // access only, never the long-lived Cookie secret
  private upgradeUnavailableUntil = 0
  constructor(options: {
    storage: WebAuthStorage; fetcher: typeof fetch; base: string; lock?: WebAuthLock;
    clock?: () => number; uuid?: () => string; changed?: (value: WebAuthSession | null) => void;
  }) {
    this.storage = options.storage; this.fetcher = options.fetcher; this.base = options.base;
    this.lock = options.lock; this.clock = options.clock ?? Date.now; this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.changed = options.changed ?? (() => undefined)
  }
  private read() {
    const state = this.storage.read()
    if ((state?.loginGeneration ?? null) !== this.generation) {
      this.generation = state?.loginGeneration ?? null; this.known.clear(); this.upgradeUnavailableUntil = 0
    }
    if (state) this.known.add(state.accessToken)
    return state
  }
  current(): WebAuthSession | null { const value = this.read(); return value ? publicSession(value) : null }
  private notify(value: WebAuthSnapshot | null) { try { this.changed(value ? publicSession(value) : null) } catch { /* Notification is not persistence. */ } }
  synchronize() { this.notify(this.read()) }
  private commit(value: WebAuthSnapshot) { this.storage.write(value); this.read(); this.notify(value); return value }
  private clear(expected: string) {
    if (this.read()?.loginGeneration !== expected) return
    this.storage.clear(); this.read(); this.notify(null)
  }
  private coordinated<T>(job: () => Promise<T>) { return this.lock ? this.lock(job) : job() }
  private async raw(path: string, init: RequestInit = {}) {
    return this.fetcher(this.base + path, { ...init, credentials: "include", redirect: "error", cache: "no-store", signal: init.signal ?? AbortSignal.timeout(15_000) })
  }
  private async error(response: Response): Promise<WebAuthHttpError> {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    const detail = body.detail
    const code = response.headers.get("X-AA-Auth-Error") ?? (typeof body.code === "string" ? body.code : typeof detail === "string" ? detail : "authentication_unavailable")
    return new WebAuthHttpError(response.status, code)
  }
  private async bootstrap(): Promise<Bootstrap | null> {
    const response = await this.raw("/auth/session/bootstrap")
    if ([404, 405].includes(response.status)) return null
    if (!response.ok) throw await this.error(response)
    const value = await response.json() as Bootstrap & { refreshProtocolVersion?: number }
    if (value.refreshProtocolVersion !== 1 || typeof value.authenticated !== "boolean" || !value.csrfToken ||
      (value.authenticated && (!value.sessionId || !value.userId))) throw new Error("Invalid browser session bootstrap.")
    return value
  }
  private async bundle(raw: Record<string, unknown>, identity: { userId: string; sessionId?: string; role?: "admin" | "member" }, generation: string): Promise<WebAuthSnapshot> {
    const { accessToken, userId, sessionId, credentialVersion, accessExpiresIn } = raw
    if (typeof accessToken !== "string" || !accessToken || userId !== identity.userId || typeof sessionId !== "string" || !sessionId ||
        (identity.sessionId && sessionId !== identity.sessionId) || typeof credentialVersion !== "number" || !Number.isSafeInteger(credentialVersion) || credentialVersion < 0 ||
        typeof accessExpiresIn !== "number" || !Number.isFinite(accessExpiresIn) || accessExpiresIn < 0 || raw.refreshToken) throw new Error("Incomplete or mismatched browser credentials.")
    let role = identity.role
    if (!role) {
      const response = await this.raw("/auth/me", { headers: { authorization: "Bearer " + accessToken } })
      if (!response.ok) throw await this.error(response)
      const me = await response.json() as Record<string, unknown>
      if (me.userId !== userId || (me.role !== "admin" && me.role !== "member")) throw new Error("Browser account did not match its session.")
      role = me.role
    }
    const ttl = accessExpiresIn * 1000
    return { accessToken, userId: identity.userId, role, sessionId, credentialVersion, loginGeneration: generation,
      refreshAt: this.clock() + ttl - Math.min(60_000, ttl / 10) }
  }
  private assertCurrent(captured: WebAuthSnapshot) {
    const state = this.read()
    if (!state || state.loginGeneration !== captured.loginGeneration) throw new WebLoginChanged()
    return state
  }
  private async renew(state: WebAuthSnapshot, bootstrap?: Bootstrap | null): Promise<WebAuthSnapshot> {
    const boot = bootstrap === undefined ? await this.bootstrap() : bootstrap
    this.assertCurrent(state)
    if (!boot) { this.upgradeUnavailableUntil = this.clock() + 30 * 60_000; return state }
    if (state.sessionId) {
      if (!boot.authenticated) { this.clear(state.loginGeneration); throw new WebAuthHttpError(401, "reauth_required") }
      if (boot.sessionId !== state.sessionId || boot.userId !== state.userId) throw new WebLoginChanged()
    } else {
      if (!this.lock) { this.upgradeUnavailableUntil = this.clock() + 30 * 60_000; return state } // No unsafe Cookie upgrade.
      if (boot.authenticated) throw new WebLoginChanged()
      state = this.commit({ ...state, pendingUpgrade: state.pendingUpgrade ?? this.uuid() })
    }
    const response = await this.raw(state.sessionId ? "/auth/session/refresh" : "/auth/session/upgrade", {
      method: "POST", headers: { "content-type": "application/json", "X-CSRF-Token": boot.csrfToken, "X-AA-Session-Protocol": "1",
        ...(!state.sessionId ? { authorization: "Bearer " + state.accessToken } : {}) },
      body: JSON.stringify(state.sessionId ? { expectedSessionId: state.sessionId } : { clientId: "agents-anywhere-web", upgradeAttemptId: state.pendingUpgrade }),
    })
    this.assertCurrent(state)
    if (!response.ok) {
      const error = await this.error(response)
      if (!state.sessionId && ([404, 405].includes(error.status) || error.code === "upgrade_unavailable")) {
        this.upgradeUnavailableUntil = this.clock() + 30 * 60_000; return state
      }
      if (error.code === "session_changed") throw new WebLoginChanged()
      if (error.status === 401 || (error.status === 403 && error.code === "account_disabled")) this.clear(state.loginGeneration)
      throw error
    }
    const updated = await this.bundle(await response.json(), state, state.loginGeneration)
    const latest = this.assertCurrent(state)
    if (latest.credentialVersion > updated.credentialVersion) return latest
    this.known.add(state.accessToken)
    return this.commit(updated)
  }
  private async ensure(captured: WebAuthSnapshot, rejected?: string) {
    const current = this.assertCurrent(captured)
    const needed = (rejected && current.accessToken === rejected) || (current.pendingUpgrade && this.clock() >= this.upgradeUnavailableUntil) ||
      (current.sessionId ? this.clock() >= current.refreshAt : this.clock() >= this.upgradeUnavailableUntil)
    if (!needed) return current
    if (!this.flight || this.flight.generation !== current.loginGeneration) {
      const promise = this.coordinated(async () => {
        const latest = this.assertCurrent(captured)
        if (latest.credentialVersion > current.credentialVersion || latest.accessToken !== current.accessToken) return latest
        if (!rejected && latest.sessionId && this.clock() < latest.refreshAt) return latest
        return this.renew(latest)
      })
      const flight = { generation: current.loginGeneration, promise }; this.flight = flight
      void promise.finally(() => { if (this.flight === flight) this.flight = null }).catch(() => undefined)
    }
    const result = await this.flight.promise; this.assertCurrent(captured); return result
  }
  async accessToken(token: string, rejected = false) {
    const state = this.read()
    if (!state || !this.known.has(token)) throw new WebLoginChanged()
    return (await this.ensure(state, rejected ? token : undefined)).accessToken
  }
  async execute(token: string, action: (current: string) => Promise<Response>) {
    const captured = this.read()
    if (!captured || !this.known.has(token)) throw new WebLoginChanged()
    let state = await this.ensure(captured); this.assertCurrent(captured)
    let response = await action(state.accessToken); this.assertCurrent(captured)
    const denied = (r: Response) => r.status === 401 || (r.status === 403 && r.headers.get("X-AA-Auth-Error") === "account_disabled")
    if (!denied(response)) return response
    await response.body?.cancel().catch(() => undefined)
    state = await this.ensure(captured, state.accessToken); this.assertCurrent(captured)
    response = await action(state.accessToken); this.assertCurrent(captured)
    const latest = this.assertCurrent(captured)
    if (denied(response) && latest.credentialVersion <= state.credentialVersion && latest.accessToken === state.accessToken) this.clear(captured.loginGeneration)
    return response
  }
  async restore(legacy?: { accessToken: string; userId: string; role: "admin" | "member"; loginGeneration?: string } | null): Promise<WebAuthSession | null> {
    return this.coordinated(async () => {
      let state = this.read()
      if (!state && legacy && !legacy.loginGeneration && this.storage.revision() === "none") {
        state = this.commit({ accessToken: legacy.accessToken, userId: legacy.userId, role: legacy.role,
          loginGeneration: this.uuid(), credentialVersion: 0, refreshAt: 0 })
      }
      const revision = this.storage.revision()
      const unchanged = () => { if (this.storage.revision() !== revision) throw new WebLoginChanged() }
      const boot = await this.bootstrap()
      unchanged()
      state = this.read()
      if (boot?.authenticated) {
        if (state && state.sessionId === boot.sessionId && state.userId === boot.userId) {
          const value = this.clock() < state.refreshAt ? state : await this.renew(state, boot)
          unchanged()
          const latest = this.assertCurrent(value)
          this.notify(latest); return publicSession(latest)
        }
        const generation = this.uuid()
        const response = await this.raw("/auth/session/refresh", {
          method: "POST", headers: { "content-type": "application/json", "X-CSRF-Token": boot.csrfToken },
          body: JSON.stringify({ expectedSessionId: boot.sessionId }),
        })
        if (!response.ok) throw await this.error(response)
        const value = await this.bundle(await response.json(), { userId: boot.userId!, sessionId: boot.sessionId }, generation)
        unchanged()
        const latest = this.read()
        if (latest && latest.loginGeneration !== state?.loginGeneration) {
          if (latest.sessionId === value.sessionId && latest.credentialVersion >= value.credentialVersion) return publicSession(latest)
          throw new WebLoginChanged()
        }
        return publicSession(this.commit(value))
      }
      if (state?.sessionId && boot) { this.clear(state.loginGeneration); state = null }
      // Native mirrors must not recreate a revoked/cleared Cookie session.
      if (!state) return null
      if (!boot || !this.lock) { this.upgradeUnavailableUntil = this.clock() + 30 * 60_000; this.notify(state); return publicSession(state) }
      if (this.clock() < this.upgradeUnavailableUntil) { this.notify(state); return publicSession(state) }
      return publicSession(await this.renew(state, boot))
    })
  }
  /** The lock covers the Cookie-changing HTTP response AND identity commit. */
  async login(path: string, body: unknown): Promise<Response> {
    return this.coordinated(async () => {
      const boot = await this.bootstrap()
      if (boot && !this.lock) throw new WebAuthUnavailable()
      const response = await this.raw(path, {
        method: "POST", headers: { "content-type": "application/json", ...(boot ? { "X-AA-Session-Protocol": "1", "X-CSRF-Token": boot.csrfToken } : {}) },
        body: JSON.stringify(body),
      })
      if (!response.ok) return response
      const payload = await response.clone().json() as Record<string, unknown>
      const auth = payload.auth && typeof payload.auth === "object" ? payload.auth as Record<string, unknown> : payload
      if (typeof auth.accessToken !== "string" || !auth.accessToken || typeof auth.userId !== "string" || !auth.userId || (auth.role !== "admin" && auth.role !== "member")) {
        throw new Error("Invalid browser login response.")
      }
      const generation = this.uuid()
      const value: WebAuthSnapshot = boot ? await this.bundle(auth, { userId: auth.userId, role: auth.role }, generation) : {
        accessToken: auth.accessToken, userId: auth.userId, role: auth.role, loginGeneration: generation,
        credentialVersion: 0, refreshAt: 0,
      }
      if (boot) {
        const confirmed = await this.bootstrap()
        if (!confirmed?.authenticated || confirmed.sessionId !== value.sessionId || confirmed.userId !== value.userId) {
          throw new Error("The browser did not retain the login Cookie. Use HTTPS and a same-origin deployment; check Cookie restrictions.")
        }
      }
      this.commit(value)
      return response
    })
  }
  async signOut(expectedGeneration: string): Promise<boolean> {
    return this.coordinated(async () => {
      const state = this.read()
      if (!state || state.loginGeneration !== expectedGeneration) return false
      if (!state.sessionId) { this.clear(expectedGeneration); return true }
      const boot = await this.bootstrap(); this.assertCurrent(state)
      if (!boot?.authenticated) { this.clear(expectedGeneration); return true }
      if (boot.sessionId !== state.sessionId) throw new WebLoginChanged()
      const response = await this.raw("/auth/session/logout", {
        method: "POST", headers: { "content-type": "application/json", "X-CSRF-Token": boot.csrfToken },
        body: JSON.stringify({ expectedSessionId: state.sessionId, clearCookie: !!this.lock }),
      })
      this.assertCurrent(state)
      if (!response.ok) {
        const error = await this.error(response)
        if (error.code !== "reauth_required") throw error
      }
      this.clear(expectedGeneration); return true
    })
  }
}
