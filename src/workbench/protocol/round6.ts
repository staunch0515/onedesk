/**
 * Round-6 fields the kernel adds "append only" (docs/handoff/round6-plan.md §6). The generated types only have them once the
 * kernel is merged, so the shell reads them as optional through these views; with the real types they are plain subtypes.
 */
import type { Label, PluginDetail, RefInfo } from "./types";

/** Why the automatic switch to a version failed (`PluginDetail.switchFailure`). */
export interface SwitchFailure {
  version: string;
  reason: string;
  /** Milliseconds since the epoch. */
  at: number;
}

export function switchFailureOf(p: PluginDetail): SwitchFailure | undefined {
  const f = (p as PluginDetail & { switchFailure?: SwitchFailure | null }).switchFailure;
  return f ?? undefined;
}

/** The label of the field a reference sits in (`RefInfo.fieldLabel`), if the type declares one. */
export function fieldLabelOf(r: RefInfo): Label | undefined {
  return (r as RefInfo & { fieldLabel?: Label | null }).fieldLabel ?? undefined;
}

/** `RefInfo` as the kernel will send it from round 6 on. */
export type RefInfoR6 = RefInfo & { fieldLabel?: Label };
