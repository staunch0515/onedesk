import type { ErrorCode } from "./generated";

/** A kernel answer that is an error: `code` + `params`, never text (§11); the shell words it by code. */
export class KernelError extends Error {
  readonly code: ErrorCode;
  readonly params: Record<string, string>;
  readonly detail?: string;
  constructor(code: ErrorCode, params: Record<string, string> = {}, detail?: string) {
    super(detail ?? code);
    this.name = "KernelError";
    this.code = code;
    this.params = params;
    this.detail = detail;
  }
}

/** Turns whatever a transport rejected with (an Error, or the plain `{code, params}` object Tauri gives) into a KernelError. */
export function toKernelError(error: unknown): KernelError {
  if (error instanceof KernelError) return error;
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    const e = error as { code: ErrorCode; params?: Record<string, string>; detail?: string };
    return new KernelError(e.code, e.params ?? {}, e.detail);
  }
  return new KernelError("internal", {}, error instanceof Error ? error.message : String(error));
}

/** The error code when `error` came from the kernel (or the main process), else undefined. */
export function kernelErrorCode(error: unknown): { code: ErrorCode; params: Record<string, string> } | undefined {
  if (error instanceof KernelError) return { code: error.code, params: error.params };
  // A `ProtocolError` that arrived as data (for example `InstallPreview.problem`).
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    const e = error as { code: ErrorCode; params?: Record<string, string> };
    return { code: e.code, params: e.params ?? {} };
  }
  return undefined;
}
