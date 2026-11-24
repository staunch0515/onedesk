import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// D476: everything in a resource tree is a resource the user files where they like (D466): every kind a plugin puts
// in `resources` can be dragged into another group. Built-in and external plugins alike.
const dirs = ["../", "../../plugins-external/"].map((p) => new URL(p, import.meta.url));
const manifests = dirs.flatMap((root) =>
  readdirSync(root)
    .filter((d) => !d.startsWith("._") && !d.startsWith("_") && existsSync(new URL(`${d}/manifest.json`, root)))
    .map((d) => JSON.parse(readFileSync(new URL(`${d}/manifest.json`, root), "utf8"))),
);

describe("kinds in a resource tree (D476)", () => {
  it("can all be dragged", () => {
    const kinds = manifests.flatMap((m) => (m.contributes?.kinds ?? []).filter((k: { tree?: string }) => k.tree === "resources").map((k: { id: string; draggable?: boolean }) => ({ id: `${m.id}:${k.id}`, draggable: k.draggable })));
    expect(kinds.length).toBeGreaterThan(10);
    expect(kinds.filter((k) => k.draggable !== true).map((k) => k.id)).toEqual([]);
  });
});
