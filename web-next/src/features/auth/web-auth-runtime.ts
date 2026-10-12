import { WebAuthCoordinator, type WebAuthSession, type WebAuthSnapshot } from "./web-auth-coordinator.ts"

const namespaceValue = (process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API_NAMESPACE ?? "/api/v2").trim().replace(/^[/]+|[/]+$/g, "")
export const webAuthNamespace = namespaceValue ? "/" + namespaceValue : ""
let coordinator: WebAuthCoordinator | null = null
const listeners = new Set<(value: WebAuthSession | null) => void>()
function identityRevision() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")
}

export function webAuth(): WebAuthCoordinator | null {
  if (typeof window === "undefined") return null
  if (coordinator) return coordinator
  const key = "aa.web.session.v1:" + window.location.origin + ":" + webAuthNamespace
  const lockName = "aa.browser-auth:" + webAuthNamespace
  const channel = typeof window.BroadcastChannel === "function" ? new window.BroadcastChannel(lockName) : null
  const publish = (value: WebAuthSession | null) => { for (const listener of listeners) { try { listener(value) } catch { /* Each subscriber is isolated. */ } } }
  coordinator = new WebAuthCoordinator({
    base: window.location.origin + webAuthNamespace,
    fetcher: (input, init) => fetch(input, init),
    storage: {
      read: () => {
        const raw = window.localStorage.getItem(key)
        if (!raw) return null
        const record = JSON.parse(raw)
        const value = (Object.hasOwn(record, "state") ? record.state : record) as WebAuthSnapshot | null
        if (value === null) return null
        if (!value || typeof value.accessToken !== "string" || !value.accessToken || typeof value.userId !== "string" || !value.userId ||
          (value.role !== "admin" && value.role !== "member") || typeof value.loginGeneration !== "string" || !value.loginGeneration ||
          !Number.isSafeInteger(value.credentialVersion) || value.credentialVersion < 0 || !Number.isFinite(value.refreshAt)) throw new Error("Invalid browser login cache.")
        return { accessToken: value.accessToken, userId: value.userId, role: value.role, loginGeneration: value.loginGeneration,
          sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined, credentialVersion: value.credentialVersion,
          refreshAt: value.refreshAt, pendingUpgrade: typeof value.pendingUpgrade === "string" ? value.pendingUpgrade : undefined }
      },
      revision: () => {
        const raw = window.localStorage.getItem(key)
        if (!raw) return "none"
        const record = JSON.parse(raw)
        return typeof record.identityRevision === "string" ? record.identityRevision : "legacy"
      },
      write: (value) => {
        const raw = window.localStorage.getItem(key)
        const record = raw ? JSON.parse(raw) : null
        const prior = record && (Object.hasOwn(record, "state") ? record.state : record)
        const revision = prior?.loginGeneration === value.loginGeneration ? (record.identityRevision ?? "legacy") : identityRevision()
        window.localStorage.setItem(key, JSON.stringify({ identityRevision: revision, state: value }))
      },
      // A persistent tombstone distinguishes initial empty storage from a later logout.
      clear: () => window.localStorage.setItem(key, JSON.stringify({ identityRevision: identityRevision(), state: null })),
    },
    lock: navigator.locks ? (job) => navigator.locks.request(lockName, () => job()) : undefined,
    uuid: identityRevision,
    changed: (value) => { publish(value); channel?.postMessage({ changed: true }) },
  })
  // Notifications contain no credentials; readers re-read the shared snapshot.
  const sync = () => { try { publish(coordinator!.current()) } catch { /* Keep current UI on temporary storage faults. */ } }
  window.addEventListener("storage", (event) => { if (event.key === key || event.key === null) sync() })
  if (channel) channel.onmessage = sync
  return coordinator
}
export function subscribeWebAuth(listener: (value: WebAuthSession | null) => void) {
  webAuth(); listeners.add(listener); return () => { listeners.delete(listener) }
}
/** Route API-server absolute URLs through the browser's same-origin proxy. */
export function browserAuthTarget(raw: string): { url: string; trusted: boolean } {
  if (typeof window === "undefined") return { url: raw, trusted: raw.startsWith("/") && !raw.startsWith("//") }
  let target: URL
  try { target = new URL(raw, window.location.origin) } catch { return { url: raw, trusted: false } }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) return { url: raw, trusted: false }
  let apiOrigin = window.location.origin
  try { apiOrigin = new URL(process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API || window.location.origin).origin } catch { /* Invalid config cannot establish trust. */ }
  const apiPath = !webAuthNamespace || target.pathname === webAuthNamespace || target.pathname.startsWith(webAuthNamespace + "/")
  if (!apiPath || (target.origin !== window.location.origin && target.origin !== apiOrigin)) return { url: raw, trusted: false }
  return { url: window.location.origin + target.pathname + target.search, trusted: true }
}
export async function browserAuthenticatedFetch(raw: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const target = browserAuthTarget(raw)
  const action = (current?: string) => {
    init.signal?.throwIfAborted()
    const headers = new Headers(init.headers)
    if (current && target.trusted) headers.set("authorization", "Bearer " + current)
    if (!target.trusted) headers.delete("authorization")
    return fetch(target.url, { ...init, headers, credentials: target.trusted ? "include" : "omit", redirect: "error" })
  }
  const auth = target.trusted ? webAuth() : null
  return auth && token ? auth.execute(token, action) : action(token ?? undefined)
}
