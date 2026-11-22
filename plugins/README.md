# OneDesk plugins

Every feature of OneDesk is a plugin. The kernel only knows **resources**, **plugins** and **views**; it never names a concrete plugin. The built-in plugins in this folder use exactly the same loading path, sandbox and host interface as plugins you install from elsewhere.

This file is the plugin author's guide. Sources of truth, in case this file and the code disagree:

| What | Where |
|---|---|
| Manifest (validated strictly) | `crates/kernel/src/manifest.rs` |
| View tree and protocol types | `crates/protocol/src/lib.rs` (TypeScript is generated into `src/workbench/protocol/generated/`) |
| Host interface | `crates/kernel/src/host.rs`, `crates/kernel/src/sandbox.rs` |
| Design and decisions | `docs/redesign/kernel-design.md`, `docs/handoff/week1-protocol.md` §6–7, `docs/decisions.md` |

Changes to the manifest format, the host interface or the protocol are decided by the coordinating session and recorded in `docs/decisions.md` (project rule 10); do not extend them from a plugin.

## 1. Package layout

```
plugins/<plugin-id>/
  manifest.json        required
  main.js              required: an ES module, default export { activate(host) }
  locales/en-US.json   required; add zh-CN.json, ja-JP.json, ... as you like
  main.test.ts         vitest, next to the source (see §10)
  README.md            optional
```

At startup the host copies every package under `plugins/` into the data directory as `plugins/<id>/<version>/` (an unchanged copy is left alone). The folder name must equal the manifest `id`, and the version folder the manifest `version`.

A plugin contains **no CSS and no TSX**. It only returns a *view tree* (§5); the shell draws it with the design system. Colours, pixel sizes and durations never appear in a plugin.

The generator skill `/new-plugin` creates a skeleton and its test.

## 2. Manifest (`manifest.json`)

Validation is strict: unknown fields, missing fields, `apiVersion` other than `"2"`, an id or version that does not match its folder, or a dangling reference all make the package **not load** (it is listed as rejected with a reason).

```jsonc
{
  "id": "org.example.notes",          // reverse-DNS style, also the folder name
  "version": "0.1.0",                 // semver, also the version folder name
  "apiVersion": "2",
  "name": "plugin.name",              // locale keys, not text
  "description": "plugin.description",
  "icon": "sticky-note",              // a lucide icon name
  "main": "main.js",
  "author": "You",                    // optional
  "license": "MIT",                   // optional
  "homepage": "https://…",            // optional
  "upgradesFrom": "<1.0.0",           // optional: versions whose data this one can take over
  "requires": { … },                  // §4 — permissions
  "depends": [ { "id": "org.onedesk.datasource", "version": "^0.1" } ],
  "exports": { "kinds": [ { "id": "source", "actions": true, "read": true } ], "actions": ["query"] },
  "implements": { "<interface>": { "actions": ["chat"], "kind": "connection" } },
  "uses": ["<interface>"],
  "activation": ["workspace.opened"], // what else activates it besides being used
  "contributes": { … }                // §3
}
```

- **Text is always a key.** `name`, `description`, every `label`, `newName`, etc. are keys into `locales/*.json`. The kernel replaces them with a multi-language label; a key with no translation is shown as the key.
- Names are qualified when seen from outside: kind `note` of `org.onedesk.note` is `org.onedesk.note:note`; trees and commands likewise. Inside a manifest refer to your own things by short name and to the kernel's by full name (`plugin.grantFolder`, `node.newGroup`, `resources`).
- `depends`: other plugins that must be installed, enabled and in the version range; otherwise this plugin stays off (its resources remain visible, greyed).
- `exports`: what *other* plugins that `depends` on you may do: read your kinds, add actions to them, call your actions with `host.actions.call`, show your trees and pages.
- `implements` / `uses`: **plugin-to-plugin interfaces**. The kernel treats an interface name as an opaque string. An implementer lists the actions it provides (and optionally the `kind` of its own resource that anchors a call); a user calls `host.interfaces.call(name, action, input, { resource })`. `uses` is a permission (`uses:<interface>`).

## 3. What a plugin contributes (`contributes`)

Everything under `contributes` is optional.

