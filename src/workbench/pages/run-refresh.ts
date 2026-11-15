import { useEffect, useRef } from "react";
import type { Run } from "../protocol";

/**
 * Calls `onEnd` once when a run started on this tab ends, however quickly: the first answer for a
 * short run may already be "success". A run the tab merely remembers (restored layout) does not count.
 * Used to ask for the page again, because a plugin may render what its last run left behind.
 */
export function useRunEndRefresh(runId: string | null | undefined, run: Run | null | undefined, onEnd: () => void): void {
  const seen = useRef(runId);
  const watching = useRef<string | null>(null);
  const callback = useRef(onEnd);
  callback.current = onEnd;
  useEffect(() => {
    if (runId !== seen.current) {
      seen.current = runId;
      watching.current = runId ?? null;
    }
  }, [runId]);
  useEffect(() => {
    if (run && watching.current === run.id && run.status !== "running") {
      watching.current = null;
      callback.current();
    }
  }, [run]);
}
