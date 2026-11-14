/** Public entry for plugins. Plugins must import only from here (`@onedesk/plugin-api`). */
export * from "./schemas";
export * from "./types";
export * from "./placeholders";

import type { PluginModule } from "./types";

/** Identity helper for type inference: `export default definePlugin({ activate(host) {...} })`. */
export function definePlugin(module: PluginModule): PluginModule {
  return module;
}
