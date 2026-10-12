"use client"

import * as React from "react"
import { authApi } from "@/features/auth/api"
import {
  authResponseToSession,
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
} from "@/features/auth/session"
import type { AuthMe, OAuthFinalizePayload, StoredSession } from "@/features/auth/types"
import { useTranslations } from "next-intl"
import { authFlowHash, clearAuthFlow, rememberAuthFlow, takeAuthFlow } from "@/features/auth/continuation"
import { subscribeWebAuth, webAuth } from "@/features/auth/web-auth-runtime"
import { WebAuthHttpError, WebLoginChanged } from "@/features/auth/web-auth-coordinator"

export type AuthScreen =
  | "bootstrap"
  | "login"
  | "register"
  | "signed-out"
  | "oauth-new-user"
  | "oauth-link-existing"
  | "mobile-oauth"
  | "desktop-oauth"
  | "plugin-oauth"
  | "onboarding"
  | "preview"
  | "app"

export type OAuthPending = {
  status: "authenticated" | "needs_password" | "needs_registration"
  pendingToken: string
  email: string
  displayName: string
}

type AuthState = {
  screen: AuthScreen
  needsBootstrap: boolean
  session: StoredSession | null
  me: AuthMe | null
  loading: boolean
  error: string | null
  isAuthenticated: boolean
  oauthEnabled: boolean
  oauthProviderLabel: string | null
  oauthPending: OAuthPending | null
  emailVerificationRequired: boolean
  refreshConfig: () => Promise<void>
  registrationOpen: boolean
  navigate: (screen: AuthScreen) => void
  login: (input: { email: string; password: string }) => Promise<void>
  register: (input: { email: string; displayName: string; password: string; code?: string; setupToken?: string }) => Promise<void>
  startOAuth: () => Promise<void>
  finalizeOAuth: (input: { email?: string; displayName?: string; code?: string; password?: string; setPassword?: boolean }) => Promise<void>
  cancelOAuth: () => void
  refreshMe: () => Promise<AuthMe | null>
  signOut: () => void
}

const AuthContext = React.createContext<AuthState | null>(null)

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}

function hashToScreen(hash: string): AuthScreen {
  const path = hash.replace(/^#\/?/, "").split("?")[0] ?? ""
  const exactMap: Record<string, AuthScreen> = {
    login: "login",
    register: "register",
    "signed-out": "signed-out",
    "oauth/new": "oauth-new-user",
    "oauth/link": "oauth-link-existing",
    "mobile-oauth": "mobile-oauth",
    "desktop-oauth": "desktop-oauth",
    "plugin-oauth": "plugin-oauth",
    onboarding: "onboarding",
    preview: "preview",
  }
  if (exactMap[path]) return exactMap[path]

  // Any app sub-route -> app. Default bare hash "/" is also app.
  const isAppRoute =
    path === "" ||
    path === "app" ||
    path.startsWith("session/") ||
    path.startsWith("new-session/") ||
    path.startsWith("settings") ||
    path === "dashboard" ||
    path === "team" ||
    path === "service" ||
    path === "mobile-connections" ||
    path.startsWith("device")

  if (isAppRoute) return "app"

  return "login"
}

function screenToHash(s: AuthScreen): string {
  const map: Record<AuthScreen, string> = {
    bootstrap: "#/bootstrap",
    login: "#/login",
    register: "#/register",
    "signed-out": "#/signed-out",
    "oauth-new-user": "#/oauth/new",
    "oauth-link-existing": "#/oauth/link",
    "mobile-oauth": "#/mobile-oauth",
    "desktop-oauth": "#/desktop-oauth",
    "plugin-oauth": "#/plugin-oauth",
    onboarding: "#/onboarding",
    preview: "#/preview",
    app: "#/",
  }
  return map[s] ?? "#/login"
}

function readOAuthPendingFromUrl(): OAuthPending | null {
  const params = new URLSearchParams(window.location.search)
  const pendingToken = params.get("oauth_pending")
  const status = params.get("oauth_status") as OAuthPending["status"] | null
  if (!pendingToken || !status) return null
  if (status !== "authenticated" && status !== "needs_password" && status !== "needs_registration") return null
  return {
    status,
    pendingToken,
    email: params.get("oauth_email") ?? "",
    displayName: params.get("oauth_display_name") ?? "",
  }
}

function readOAuthErrorFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("oauth_error")
}

