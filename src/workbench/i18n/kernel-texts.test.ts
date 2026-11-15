import { describe, expect, it } from "vitest";
import { AUDIT_OPERATIONS, KERNEL_ERRORS, KERNEL_LABELS } from "./kernel-texts";

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
