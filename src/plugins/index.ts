import type { PluginSource } from "../kernel/contracts";
import httpRequestManifest from "./http-request/manifest.json";
import linkManifest from "./link/manifest.json";
import noteManifest from "./note/manifest.json";
import promptManifest from "./prompt/manifest.json";

/** The built-in plugins, described exactly like external ones (D01). Modules load lazily. */
export function builtinPluginSources(): PluginSource[] {
  return [
    {
      origin: "builtin",
      location: "src/plugins/link",
      manifest: linkManifest,
      load: () => import("./link/index").then((m) => m.default),
    },
    {
      origin: "builtin",
      location: "src/plugins/note",
      manifest: noteManifest,
      load: () => import("./note/index").then((m) => m.default),
    },
    {
      origin: "builtin",
      location: "src/plugins/prompt",
      manifest: promptManifest,
      load: () => import("./prompt/index").then((m) => m.default),
    },
    {
      origin: "builtin",
      location: "src/plugins/http-request",
      manifest: httpRequestManifest,
      load: () => import("./http-request/index").then((m) => m.default),
    },
  ];
}
