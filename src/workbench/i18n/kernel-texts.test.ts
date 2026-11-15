import { describe, expect, it } from "vitest";
import { AUDIT_OPERATIONS, KERNEL_CONFIRMS, KERNEL_ERRORS, KERNEL_LABELS } from "./kernel-texts";

describe("kernel texts", () => {
  it("has a Chinese word for every English one", () => {
    expect(Object.keys(KERNEL_ERRORS["zh-CN"]).sort()).toEqual(Object.keys(KERNEL_ERRORS["en-US"]).sort());
    expect(Object.keys(KERNEL_LABELS["zh-CN"]).sort()).toEqual(Object.keys(KERNEL_LABELS["en-US"]).sort());
  });

  it("covers every error code of the protocol", async () => {
    const { readFileSync } = await import("node:fs");
    const rust = readFileSync("crates/protocol/src/lib.rs", "utf8");
    const body = rust.slice(rust.indexOf("pub enum ErrorCode"), rust.indexOf("}", rust.indexOf("pub enum ErrorCode")));
    const codes = [...body.matchAll(/^\s{4}([A-Z]\w+),/gm)].map((m) => m[1]!.charAt(0).toLowerCase() + m[1]!.slice(1));
    expect(codes.length).toBeGreaterThan(8);
    for (const code of codes) expect(KERNEL_ERRORS["en-US"][code], code).toBeTruthy();
  });

  it("words audit operations in both languages", () => {
    expect(Object.keys(AUDIT_OPERATIONS["zh-CN"]).sort()).toEqual(Object.keys(AUDIT_OPERATIONS["en-US"]).sort());
  });
});

describe("every key the kernel emits has words", () => {
  const sources = async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    return readdirSync("crates/kernel/src")
      .filter((f) => f.endsWith(".rs"))
      .map((f) => readFileSync(`crates/kernel/src/${f}`, "utf8"))
      .join("\n")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  };
  const locales = ["en-US", "zh-CN"] as const;

  // The kernel's own commands, trees, types and confirm messages (D262).
  const LABELS = ["node.open", "node.rename", "node.newGroup", "node.delete", "node.favorite", "node.unfavorite", "env.newChild", "config.newChild", "deleted.restore", "deleted.purge", "open.audit", "open.deleted", "plugin.grantFolder", "deleted.purge.confirm", "resources", "env", "config", "favorites", "deleted", "core:group", "core:env", "core:config", "core:audit", "core:deleted"];
  // Operation names written to the audit log (`params.unset/acknowledge` are built from the command name).
  const OPERATIONS = ["resource.create", "resource.update", "resource.delete", "resource.restore", "resource.undelete", "resource.purge", "resource.move", "params.set", "params.unset", "params.acknowledge", "workspace.setConfig", "workspace.startup", "tree.move", "file.write", "plugin.grantFolder"];

  it("has English and Chinese for each command, tree, type and confirm key", () => {
    for (const l of locales) for (const key of LABELS) expect(KERNEL_LABELS[l][key], `${l} ${key}`).toBeTruthy();
  });

  it("has English and Chinese for each audit operation", () => {
    for (const l of locales) for (const op of OPERATIONS) expect(AUDIT_OPERATIONS[l][op], `${l} ${op}`).toBeTruthy();
  });

  it("has a title and a confirm button for the purge confirmation", () => {
    for (const l of locales) expect(KERNEL_CONFIRMS[l]["deleted.purge.confirm"]).toMatchObject({ title: expect.any(String), ok: expect.any(String) });
    expect(KERNEL_LABELS["zh-CN"]["deleted.purge.confirm"]).toMatch(/不可撤销/);
    expect(KERNEL_LABELS["zh-CN"]["deleted.purge.confirm"]).toMatch(/backups/);
  });

  it("notices a new key in the kernel sources that has no words yet", async () => {
    const src = await sources();
    const commandKeys = new Set([...src.matchAll(/"((?:node|env|config|deleted|open)\.[A-Za-z.]+)"/g)].map((m) => m[1]!));
    for (const key of commandKeys) expect(LABELS, `kernel emits "${key}": add words to kernel-texts.ts and this list`).toContain(key);
    const ignored = new Set(["resource.meta", "workspace.json", "workspace.db"]);
    const opKeys = new Set([...src.matchAll(/"((?:resource|params|workspace)\.[A-Za-z]+)"/g)].map((m) => m[1]!));
    for (const key of opKeys) if (!ignored.has(key)) expect(OPERATIONS, `kernel emits "${key}": add an audit operation name and this list`).toContain(key);
  });

  it("has words for every error reason the kernel gives", async () => {
    const src = await sources();
    const reasons = new Set([...src.matchAll(/"reason",\s*"([A-Za-z]+)"/g)].map((m) => m[1]!));
    for (const extra of ["tooLarge", "notText", "secretUnsupported", "duplicateName"]) reasons.add(extra);
    for (const l of locales) {
      const table = KERNEL_ERRORS[l];
      for (const r of reasons) expect(Object.keys(table).some((k) => k === `reason.${r}` || k.endsWith(`.${r}`)), `${l} reason ${r}`).toBe(true);
    }
  });
});
