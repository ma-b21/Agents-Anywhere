/** Safe for Renderer/IPC: never contains the long-lived refresh credential. */
export type DesktopAuthSession = {
  serverUrl: string;
  accessToken: string;
  userId: string;
  role: "admin" | "member";
  loginGeneration: string;
  sessionId?: string;
  credentialVersion: number;
};
