import { createContext, useContext } from "react";
import type { Kernel } from "../kernel/contracts";
import type { Resource } from "../plugin-api";
import type { ShellServices } from "./services";

/** Internal state router (D35). */
export type Route =
  | { page: "all" }
  | { page: "resource"; id: string; tab?: string }
  | { page: "collections"; id?: string }
  | { page: "plugins" }
  | { page: "settings" }
  | { page: "search"; query: string };

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** Returns a description of unsaved work (e.g. the resource name), or null when it is safe to leave. */
export type LeaveGuard = () => string | null;

export interface ShellApi {
  kernel: Kernel;
  services: ShellServices;
  route: Route;
  /** Asks first when a leave guard reports unsaved changes. Resolves false when the user stays. */
  navigate(route: Route): Promise<boolean>;
  setLeaveGuard(guard: LeaveGuard | null): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  openNewResource(preset?: { kind?: string; group?: string }): void;
  openPalette(): void;
  /** Asks for input when the action declares some, then runs it. */
  runAction(key: string, resource?: Resource): void;
  openExternal(url: string): void;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const api = useContext(ShellContext);
  if (!api) throw new Error("useShell 必须在 ShellContext 内使用");
  return api;
}

export function sameRoute(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