| Key | Meaning |
|---|---|
| `kinds` | Resource types. `{ id, label, icon, tree?, page?, newName?, defaults, fields, draggable, accepts, menu, children?, drop? }`. `tree: "resources"` puts it in the general tree; omit `tree` and it does not appear in a tree. `defaults` is the initial `body`. `fields` declares per-field behaviour: `{ "type": "text" \| "longtext" \| "code" \| "number" \| "boolean" \| "date" \| "datetime" \| "enum" \| "secret" \| "ref", "grants": "network", "secrets": true, "refs": true, "label": "…" }`. A `secret` field is written by the framework straight into the keychain; the plugin never sees the value. A `grants: "network"` field names the hosts the resource may reach (see §4). |
| `pages` | `{ id, actions, resultTabs, recompute, usesEnv, startup }`. `actions` are the buttons of the page (below). `resultTabs`: `{ id, type: "output" \| "history" \| "view", label, icon }`. |
| `trees` | Trees the plugin **provides** (`source: "provided"`, nodes come from your `children`/`path` handlers) or stored trees. `{ id, label, icon, source, page?, toolbar }`. |
| `commands` | `{ id, label, icon?, palette }` — shown in menus and, with `palette`, in the command palette. Handled by `host.commands.handle`. Commands whose id ends in `:move`, `:copy`, `:rename` are wired by the shell to drag-and-drop, "move to/copy to" and in-place rename (D430). |
| `actions` | Things that *run*: `{ id, label, icon?, kinds?, output: "table" \| "text" \| "link" \| "none", shortcut?, saveFirst, confirm, ai? }`. A run is recorded (history, audit) and may report progress and partial output. `confirm` must currently be `null`. |
| `settings` | Plugin settings shown on the plugin page: `{ name, label, type: "text" \| "number" \| "boolean" \| "enum" \| "resource", default, options?, kinds?, hint? }`. `resource` stores the id of a resource of one of `kinds` (`@implements:<interface>` picks implementers of an interface). Read with `host.settings.get`. |
| `menus` | `{ "new": [kind ids] }` — entries of the "New" menu. |
| `locales` | `{ "en-US": "locales/en-US.json", … }` — see §8. |
| `events` | Event names the plugin subscribes to (`resource.changed`, `run.ended`). |
| `resultActions` | Buttons added to the result area of other runs: `{ id, label, icon?, outputTypes, action }`. The target action may read only the one clicked run, and only during that click (D439). |
| `languages` | A language pack: `[{ "locale", "name", "shell": "shell/<locale>.json" }]` — translations of the shell's own texts (see `org.onedesk.lang.zh-cn`). |
| `aiTools` | Extra read-only tools offered to external AI clients over MCP (§7). |

**Page actions** (`pages[].actions[]`): `{ id, role, label, icon?, primary?, danger?, shortcut?, action?, command?, ignoreRequired? }` where `role` is one of

| role | does |
|---|---|
| `run` | runs the manifest action named by `action` |
| `save` | saves the resource (the only way content is saved) |
| `save-run` | saves, then runs `action` |
| `event` | sends a page event to your page handler (`onEvent`) |
| `command` | runs the command named by `command` |

The shell shows the first four as buttons and puts the rest under "More". Required fields of a page are checked by the shell before `run` and `save-run` (not before `save`); `ignoreRequired: true` skips the check for that button.

## 4. Permissions (`requires`)

Nothing is allowed unless declared; the user sees the list when the plugin is installed or upgraded, and a changed list must be confirmed again. Each entry becomes a *permission atom*; the set's fingerprint is what the user confirmed.

| Declaration | Allows |
|---|---|
| `"files": true` | `host.files.*` — **only inside folders the user authorised for this plugin** (paths are canonicalised, symlinks resolved; `..` and sibling prefixes are refused) |
| `"network": { "hosts": ["api.example.com"], "fromResources": true }` | `host.network.request` to exactly those hosts, and/or to the hosts named by the plugin's own resources' `grants: "network"` fields. Loopback addresses are refused unless a resource names that host and port explicitly (D308). Workspaces and environments can narrow this with `network.allow` |
| `"secrets": { "names": ["token"], "plaintext": false }` | secret **names** the plugin may use as `{{secret:name}}` placeholders (substituted by the host in addresses, headers and program environments; the plugin never gets the value). `plaintext: true` is a separate, stronger permission to read values |
| `"programs": [{ "name": "psql", "source": "system", "searchPaths": ["/opt/homebrew/bin"] }]` | `host.process.run` for these programs by name. `source: "system"` looks in fixed system folders plus `searchPaths` (absolute or `~/…`, at most one `*`, at most 8); `source: "plugin"` is a program shipped in the plugin (`path`). `process.allow` can narrow it per workspace/environment |
| `"resources": true` | read the basic information (name, kind, location — no body) of **every** resource via `host.resources.search/list` |
| `"plugins": { "install": true }` | may ask the user to install other plugins |
| `uses` | may call the listed interfaces |