function clearOAuthQueryParams() {
  const url = new URL(window.location.href)
  const hadOAuthParams =
    url.searchParams.has("oauth_pending") ||
    url.searchParams.has("oauth_status") ||
    url.searchParams.has("oauth_user") ||
    url.searchParams.has("oauth_email") ||
    url.searchParams.has("oauth_display_name") ||
    url.searchParams.has("oauth_error")
  if (!hadOAuthParams) return
  url.searchParams.delete("oauth_pending")
  url.searchParams.delete("oauth_status")
  url.searchParams.delete("oauth_user")
  url.searchParams.delete("oauth_email")
  url.searchParams.delete("oauth_display_name")
  url.searchParams.delete("oauth_error")
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`)
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("auth")
  // Start with "login" for safe SSR, then immediately correct from hash on mount.
  const [screen, setScreenState] = React.useState<AuthScreen>("login")
  const [session, setSession] = React.useState<StoredSession | null>(null)
  const latestSession = React.useRef<StoredSession | null>(null)
  const [me, setMe] = React.useState<AuthMe | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [oauthEnabled, setOauthEnabled] = React.useState(false)
  const [oauthProviderLabel, setOauthProviderLabel] = React.useState<string | null>(null)
  const [oauthPending, setOauthPending] = React.useState<OAuthPending | null>(null)
  const [emailVerificationRequired, setEmailVerificationRequired] = React.useState(false)
  const refreshConfig = React.useCallback(async () => {
    const config = await authApi.config()
    setEmailVerificationRequired(config.emailVerificationRequired)
    setRegistrationOpen(config.registrationOpen)
    setOauthEnabled(config.oauthEnabled)
    setOauthProviderLabel(config.oauthProviderLabel)
  }, [])
  const [registrationOpen, setRegistrationOpen] = React.useState(false)

  // On mount: set screen from the current hash, then listen for changes.
  React.useEffect(() => {
    let cancelled = false
    let stored = loadStoredSession()
    const apply = (value: StoredSession | null) => {
      if (cancelled) return
      latestSession.current = value
      if (!value) {
        clearStoredSession(); setSession(null); setMe(null)
        setScreenState(authFlowHash(window.location.hash) ? hashToScreen(window.location.hash) : "login")
        return
      }
      try { saveStoredSession(value) } catch { /* Cookie and coordinated cache remain authoritative. */ }
      setSession((previous) => previous && previous.loginGeneration === value.loginGeneration ? previous : value)
      setMe((previous) => previous?.userId === value.userId ? previous : {
        userId: value.userId, role: value.role, email: null, emailVerified: false, displayName: "", disabled: false, avatar: null, serverTime: "",
      })
    }
    const unsubscribe = subscribeWebAuth(apply)
    const nextScreen = hashToScreen(window.location.hash)
    const initialOAuthPending = readOAuthPendingFromUrl()
    const initialOAuthError = readOAuthErrorFromUrl()
    clearOAuthQueryParams()

    async function boot() {
      if (initialOAuthError && !cancelled) {
        setError(initialOAuthError)
      }
      try {
        const config = await authApi.config()
        if (!cancelled) {
          setOauthEnabled(config.oauthEnabled)
          setOauthProviderLabel(config.oauthProviderLabel)
          setRegistrationOpen(config.registrationOpen)
          setEmailVerificationRequired(config.emailVerificationRequired)
        }
        if (config.needsBootstrap && !cancelled) {
          setScreenState("bootstrap")
          setLoading(false)
          return
        }
      } catch {
        // Server unreachable — fall through to normal auth flow.
      }
      try {
        stored = await webAuth()?.restore(stored) ?? null
      } catch (err) {
        let current: StoredSession | null | undefined
        try { current = webAuth()?.current() } catch { /* A cache read fault must not become an unhandled boot rejection. */ }
        const explicitlyEnded = err instanceof WebLoginChanged || (err instanceof WebAuthHttpError && err.status === 401)
        stored = current ?? (!explicitlyEnded && !stored?.loginGeneration ? stored : null)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
      if (initialOAuthPending) {
        setOauthPending(initialOAuthPending)
        if (!cancelled) {
          setScreenState(initialOAuthPending.status === "needs_registration" ? "oauth-new-user" : "oauth-link-existing")
          setLoading(false)
        }
        return
      }
      if (!stored) {
        if (!cancelled) {
          setScreenState(nextScreen === "app" ? "login" : nextScreen)
          setLoading(false)
        }
        return
      }
      if (cancelled) return
      let authority: StoredSession | null | undefined
      try { authority = webAuth()?.current() } catch (err) {
        setError(err instanceof Error ? err.message : String(err)); setLoading(false); return
      }
      if (authority?.loginGeneration && authority.loginGeneration !== stored.loginGeneration) { setLoading(false); return }
      apply(stored)
      setScreenState(nextScreen === "login" || nextScreen === "register" ? "app" : nextScreen)
      try {
        const currentUser = await authApi.me(stored.accessToken)
        if (cancelled) return
        if (latestSession.current?.loginGeneration !== stored.loginGeneration) return
        setMe(currentUser)
        setScreenState(nextScreen === "login" || nextScreen === "register" ? "app" : nextScreen)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void boot()
    const handler = () => setScreenState(hashToScreen(window.location.hash))
    window.addEventListener("hashchange", handler)
    return () => {
      cancelled = true
      unsubscribe()
      window.removeEventListener("hashchange", handler)
    }
  }, [])

  const navigate = React.useCallback((s: AuthScreen) => {
    if (s === "login" || s === "register" || s === "oauth-new-user" || s === "oauth-link-existing") {
      rememberAuthFlow(window.location.hash, window.sessionStorage)
    }
    window.location.hash = screenToHash(s)
    if (s === "login") setOauthPending(null)
    setScreenState(s)
  }, [])

  React.useEffect(() => {
    let active = true
    const resume = () => {
      if (!active || document.visibilityState === "hidden") return
      // Reconcile Cookie identity as well as TTL, including an interrupted login.
      void webAuth()?.restore(loadStoredSession()).catch(() => undefined)
    }
    const timer = setInterval(resume, 30_000)
    window.addEventListener("online", resume)
    document.addEventListener("visibilitychange", resume)
    return () => { active = false; clearInterval(timer); window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume) }
  }, [])

  const finishAuth = React.useCallback(async (auth: Parameters<typeof authResponseToSession>[0]) => {
    const coordinated = webAuth()?.current()
    if (coordinated && (coordinated.userId !== auth.userId || (auth.sessionId && coordinated.sessionId !== auth.sessionId))) throw new WebLoginChanged()
    const nextSession = coordinated ?? authResponseToSession(auth)
    saveStoredSession(nextSession)
    latestSession.current = nextSession
    setSession(nextSession)
    const currentUser = await authApi.me(nextSession.accessToken)
    if (latestSession.current?.loginGeneration !== nextSession.loginGeneration) return
    setMe(currentUser)
    setError(null)
    setOauthPending(null)
    const continuation = takeAuthFlow(window.location.hash, window.sessionStorage)
    if (continuation) {
      window.location.hash = continuation
      setScreenState(hashToScreen(continuation))
      return
    }
    window.location.hash = "#/"
    setScreenState("app")
  }, [])

  React.useEffect(() => {
    if (!oauthPending || oauthPending.status !== "authenticated") return
    let cancelled = false
    const pendingToken = oauthPending.pendingToken
    async function finalizeAuthenticatedOAuth() {
      setLoading(true)
      setError(null)
      try {
        const result = await authApi.finalizeOAuth({ pendingToken })
        if (!cancelled) await finishAuth(result.auth)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("errors.oauth"))
          setOauthPending(null)
          setScreenState("login")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void finalizeAuthenticatedOAuth()
    return () => {
      cancelled = true
    }
  }, [finishAuth, oauthPending, t])

  const login = React.useCallback(
    async (input: { email: string; password: string }) => {
      setLoading(true)
      setError(null)
      try {
        await finishAuth(await authApi.login(input))
      } catch (err) {
        setError(err instanceof Error ? err.message : t("errors.loginFailed"))
        throw err
      } finally {
        setLoading(false)
      }
    },
    [finishAuth, t],
  )

  const register = React.useCallback(
    async (input: { email: string; displayName: string; password: string; code?: string; setupToken?: string }) => {
      setLoading(true)
      setError(null)
      try {
        await finishAuth(await authApi.register(input))
      } catch (err) {
        setError(err instanceof Error ? err.message : t("errors.registerFailed"))
        throw err
      } finally {
        setLoading(false)
      }
    },
    [finishAuth, t],
  )

  const startOAuth = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await authApi.startOAuth(window.location.href)
      window.location.assign(result.authorizeUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.oauth"))
      setLoading(false)
      throw err
    }
  }, [t])

  const finalizeOAuth = React.useCallback(
    async (input: { email?: string; displayName?: string; code?: string; password?: string; setPassword?: boolean }) => {
      if (!oauthPending) return
      setLoading(true)
      setError(null)
      try {
        const payload: OAuthFinalizePayload = {
          pendingToken: oauthPending.pendingToken,
          email: input.email?.trim().toLowerCase() || undefined,
          displayName: input.displayName?.trim() || undefined,
          code: input.code || undefined,
          password: input.password || undefined,
          setPassword: Boolean(input.setPassword),
        }
        const result = await authApi.finalizeOAuth(payload)
        await finishAuth(result.auth)
      } catch (err) {
        setError(err instanceof Error ? err.message : t("errors.oauth"))
        throw err
      } finally {
        setLoading(false)
      }
    },
    [finishAuth, oauthPending, t],
  )

  const cancelOAuth = React.useCallback(() => {
    setOauthPending(null)
    setError(null)
    rememberAuthFlow(window.location.hash, window.sessionStorage)
    window.location.hash = "#/login"
    setScreenState("login")
  }, [])

  const refreshMe = React.useCallback(async () => {
    if (!session?.accessToken) {
      setMe(null)
      return null
    }
    const currentUser = await authApi.me(session.accessToken)
    if (latestSession.current?.loginGeneration !== session.loginGeneration) return null
    setMe(currentUser)
    return currentUser
  }, [session?.accessToken])

  const signOut = React.useCallback(() => {
    const requested = session?.loginGeneration
    void (async () => {
    if (requested && !await webAuth()?.signOut(requested)) return
    if (latestSession.current && latestSession.current.loginGeneration !== requested) return
    latestSession.current = null
    clearAuthFlow(window.sessionStorage)
    clearStoredSession()
    setSession(null)
    setMe(null)
    setOauthPending(null)
    window.location.hash = "#/signed-out"
    setScreenState("signed-out")
    })().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [session?.loginGeneration])

  return (
    <AuthContext.Provider
      value={{
        screen,
        needsBootstrap: screen === "bootstrap",
        session,
        me,
        loading,
        error,
        isAuthenticated: Boolean(session),
        oauthEnabled,
        oauthProviderLabel,
        oauthPending,
        registrationOpen,
        emailVerificationRequired,
        refreshConfig,
        navigate,

        login,
        register,
        startOAuth,
        finalizeOAuth,
        cancelOAuth,
        refreshMe,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
