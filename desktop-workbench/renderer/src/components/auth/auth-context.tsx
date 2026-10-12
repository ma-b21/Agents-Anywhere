"use client"
import * as React from "react"
import { authApi } from "@/features/auth/api"
import {
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
} from "@/features/auth/session"
import type { AuthMe, StoredSession } from "@/features/auth/types"
import { normalizeAuthMe, normalizeDesktopOAuthMe } from "@/features/auth/normalize-me"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import { setDesktopServerConnection } from "@/features/desktop/server-connection"
import { useTranslations } from "next-intl"

export type AuthScreen = "login" | "signed-out" | "preview" | "onboarding" | "app"

type AuthState = {
  screen: AuthScreen
  session: StoredSession | null
  me: AuthMe | null
  loading: boolean
  error: string | null
  isAuthenticated: boolean
  desktopOAuthAvailable: boolean
  emailVerificationRequired: boolean
  refreshConfig: () => Promise<void>
  navigate: (screen: AuthScreen) => void
  oauthStatus: "idle" | "opening" | "waiting"
  startDesktopOAuth: (serverUrl?: string) => Promise<void>
  clearError: () => void
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
  if (path === "login") return "login"
  if (path === "signed-out") return "signed-out"
  if (path === "preview") return "preview"
  if (path === "onboarding") return "onboarding"

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

  return isAppRoute ? "app" : "login"
}