Reading or writing resources of **your own** kinds needs no declaration. Reading another plugin's kinds needs that plugin to `exports` them and you to `depends` on it.

## 5. View tree (what `render` returns)

A page's `render(ctx)` returns `{ view: ViewNode[], values?, basis?, title?, icon?, breadcrumb?, readOnly? }`. The kernel validates every node strictly (unknown node types or fields are errors). There are four node types:

| `type` | Fields |
|---|---|
| `form` | `id`, `layout` (`"strip"` one row \| `"stack"`), `label?`, `fields: ViewField[]` |
| `text` | `id`, `text`, `mono?`, `language?`, `tone?` (`default`/`muted`/`danger`), `format?` (`plain`/`markdown`), `lineTones?` (one tone per line: `default`/`muted`/`success`/`warning`/`danger`/`stderr`), `appearance?` (`plain`/`terminal`) |
| `table` | `id`, `columns: [{ key, label, numeric? }]`, `rows` (arrays of values), `rowTargets?`, `rowKeys?`, `rowActions?` (≤ 4 buttons per row, each sends the page event named by its `id` with `context.row`) |
| `link` | `id`, `label`, `target` (`resource:<id>` and the other target forms) |

`ViewField`: `name`, `label`, `kind` (`text`, `longtext`, `code`, `number`, `boolean`, `date`, `datetime`, `enum`, `secret`, `time`, `ref`), `bind?` (a path such as `body.url`, `name`, `description`, `tags`; the shell reads and saves it), `param?` (a page parameter, not saved), `options?`, `presets?`, `fill?`, `language?`, `hint?`, `placeholder?`, `envValue?`, `envSource?`, `readOnly?`, `required?`, `maxLength?`, `kinds?` (for `ref`).

Save flow: a form field with `bind: "body.x"` is saved by the kernel's `page.save` into the resource body through the write pipeline (permissions → transaction → revision → audit → event). Pages that do not edit a resource (`node:` pages) get `save(ctx, changes, basis)` instead.

## 6. Entry point and host interface

```js
// main.js
export default {
  activate(host) {                         // host is only for registering handlers
    host.pages.handle("editor", {
      async render(ctx) { return { view: [ /* ViewNode[] */ ] }; },
      async onEvent(ctx, event) { /* page events, role "event" */ },
    });
    host.actions.handle("open", async (ctx, input) => ({
      output: { type: "text", text: "…" },        // table | text | link | none
      summary: { message: "…" },
    }));
    host.commands.handle("duplicate", async (ctx, context) => [ /* effects */ ]);
    host.trees.handle("files", {
      async children(ctx, parentKey, offset) { return { nodes: [{ key, label, icon, expandable }], next }; },
      async path(ctx, key) { return [key]; },
    });
  },
};
```

Registering a handler for something your manifest does not declare makes activation fail. Handlers receive `ctx`: `{ target, resource?, node?, draft?, params?, run?, locale, host, t(key) }`.

`ctx.t(key)` returns a localised label object; use a small helper to turn it into a string with `{var}` substitution:

```js
export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}
```

**Everything a plugin does to the outside goes through `ctx.host`.** Calls are tied to the current invocation; once it is cancelled or timed out, further host calls are refused. A failed host call throws an `Error` with a `code` (§9).

