import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import type { Kernel, KernelEvent } from "../kernel/contracts";

/** A counter that increases whenever one of the given kernel events fires (use it as an effect dependency). */
export function useKernelTick(kernel: Kernel, types: Array<KernelEvent["type"]>): number {
  const [tick, setTick] = useState(0);
  const key = types.join(",");
  useEffect(() => {
    const wanted = new Set(key.split(","));
    return kernel.events.onAny((e) => {
      if (wanted.has(e.type)) setTick((n) => n + 1);
    });
  }, [kernel, key]);
  return tick;
}

export type AsyncState<T> =
  | { status: "loading"; data?: T; error?: undefined }
  | { status: "ready"; data: T; error?: undefined }
  | { status: "error"; data?: T; error: unknown };

/**
 * Runs `load` when deps change; keeps the previous data while reloading (no flicker on refresh).
 * Late results of superseded loads are dropped.
 */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const id = ++seq.current;
    setState((s) => (s.status === "ready" ? s : { status: "loading", data: s.data }));
    loadRef.current().then(
      (data) => {
        if (id === seq.current) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (id === seq.current) setState((s) => ({ status: "error", error, data: s.data }));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
