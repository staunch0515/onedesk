import type { PageDescriptor } from "../protocol";
import type { TabState } from "./store";

/** The shell's own pages and the plugin page name themselves (in the interface language); background refreshes leave them alone. */
export const isSelfNamed = (target: string): boolean => target.startsWith("shell:") || target.startsWith("plugin:");

/**
 * What a resolved page tells its tab: name, icon, environment use, whether it is gone. The plugin page keeps the name it gives itself
 * (it shows the plugin's name in the interface language). One place for the page, the restore and the language/rename refreshes.
 */
export function tabFieldsFromPage(d: PageDescriptor): Pick<TabState, "icon" | "usesEnv" | "missing"> & { title?: string } {
  return { ...(d.page === "plugin" ? {} : { title: d.title }), icon: d.icon, usesEnv: d.usesEnv, missing: !d.found };
}
