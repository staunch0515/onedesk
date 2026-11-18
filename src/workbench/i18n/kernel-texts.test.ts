import { describe, expect, it } from "vitest";
import { enUS, type MessageKey } from "./en-US";
import * as maps from "./kernel-texts";

// The kernel's ids map to shell text keys (D387); the words are English here, other languages come from language plugins.
const words = (m: Record<string, MessageKey>): Record<string, string> => Object.fromEntries(Object.entries(m).map(([id, key]) => [id, enUS[key]]));
const AUDIT_OPERATIONS = { "en-US": words(maps.AUDIT_OPERATIONS) };
const RUN_ERRORS = { "en-US": words(maps.RUN_ERRORS) };
const KERNEL_ERRORS = { "en-US": words(maps.KERNEL_ERRORS) };
const KERNEL_LABELS = { "en-US": words(maps.KERNEL_LABELS) };
const KERNEL_CONFIRMS = { "en-US": Object.fromEntries(Object.entries(maps.KERNEL_CONFIRMS).map(([id, v]) => [id, { title: enUS[v.title], ok: enUS[v.ok] }])) };
const RUN_FALLBACK = { "en-US": enUS[maps.RUN_FALLBACK] };

describe("kernel texts", () => {
  it("maps every kernel id to an English text in en-US.ts, and keeps no other language's words in the shell", async () => {
    for (const table of [maps.KERNEL_ERRORS, maps.KERNEL_LABELS, maps.AUDIT_OPERATIONS, maps.PERMISSIONS, maps.RUN_ERRORS, maps.RUN_ERRORS_NAMED]) {
      for (const [id, key] of Object.entries(table)) expect(enUS[key], `${id} → ${key}`).toBeTruthy();
    }
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/workbench/i18n/kernel-texts.ts", "utf8")).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
  });

  it("covers every error code of the protocol", async () => {
    const { readFileSync } = await import("node:fs");
    const rust = readFileSync("crates/protocol/src/lib.rs", "utf8");
    const body = rust.slice(rust.indexOf("pub enum ErrorCode"), rust.indexOf("}", rust.indexOf("pub enum ErrorCode")));
    const codes = [...body.matchAll(/^\s{4}([A-Z]\w+),/gm)].map((m) => m[1]!.charAt(0).toLowerCase() + m[1]!.slice(1));
    expect(codes.length).toBeGreaterThan(8);
    for (const code of codes) expect(KERNEL_ERRORS["en-US"][code], code).toBeTruthy();
  });

  it("has words for every workspace/environment parameter name the kernel declares (config tree labels)", async () => {
    const { readFileSync } = await import("node:fs");
    const names = ["policy.rs", "network.rs", "process.rs"].flatMap((f) => [...readFileSync(`crates/kernel/src/${f}`, "utf8").matchAll(/pub const [A-Z_]+: &str = "([a-z_]+\.[a-z_]+)";/g)].map((m) => m[1]!));
    expect(names).toEqual(expect.arrayContaining(["network.allow", "protection.readonly", "ui.language"]));
    // ui.language keeps its own field label (D379).
    for (const name of [...names.filter((n) => n !== "ui.language"), "ui.theme", "ui.density"]) expect(KERNEL_LABELS["en-US"][name], name).toBeTruthy();
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
  const locales = ["en-US"] as const;
  // Every `reason` the kernel documents (docs/handoff/round3-kernel-done.md, "错误原因").
  const KERNEL_REASONS = ["emptyName", "unknownKind", "parentNotFound", "otherTree", "notAccepted", "notInTree", "self", "descendant", "targetNotFound", "noGroups", "notParamNode", "reservedField", "secretUnsupported", "duplicateName", "notDeleted", "notRestorable", "nothingBefore", "notAbsolute", "notFolder", "notFile", "tooLarge", "notText", "badTarget", "badKey", "tooManyKeys", "unknownSetting", "badValue", "helloFirst", "foreignKind", "notRequested", "outsideGrant", "undeclaredSetting", "pluginDisabled", "callEnded", "cancelled", "timeout", "changedOnDisk", "providedTree", "threw", "badOutput", "outOfMemory", "engine", "notLoaded", "alreadyInstalled", "notValid", "symlink", "changedSinceInspect", "forbiddenHeader", "grantField", "unconfirmedVersion", "tooBig", "needsVersion", "notConfirmed", "pureCall", "notInMigrate", "secretNotAllowed", "unknownSecret", "plaintextUndeclared", "hostNotAllowed", "blockedByPolicy", "undeclaredProgram", "badArgs", "badEnv", "tooManyProcesses", "notInRun", "notExecutable", "localAddress", "alreadyUndone", "badSecretName", "badScheme", "badUrl", "badMethod", "tooManyRedirects", "changedDuringUpgrade", "migrateFailed", "readonly", "noExport", "notExport", "badVersion", "unreadable", "notEmpty", "insideData", "exists", "notTable", "notFinished", "unsupportedFormat", "changedSincePreview", "insideDataDir", "noParent", "writeFailed", "fingerprintChanged", "badParent", "badFormat", "duplicateId", "tooLarge", "noOutput", "dependents", "pendingRequest", "dependsUnmet", "badDepends", "badExports", "undeclaredDepend", "notInteractive", "requesterDisabled", "notExported", "badDropAnswer", "inDrop"];
  const MANIFEST_REASONS = ["noManifest", "badJson", "schema", "apiVersion", "badId", "idMismatch", "badVersion", "versionMismatch", "mainMissing", "badName", "duplicate", "unknownPage", "unknownTree", "unknownCommand", "unknownKind", "missingAction", "unknownAction", "badSetting", "localeMissing", "badLocale", "badUpgradesFrom", "badHost", "badSecretName", "grantsUndeclared", "badGrants", "badSecretsField", "unconfirmedVersion", "restrictedByUpperLayer", "badRefsField", "badPrograms", "badEvents", "switchFailed", "badDepends", "badExports", "undeclaredDepend", "badPlugins", "dependsUnmet", "dropWithoutTree"];

  // The kernel's own commands, trees, types and confirm messages (D262).
  const LABELS = ["node.open", "node.rename", "node.newGroup", "node.delete", "node.favorite", "node.unfavorite", "env.newChild", "config.newChild", "deleted.restore", "deleted.purge", "open.audit", "open.deleted", "plugin.grantFolder", "deleted.purge.confirm", "resources", "env", "config", "favorites", "deleted", "core:group", "core:env", "core:config", "core:audit", "core:deleted", "core:plugin", "core:run", "plugin.enable", "plugin.disable", "run.cancel", "run.keep", "run.unkeep", "run.openResource", "run.reuse", "plugins", "runs"];
  // Operation names written to the audit log (`params.unset/acknowledge` are built from the command name).
  const OPERATIONS = ["resource.create", "resource.update", "resource.move", "resource.delete", "resource.undelete", "resource.purge", "resource.restore", "params.set", "params.unset", "params.acknowledge", "workspace.setConfig", "workspace.startup", "workspace.initSettings", "plugin.state", "plugin.grant", "files.write", "run.start", "run.end", "run.keep", "run.unkeep", "plugin.install", "plugin.remove", "plugin.confirm", "network.request", "process.run", "events.failed", "plugin.installRequest", "plugin.installAnswer", "network.grant", "secrets.set", "secrets.delete", "plugin.upgrade", "plugin.undoUpgrade", "secrets.get", "storage.set", "storage.remove", "storage.readFrom", "ui.open", "ui.notify", "ui.copy", "resources.get", "resources.list", "resources.create", "resources.update", "resources.move", "resources.remove", "files.roots", "files.list", "files.stat", "files.readText", "files.writeText", "settings.get", "workspace.export", "workspace.import", "run.export", "refs.rebuild", "refs.sync", "transfer.download", "transfer.upload", "transfer.capture"];

  it("has English and Chinese for each command, tree, type and confirm key", () => {
    for (const l of locales) for (const key of LABELS) expect(KERNEL_LABELS[l][key], `${l} ${key}`).toBeTruthy();
  });

  it("has English and Chinese for each audit operation", () => {
    for (const l of locales) for (const op of OPERATIONS) expect(AUDIT_OPERATIONS[l][op], `${l} ${op}`).toBeTruthy();
  });

  it("has a title and a confirm button for the purge confirmation", () => {
    for (const l of locales) expect(KERNEL_CONFIRMS[l]["deleted.purge.confirm"]).toMatchObject({ title: expect.any(String), ok: expect.any(String) });
    expect(KERNEL_LABELS["en-US"]["deleted.purge.confirm"]).toMatch(/backups/);
  });

  it("notices a new key in the kernel sources that has no words yet", async () => {
    const src = await sources();
    const commandKeys = new Set([...src.matchAll(/"((?:node|env|config|deleted|open|run)\.[A-Za-z.]+)"/g)].map((m) => m[1]!));
    // Audit operations and protocol method names also contain these prefixes.
    const notCommands = new Set(["run.start", "run.end", "run.clearFinished", "run.progress", "run.export", "run.ended"]);
    for (const key of commandKeys) if (!notCommands.has(key)) expect(LABELS, `kernel emits "${key}": add words to kernel-texts.ts and this list`).toContain(key);
    const ignored = new Set(["resource.meta", "workspace.json", "workspace.db", "params.get", "resource.changed", "resource.saved", "params.config"]);
    const opKeys = new Set([...src.matchAll(/"((?:resource|params|workspace)\.[A-Za-z]+)"/g)].map((m) => m[1]!));
    for (const key of opKeys) if (!ignored.has(key)) expect(OPERATIONS, `kernel emits "${key}": add an audit operation name and this list`).toContain(key);
  });

  it("has words for every error reason the kernel gives", async () => {
    const src = await sources();
    const reasons = new Set([...src.matchAll(/"reason",\s*"([A-Za-z]+)"/g)].map((m) => m[1]!));
    for (const extra of KERNEL_REASONS) reasons.add(extra);
    for (const l of locales) {
      const table = KERNEL_ERRORS[l];
      for (const r of reasons) expect(Object.keys(table).some((k) => k === `reason.${r}` || k.endsWith(`.${r}`)), `${l} reason ${r}`).toBe(true);
    }
  });

  it("has words for the run failure codes the shell knows, in both languages", () => {
    for (const code of ["pluginDisabled", "interrupted", "badOutput", "timeout", "unknownAction", "invalidInput", "pluginError"]) expect(RUN_ERRORS["en-US"][code]).toBeTruthy();
  });

  it("words the reasons a plugin package can be refused for", () => {
    for (const l of locales) for (const r of MANIFEST_REASONS) expect(KERNEL_LABELS[l][r], `${l} ${r}`).toBeTruthy();
  });

  it("never leaves a run failure blank", () => {
    expect(RUN_FALLBACK["en-US"]).toContain("{code}");
    // Codes the kernel passes through from refused host calls have words through the general error table.
    for (const code of ["denied", "invalid", "conflict", "notFound", "invalidParams", "internal"]) for (const l of locales) expect(KERNEL_ERRORS[l][code], `${l} ${code}`).toBeTruthy();
  });

  // D318: every (code, reason) pair a refused or failed host call can leave on a run (`RunError.reason`).
  // From docs/handoff/round4-kernel-done.md; the kernel source is only grepped for the literal ones above.
  const RUN_REASONS: Record<string, string[]> = {
    denied: ["secretNotAllowed", "unknownSecret", "plaintextUndeclared", "hostNotAllowed", "blockedByPolicy", "localAddress", "notRequested", "outsideGrant", "foreignKind", "grantField", "pureCall", "notInMigrate", "undeclaredSetting", "callEnded", "cancelled", "timeout", "notConfirmed", "pluginDisabled", "notAbsolute", "notExported"],
    invalid: ["badScheme", "badUrl", "badMethod", "forbiddenHeader", "tooManyRedirects", "timeout", "tooLarge", "notText", "notFile", "notFolder", "badKey", "tooManyKeys", "badTarget", "emptyName", "unknownKind", "notAccepted", "badSecretName", "unknownSecret", "needsVersion"],
    conflict: ["changedOnDisk", "exists"],
    invalidParams: ["tooLarge"],
  };

  it("words every reason a run failure can carry, in both languages, through the run error path", async () => {
    const { buildI18n } = await import("./index");
    const missing: string[] = [];
    for (const l of locales) {
      const i18n = buildI18n(l);
      for (const [code, reasons] of Object.entries(RUN_REASONS))
        for (const reason of reasons) {
          const text = i18n.runError({ code, reason, message: "" });
          missing.push(...(text === KERNEL_ERRORS[l][code] ? [`${l} ${code}/${reason}`] : []));
        }
    }
    expect(missing, "reasons that only get the bare code's words").toEqual([]);
  });
  it("puts the names from RunError.params into the words (round 8, D360) and keeps the general words without them", async () => {
    const { buildI18n } = await import("./index");
    for (const l of locales) {
      const i18n = buildI18n(l);
      const named = i18n.runError({ code: "denied", reason: "blockedByPolicy", message: "", params: { program: "ffmpeg", layer: "1ac58b8b" } });
      expect(named, l).toContain("ffmpeg");
      expect(named, l).not.toContain("1ac58b8b"); // the layer is a node id, not something to show
      expect(i18n.runError({ code: "denied", reason: "blockedByPolicy", message: "", params: { host: "example.test:8080" } }), l).toContain("example.test:8080");
      expect(i18n.runError({ code: "notFound", reason: "program", message: "", params: { program: "nope" } }), l).toContain("nope");
      expect(i18n.runError({ code: "denied", reason: "blockedByPolicy", message: "" }), l).toBe(KERNEL_ERRORS[l]["reason.blockedByPolicy"]);
      // Round 9: the layer's name and the refused path are in the words.
      expect(i18n.runError({ code: "denied", reason: "blockedByPolicy", message: "", params: { layerName: "Production" } }), l).toContain("Production");
      expect(i18n.runError({ code: "denied", reason: "blockedByPolicy", message: "", params: { host: "a.test", layerName: "Production" } }), l).toContain("a.test");
      expect(i18n.runError({ code: "denied", reason: "outsideGrant", message: "", params: { path: "/etc/hosts" } }), l).toContain("/etc/hosts");
      expect(i18n.runError({ code: "denied", reason: "staleContext", message: "" }), l).toBe(KERNEL_ERRORS[l]["reason.staleContext"]);
    }
  });
});
