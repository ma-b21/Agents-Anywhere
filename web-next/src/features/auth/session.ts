import type { AuthResponse, StoredSession } from "@/features/auth/types";

const SESSION_KEY = "aa.session.v1";

export function authResponseToSession(auth: AuthResponse): StoredSession {
  return {
    accessToken: auth.accessToken,
    userId: auth.userId,
    role: auth.role,
    sessionId: auth.sessionId,
    credentialVersion: auth.credentialVersion,
  };
}

export function loadStoredSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed.accessToken || !parsed.userId || !parsed.role) return null;
    return {
      accessToken: parsed.accessToken,
      userId: parsed.userId,
      role: parsed.role,
      loginGeneration: parsed.loginGeneration,
      sessionId: parsed.sessionId,
      credentialVersion: parsed.credentialVersion,
    };
  } catch {
    return null;
  }
}

export function saveStoredSession(session: StoredSession): void {
  const { accessToken, userId, role, loginGeneration, sessionId, credentialVersion } = session;
  window.localStorage.setItem(SESSION_KEY, JSON.stringify({ accessToken, userId, role, loginGeneration, sessionId, credentialVersion }));
}

export function clearStoredSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
}
