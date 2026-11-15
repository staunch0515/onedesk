import type { ViewField } from "../protocol";

/**
 * The run parameters to send. A value shown from the environment is a placeholder, not something the
 * user entered: on kernel pages only what was filled in on this tab goes out (the plugin reads the
 * environment itself with `host.params.get`). Demo pages keep sending the displayed value.
 */
export function runParams(fields: ViewField[], entered: Record<string, string>, kernelPage: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const value = entered[f.name] ?? "";
    if (kernelPage) {
      if (value !== "") out[f.name] = value;
    } else out[f.name] = value || f.envValue || "";
  }
  return out;
}