function screenToHash(screen: AuthScreen): string {
  const map: Record<AuthScreen, string> = {
    login: "#/login",
    "signed-out": "#/signed-out",
    preview: "#/preview",
    onboarding: "#/onboarding",
    app: "#/",
  }
  return map[screen]
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("auth")
  const [screen, setScreenState] = React.useState<AuthScreen>("login")
  const [session, setSession] = React.useState<StoredSession | null>(null)
  const latestSession = React.useRef<StoredSession | null>(null)
  const [me, setMe] = React.useState<AuthMe | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [oauthStatus, setOAuthStatus] = React.useState<"idle" | "opening" | "waiting">("idle")
  const startingOAuth = React.useRef(false)
  const receivedOAuthResult = React.useRef(false)
  const [emailVerificationRequired, setEmailVerificationRequired] = React.useState(false)
  const refreshConfig = React.useCallback(async () => {
    const config = await authApi.config()
    setEmailVerificationRequired(config.emailVerificationRequired)
  }, [])
  const desktopAuthBridge = getDesktopWorkbenchBridge()?.auth ?? null

  React.useEffect(() => {
    let cancelled = false
    const bridge = getDesktopWorkbenchBridge()?.auth
    const nextScreen = hashToScreen(window.location.hash)
    let revision = 0
    const apply = (value: StoredSession | null) => {
      if (cancelled) return
      if (!value) {
        latestSession.current = null
        clearStoredSession(); setSession(null); setMe(null); setScreenState("login")
        return
      }
      try { saveStoredSession(value) } catch { /* Main's encrypted file is authoritative. */ }
      latestSession.current = value
      // Same-login renewal must not tear down every realtime effect.
      setSession((previous) => previous && previous.loginGeneration === value.loginGeneration ? previous : value)
      setMe((previous) => previous?.userId === value.userId ? previous : normalizeAuthMe(null, value))
    }
    const unsubscribe = bridge?.onSessionChanged((value) => {
      revision++
      if (value) void bridge.getServer().then(setDesktopServerConnection).catch(() => undefined)
      apply(value)
    })
    async function boot() {
      let stored: StoredSession | null = null
      const bootRevision = revision
      try {
        if (bridge) {
          setDesktopServerConnection(await bridge.getServer())
          stored = await bridge.getSession()
          if (!stored) {
            const legacy = loadStoredSession()
            // A native mirror after logout must never resurrect an old session.
            if (legacy && !legacy.loginGeneration) stored = await bridge.importLegacy(legacy)
          }
        } else stored = loadStoredSession()
        if (cancelled) return
        if (bridge && revision !== bootRevision) {
          const current = await bridge.getSession()
          if (!current || current.loginGeneration !== stored?.loginGeneration) return
          stored = current
        }
        if (!stored) {
          clearStoredSession()
          setScreenState(nextScreen === "app" ? "login" : nextScreen)
          return
        }
        apply(stored)
        setMe(normalizeAuthMe(null, stored))
        setScreenState(nextScreen === "login" ? "app" : nextScreen)
        const currentUser = normalizeAuthMe(await authApi.me(stored.accessToken), stored)
        if (cancelled) return
        const current = await bridge?.getSession()
        if (bridge && current?.loginGeneration !== stored.loginGeneration) return
        setMe(currentUser)
      } catch (err) {
        // Only Main's explicit sessionChanged(null) clears credentials. Offline,
        // IPC, encryption and disk errors leave the durable login recoverable.
        if (!cancelled) setError(err instanceof Error ? err.message : t("errors.config", { detail: "" }))
      } finally { if (!cancelled) setLoading(false) }
    }
    void boot()
    const handleHashChange = () => setScreenState(hashToScreen(window.location.hash))
    window.addEventListener("hashchange", handleHashChange)
    return () => {
      cancelled = true; unsubscribe?.()
      window.removeEventListener("hashchange", handleHashChange)
    }
  }, [])

  const navigate = React.useCallback((nextScreen: AuthScreen) => {
    window.location.hash = screenToHash(nextScreen)
    setScreenState(nextScreen)
  }, [])

  const finishDesktopOAuth = React.useCallback(async (nextSession: StoredSession) => {
    const bridge = getDesktopWorkbenchBridge()?.auth
    if ((await bridge?.getSession())?.loginGeneration !== nextSession.loginGeneration) return
    const currentUser = normalizeDesktopOAuthMe(await authApi.me(nextSession.accessToken))
    if ((await bridge?.getSession())?.loginGeneration !== nextSession.loginGeneration) return
    saveStoredSession(nextSession)
    latestSession.current = nextSession
    setSession(nextSession)
    setMe(currentUser)
    setError(null)
    // Signing in from onboarding must return to the flow, not skip it.
    if (hashToScreen(window.location.hash) === "onboarding") {
      setScreenState("onboarding")
      return
    }
    window.location.hash = "#/"
    setScreenState("app")
  }, [])

  React.useEffect(() => {
    if (!desktopAuthBridge || loading) return
    let cancelled = false
    let consuming = false

    const consumeResult = async () => {
      if (consuming) return
      consuming = true
      let received = false
      try {
        const result = await desktopAuthBridge.consumeOAuthResult()
        if (!result || cancelled) return
        received = true
        receivedOAuthResult.current = true
        if (result.status === "error") {
          setError(result.error)
          setOAuthStatus("idle")
          setScreenState("login")
          return
        }

        setDesktopServerConnection(result.server)
        setOAuthStatus("opening")
        setError(null)
        await finishDesktopOAuth(result.session)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("errors.oauth"))
          setScreenState("login")
        }
      } finally {
        consuming = false
        if (received && !cancelled) setOAuthStatus("idle")
      }
    }

    const unsubscribe = desktopAuthBridge.onOAuthResult(() => void consumeResult())
    void consumeResult()
    return () => {
      cancelled = true
      if (typeof unsubscribe === "function") unsubscribe()
    }
  }, [desktopAuthBridge, finishDesktopOAuth, loading, t])

  // A plugin deep link that arrives while the app is already running must start
  // a new flow instead of being ignored by the current screen.
  const onboardingBridge = getDesktopWorkbenchBridge()?.onboarding
  React.useEffect(() => {
    if (!onboardingBridge?.onOpen) return
    const unsubscribe = onboardingBridge.onOpen((entry) => {
      window.location.hash = entry.route.replace(/^\//, "")
      setScreenState("onboarding")
    })
    return () => { if (typeof unsubscribe === "function") unsubscribe() }
  }, [onboardingBridge])

  const startDesktopOAuth = React.useCallback(async (serverUrl?: string) => {
    if (!desktopAuthBridge || startingOAuth.current) return
    startingOAuth.current = true
    receivedOAuthResult.current = false
    setOAuthStatus("opening")
    setError(null)
    try {
      const result = await desktopAuthBridge.startOAuth(serverUrl === undefined ? undefined : { serverUrl })
      if (result.status === "error") {
        setError(t(`errors.${result.code}`))
        setOAuthStatus("idle")
        return
      }
      if (!receivedOAuthResult.current) setOAuthStatus("waiting")
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.oauth"))
      setOAuthStatus("idle")
    } finally {
      startingOAuth.current = false
    }
  }, [desktopAuthBridge, t])

  const refreshMe = React.useCallback(async () => {
    if (!session?.accessToken) {
      setMe(null)
      return null
    }
    const currentUser = normalizeAuthMe(await authApi.me(session.accessToken), session)
    if (desktopAuthBridge && (await desktopAuthBridge.getSession())?.loginGeneration !== session.loginGeneration) return null
    setMe(currentUser)
    return currentUser
  }, [session])

  const signOut = React.useCallback(() => {
    void (async () => {
      if (desktopAuthBridge && !await desktopAuthBridge.signOut(session?.loginGeneration ?? null)) return
      if (latestSession.current && latestSession.current.loginGeneration !== session?.loginGeneration) return
      latestSession.current = null
    clearStoredSession()
    setSession(null)
    setMe(null)
    window.location.hash = "#/signed-out"
    setScreenState("signed-out")
    })().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [desktopAuthBridge, session?.loginGeneration])

  return (
    <AuthContext.Provider
      value={{
        screen,
        session,
        me,
        loading,
        error,
        isAuthenticated: Boolean(session),
        desktopOAuthAvailable: Boolean(desktopAuthBridge),
        emailVerificationRequired,
        refreshConfig,
        navigate,
        startDesktopOAuth,
        oauthStatus,
        clearError: () => setError(null),
        refreshMe,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
