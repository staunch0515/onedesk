/**
 * Shared implementation of Platform.network.fetch on top of a fetch-compatible function (D59):
 * http/https only; non-2xx statuses resolve; network failures and timeouts (default 30 s) reject with
 * OneDeskError("unavailable"); header names lower-cased, repeated headers joined with ", "; body as UTF-8 text.
 */
import { OneDeskError } from "../plugin-api";
import type { NetworkRequestInit, NetworkResponse } from "../plugin-api";

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; statusText: string; headers: { forEach(callback: (value: string, name: string) => void): void }; text(): Promise<string> }>;

export const DEFAULT_TIMEOUT_MS = 30_000;

export async function performFetch(fetchImpl: FetchLike, url: string, init: NetworkRequestInit = {}): Promise<NetworkResponse> {
  if (!/^https?:\/\//i.test(url)) throw new OneDeskError("permission", "只能请求 http 或 https 地址");
  if (init.signal?.aborted) throw new OneDeskError("unavailable", "请求已取消");
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  init.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const started = performance.now();
  try {
    const request: Parameters<FetchLike>[1] = { method: init.method ?? "GET", signal: controller.signal };
    if (init.headers) request.headers = init.headers;
    if (init.body !== undefined) request.body = init.body;
    const response = await fetchImpl(url, request);
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      const key = name.toLowerCase();
      headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
    });
    return { status: response.status, statusText: response.statusText, headers, body, durationMs: Math.round(performance.now() - started) };
  } catch (e) {
    if (timedOut) throw new OneDeskError("unavailable", `请求超时（超过 ${Math.round(timeoutMs / 100) / 10} 秒）`, { hint: "检查网络或地址后重试", cause: e });
    if (init.signal?.aborted) throw new OneDeskError("unavailable", "请求已取消", { cause: e });
    throw new OneDeskError("unavailable", `网络请求失败：${e instanceof Error ? e.message : String(e)}`, { hint: "检查网络或地址后重试", cause: e });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** D65: only http, https and mailto may be opened outside the app. */
export function assertSafeExternalUrl(url: string): void {
  if (typeof url !== "string" || !/^(https?:\/\/|mailto:)/i.test(url)) {
    throw new OneDeskError("validation", "只能打开 http、https、mailto 链接");
  }
}
