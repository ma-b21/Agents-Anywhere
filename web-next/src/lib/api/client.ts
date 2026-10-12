import {
  ApiError,
  apiErrorKind,
  extractErrorPayload
} from "@/lib/api/errors";
import { browserAuthTarget, webAuth } from "@/features/auth/web-auth-runtime";
import { WebAuthHttpError, WebLoginChanged } from "@/features/auth/web-auth-coordinator";

export type ApiTokenProvider = () => string | null | undefined;

export type ApiClientOptions = {
  baseUrl?: string;
  getToken?: ApiTokenProvider;
  fetcher?: typeof fetch;
};

export type ApiRequestOptions = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
  token?: string | null;
  auth?: boolean;
  browserIdentity?: boolean;
  query?: Record<string, string | number | boolean | null | undefined>;
};

export const API_NAMESPACE = normalizeApiNamespace(process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API_NAMESPACE ?? "/api/v2");

export function apiPath(path: string): string {
  if (path.startsWith("http")) return path;
  if (!API_NAMESPACE) return path.startsWith("/") ? path : `/${path}`;
  if (path === API_NAMESPACE || path.startsWith(`${API_NAMESPACE}/`)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_NAMESPACE}${normalized}`;
}

function normalizeApiNamespace(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken?: ApiTokenProvider;
  private readonly fetcher: typeof fetch;
  private readonly customFetcher: boolean;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.getToken = options.getToken;
    this.customFetcher = Boolean(options.fetcher);
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  get<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: options.method ?? "GET" });
  }
  signIn<T>(path: string, body: ApiRequestOptions["body"]): Promise<T> {
    return this.request<T>(path, { method: "POST", body, auth: false, browserIdentity: true });
  }

  post<T>(
    path: string,
    body?: ApiRequestOptions["body"],
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  put<T>(
    path: string,
    body?: ApiRequestOptions["body"],
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "PUT", body });
  }

  patch<T>(
    path: string,
    body?: ApiRequestOptions["body"],
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "PATCH", body });
  }

  delete<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE" });
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const rawUrl = this.buildUrl(path, options.query);
    const target = browserAuthTarget(rawUrl);
    const url = this.customFetcher ? rawUrl : target.url;
    const headers = new Headers(options.headers);
    const body = normalizeBody(options.body);
    if (body != null && !headers.has("content-type") && isJsonBody(options.body)) {
      headers.set("content-type", "application/json");
    }
    headers.set("accept", headers.get("accept") ?? "application/json");

    const token = options.token ?? (options.auth === false ? null : this.getToken?.());
    const trusted = target.trusted || (this.customFetcher && (!/^https?:/.test(rawUrl) || Boolean(this.baseUrl && rawUrl.startsWith(this.baseUrl + "/"))));
    if (token && trusted) headers.set("authorization", `Bearer ${token}`);
    if (!trusted) headers.delete("authorization");

    let response: Response;
    try {
      const coordinator = !this.customFetcher && target.trusted ? webAuth() : null;
      const action = (current?: string) => {
        options.signal?.throwIfAborted();
        const outgoing = new Headers(headers);
        if (current && trusted) outgoing.set("authorization", "Bearer " + current);
        return this.fetcher(url, { ...options, body, headers: outgoing, redirect: "error", credentials: trusted ? "include" : "omit" });
      };
      response = options.browserIdentity && coordinator ? await coordinator.login(path, options.body)
        : coordinator && token ? await coordinator.execute(token, action) : await action(token ?? undefined);
    } catch (error) {
      const status = error instanceof WebAuthHttpError ? error.status : error instanceof WebLoginChanged ? 409 : 0;
      throw new ApiError({
        status,
        kind: apiErrorKind(status),
        code: error instanceof WebAuthHttpError ? error.code : undefined,
        detail: error instanceof Error ? error.message : "network error",
        url
      });
    }

    if (response.status === 204) return undefined as T;

    const payload = await readPayload(response);
    if (!response.ok) {
      const normalized = extractErrorPayload(payload);
      throw new ApiError({
        status: response.status,
        kind: apiErrorKind(response.status),
        detail: normalized.detail || `HTTP ${response.status}`,
        code: normalized.code,
        payload,
        url
      });
    }

    return payload as T;
  }

  private buildUrl(
    path: string,
    query?: ApiRequestOptions["query"],
  ): string {
    const base = this.baseUrl;
    const namespacedPath = apiPath(path);
    const raw = namespacedPath.startsWith("http") ? namespacedPath : `${base}${namespacedPath}`;
    if (!query) return raw;
    const url = new URL(raw, typeof window === "undefined" ? "http://localhost" : window.location.origin);
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
    if (namespacedPath.startsWith("http") || base) return url.toString();
    return `${url.pathname}${url.search}${url.hash}`;
  }
}

export const apiClient = new ApiClient();

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeBody(body: ApiRequestOptions["body"]): BodyInit | null | undefined {
  if (body == null) return body;
  if (typeof body === "string") return body;
  if (body instanceof FormData) return body;
  if (body instanceof Blob) return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) return body;
  if (body instanceof URLSearchParams) return body;
  return JSON.stringify(body);
}

function isJsonBody(body: ApiRequestOptions["body"]): boolean {
  if (body == null) return false;
  if (typeof body === "string") return false;
  if (body instanceof FormData) return false;
  if (body instanceof Blob) return false;
  if (body instanceof ArrayBuffer) return false;
  if (ArrayBuffer.isView(body)) return false;
  if (body instanceof URLSearchParams) return false;
  return true;
}
