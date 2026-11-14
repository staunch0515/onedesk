import { describe, expect, it } from "vitest";
import { ManifestSchema } from "@onedesk/plugin-api";
import { builtinPluginSources } from "./index";

describe("builtinPluginSources", () => {
  it("lists the four built-ins with valid manifests and loadable modules", async () => {
    const sources = builtinPluginSources();
    expect(sources.map((s) => ManifestSchema.parse(s.manifest).id).sort()).toEqual([
      "org.onedesk.http-request",
      "org.onedesk.link",
      "org.onedesk.note",
      "org.onedesk.prompt",
    ]);
    for (const s of sources) {
      expect(s.origin).toBe("builtin");
      expect(typeof (await s.load()).activate).toBe("function");
    }
  });
});
