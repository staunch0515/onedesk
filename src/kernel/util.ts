/** Small shared helpers for kernel modules. */
import type { z } from "zod";
import { OneDeskError, isOneDeskError } from "../plugin-api";
import type { ErrorCode } from "../plugin-api";

/** Everything kernel modules need from the outside world besides the database. */
export interface Runtime {
  now(): Date;
  randomId(): string;
}

/** Zod issues as one Chinese sentence: `字段路径：原因；…`. */
export function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}：${issue.message}` : issue.message;
    })
    .join("；");
}

/** Zod issues keyed by their first path segment (for per-field form errors). */
export function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : "_";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return "未知错误";
}

/** Converts anything thrown into the `{ code, message, hint }` shape used by ActionResult. */
export function toErrorInfo(e: unknown, fallback: ErrorCode = "internal"): { code: ErrorCode; message: string; hint?: string } {
  if (isOneDeskError(e)) return e.hint === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, hint: e.hint };
  return { code: fallback, message: errorMessage(e) };
}

export function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function notFound(what: string): OneDeskError {
  return new OneDeskError("not_found", `${what}不存在`);
}