| Namespace | Methods (see `host.rs` for exact shapes) | Needs |
|---|---|---|
| `resources` | `get`, `list`, `search`, `create`, `update`, `upsertByKey`, `move`, `remove` | own kinds, or `requires.resources` for basic info of all |
| `files` | `roots`, `list`, `stat`, `readText`, `writeText`, `mkdir`, `remove`, `trash`, `open`, `reveal`, `find`, `addRoot`, `removeRoot`, `replaceRoot` | `requires.files` + an authorised folder |
| `network` | `request({ url, method, headers, body, stream, onChunk, timeoutMs, … })` | `requires.network` |
| `process` | `run`, `ready` | `requires.programs` |
| `transfer` | `capture` (stream a program's output into a file) | programs |
| `secrets` | placeholders only: write `{{secret:name}}` (optionally `{{secret:name\|url}}`) in addresses, headers and program env | `requires.secrets` |
| `settings` | `get(name)` | declared `settings` |
| `params` | `get(name)` — a parameter from the current environment chain; `config(name)` — from the workspace configuration | — |
| `storage` | `get`, `set`, `remove` — the plugin's own key/value store | — |
| `runs` | `partial` (push partial output while running), `read` (only inside a result action), `saveArtifact`, `listArtifacts`, `getArtifact`, `deleteArtifact` | — |
| `actions` | `call` — another plugin's *exported* action | `depends` + `exports.actions` |
| `interfaces` | `call`, `list`, `resources` | `uses` |
| `events` | `on(name, handler)` for `resource.changed`, `run.ended` | `contributes.events` |
| `plugins` | `list`, `requestInstall` | `requires.plugins.install` for installing |
| `ui` | `open(target)`, `notify`, `copy`, `openExternal` | — |
| `util` | `sleep` | — |

Limits: 32 MB of memory per plugin version, 1 second for any synchronous stretch of JavaScript, 10 seconds to activate, 15 seconds per handler call (time spent waiting for `process.run` / `transfer.*` is not counted, up to one hour). Exceeding a limit discards the runtime; it is recreated on next use. There is no `fetch`, no `require` of node modules and no filesystem outside `host.files`; only `import "./x.js"` inside the package.

Long requests and streaming: `network.request({ stream: true, onChunk })` hands response text to you in chunks (parse SSE / NDJSON yourself); push the text so far with `runs.partial({ type: "text", text })`. Requests may run up to 10 minutes, with an idle timeout between chunks.

## 7. AI clients (MCP)

An action can be offered to external AI clients (over `onedesk-mcp`) by declaring, on the action:

```jsonc
"ai": { "readOnly": true, "description": "ai.runDesc", "params": [ { "name": "since", "type": "string", "required": true, "description": "…" } ] }
```

and extra tools with `contributes.aiTools: [{ name, description, inputSchema, action, freeQuery? }]` (names get the plugin prefix automatically; input is validated against the JSON Schema before your handler runs). The plugin is responsible for the action being **read-only**; the kernel additionally refuses every write made during an AI run (resources, files, settings, plugin management, non-GET requests, plaintext secrets). Only resources the user marked "visible to AI" are returned to the plugin in an AI run. See `docs/redesign/ai-interface.md`.

## 8. Locales

- `contributes.locales` maps a locale to a JSON file of `{ "key": "text" }`. **`en-US` is required** and is the fallback; add `zh-CN`, `ja-JP`, … as needed.
- Use `{name}` for substitution (see `tr` above). `plugins/_testing/locale-check.test.ts` requires every **built-in** plugin to ship en-US, zh-CN and ja-JP with the same keys and the same `{holes}`; external plugins need only en-US.
- The kernel contains no user-facing text. Error texts shown for kernel errors come from the shell by error `code`.

## 9. Errors and how they reach the screen

- `throw new Error("text")` without a `code`: the screen shows that text. Translate it yourself (use `locales/`), and never put passwords, tokens or other secrets in it.
- An error that carries a **host error code** (`invalid`, `notFound`, `denied`, … the ones the kernel itself uses): the shell shows its own text for that code and your text does **not** appear. To get your own text to the screen, do not give the error a host code.
- Calling another plugin through `host.actions.call`: when the callee fails, the caller gets `code: "pluginError"`, `params.reason: "calleeFailed"`, and `e.message` / `e.detail` hold the first line of the callee's error text (with every secret value this run has read replaced by `***`). The caller may rethrow or rewrite it. Do not rely on the callee's `params`.
- When a run fails, the run record keeps the secret-scrubbed text.
- An action may return `{ failed: { message } }` to mark the run as failed while still keeping its `output` and `summary` (used for a program that exits non-zero but produced useful output).
- A return value may also carry `data` (any JSON, ≤ 1 MB) that is only passed to callers of `actions.call` / `interfaces.call`, not stored with the run (D441).

## 10. Testing

Tests sit next to the source: `main.js` ↔ `main.test.ts`, run by `pnpm test` (vitest). Never touch the real data directory or keychain; use in-memory or temporary data.

Helpers in `plugins/_testing/`:

- `view-check.ts`: `registry(plugin)` runs `activate` against a fake host and returns the registered `pages`, `actions`, `commands`, `trees`, `kinds`; `RENDER_KEYS` and friends list the keys a `render`/tree result may have; `checkView(view)` mirrors the kernel's strict view validation (an empty list means valid); `t` is a stand-in for `ctx.t`.
- `fake-ai/` and `transfer-server.test.ts`: local fake servers (SSE / NDJSON, file transfers). Tests must **never** contact real services (D440).
- `locale-check.test.ts`, `lang-check.test.ts`: every manifest key resolves and the locale files agree.

A typical test:

```ts
import plugin from "./main.js";
import { checkView, registry, t } from "../_testing/view-check";

it("renders a valid view", async () => {
  const { pages } = registry(plugin);
  const out = await pages.editor.render({ target: "resource:r1", locale: "en-US", host: {}, t });
  expect(checkView(out.view)).toEqual([]);
});
```

Also run before committing: `pnpm lint` (checks that nothing but design tokens is used, and that the kernel names no concrete plugin), `pnpm typecheck`, and `pnpm check` for everything.

## 11. A complete minimal example

`plugins/org.onedesk.link` is the smallest real plugin: one kind, one page, one action. Its `manifest.json`:

```json
{
  "id": "org.onedesk.link",
  "version": "0.1.0",
  "apiVersion": "2",
  "name": "plugin.name",
  "description": "plugin.description",
  "icon": "link",
  "main": "main.js",
  "requires": { "files": false },
  "contributes": {
    "kinds": [
      { "id": "link", "label": "kind.link", "icon": "link", "tree": "resources", "page": "editor",
        "newName": "kind.link.new", "defaults": { "url": "" },
        "fields": { "url": { "type": "text" } }, "draggable": true, "accepts": [] }
    ],
    "actions": [
      { "id": "open", "label": "action.open", "icon": "external-link", "kinds": ["link"],
        "output": "link", "saveFirst": false, "confirm": null }
    ],
    "pages": [
      { "id": "editor", "actions": [
        { "id": "open", "role": "run", "action": "open", "label": "action.open", "icon": "external-link", "primary": true },
        { "id": "save", "role": "save", "label": "action.save", "icon": "save", "shortcut": ["Mod", "S"] } ] }
    ],
    "menus": { "new": ["link"] },
    "locales": { "en-US": "locales/en-US.json" }
  }
}
```

and the heart of its `main.js`:

```js
export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        return { view: [{ type: "form", id: "main", layout: "stack", fields: [
          { name: "url", label: ctx.t("field.url"), kind: "text", bind: "body.url" } ] }] };
      },
    });
    host.actions.handle("open", async (ctx, input) => {
      const url = String((input && input["body.url"]) || ctx.resource.body.url || "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error(tr(ctx, "error.badUrl"));
      await ctx.host.ui.openExternal(url);
      return { output: { type: "none" }, summary: { message: tr(ctx, "summary.opened") } };
    });
  },
};
```

More patterns to read: `org.onedesk.datasource` (programs, secrets, progress, long runs), `org.onedesk.ai.anthropic` (network with `fromResources`, streaming, interface implementation), `org.onedesk.catalog` (files, provided tree, exports), `org.onedesk.table` (`aiTools`), `org.onedesk.lang.zh-cn` (language pack).

## 12. Rules checklist

1. No concrete plugin names, kinds or logic in the kernel, worker, protocol or main process.
2. Built-ins work only through the host interface, inside the sandbox.
3. No CSS/TSX in plugins; no hard-coded colours, pixels or durations.
4. User-visible text lives in `locales/` (English is the fallback); the kernel contains no UI text.
5. Placeholder syntax (`{{x}}`, `:name`) is defined by the plugin; the core only substitutes by name from the current environment.
6. Secrets only in the keychain; never in the database, a manifest or an export.
7. Tests use in-memory or temporary data and never contact real services.
8. A new dependency, or a change to the manifest format, host interface or protocol, is recorded in `docs/decisions.md` by the coordinating session.
