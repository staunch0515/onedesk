import type { ErrorCode } from "./types";

/** The error type thrown by the kernel and host API. `message` is Chinese and user-facing. */
export class OneDeskError extends Error {
  readonly code: ErrorCode;
  /** Per-field messages for `validation` errors. */
  readonly fields?: Record<string, string>;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, options?: { fields?: Record<string, string>; hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OneDeskError";
    this.code = code;
    this.fields = options?.fields;
    this.hint = options?.hint;
  }
}

export function isOneDeskError(e: unknown): e is OneDeskError {
  return e instanceof Error && e.name === "OneDeskError" && "code" in e;
}
