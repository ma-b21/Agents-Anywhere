import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DesktopAuthSnapshot, DesktopAuthStorage } from "./desktop-auth";
import { normalizeServerOrigin } from "./desktop-server";

export type DesktopCredentialCipher = { encrypt: (plain: string) => Buffer; decrypt: (cipher: Buffer) => string };
/** Main-only encrypted atomic file; disk failure never mutates a separate cache. */
export class DesktopAuthFileStore implements DesktopAuthStorage {
  constructor(private readonly file: string, private readonly cipher: DesktopCredentialCipher) {}
  read(): DesktopAuthSnapshot | null {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(this.file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const value = JSON.parse(this.cipher.decrypt(bytes)) as DesktopAuthSnapshot;
    if (!value || normalizeServerOrigin(value.serverUrl) !== value.serverUrl || !value.accessToken || !value.userId ||
        !["admin", "member"].includes(value.role) || !value.loginGeneration ||
        !Number.isSafeInteger(value.credentialVersion) || value.credentialVersion < 0 || !Number.isFinite(value.refreshAt) ||
        typeof value.apiNamespace !== "string" || !/^(?:[/][a-zA-Z0-9/_-]+)?$/.test(value.apiNamespace) ||
        (value.refreshToken && (!value.refreshToken.startsWith("aar_") || !value.sessionId))) {
      throw new Error("Invalid encrypted login snapshot.");
    }
    return value;
  }
  write(value: DesktopAuthSnapshot): void {
    const encrypted = this.cipher.encrypt(JSON.stringify(value)); // Fail closed; no plaintext fallback.
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + "." + randomUUID() + ".tmp";
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(descriptor, encrypted);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temp, this.file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  clear(): void {
    try { fs.unlinkSync(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
