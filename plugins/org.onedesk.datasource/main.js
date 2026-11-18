// Data source plugin: PostgreSQL, reached directly (psql) or on a server over ssh (`ssh HOST docker exec … psql`).
// One kind ("source"), a test-connection action and a read-only `query` that other plugins call
// (exports.actions, D413). Which data source a statement uses (its own, the environment's `datasource`, the
// workspace's `datasource.default`) is the caller's choice; `query` runs on the resource it is given.
// The password is a secret field: the framework keeps it in the keychain; here it is only ever written as
// {{secret:name}} into the environment of the program, which the host fills in.
// Sandbox rules: no console, timers or fetch; programs run through ctx.host.process.

export const KIND = "source";
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_ROWS = 1000;
export const MAX_TIMEOUT_MS = 3600000;
const CONNECT_TIMEOUT_S = 10;

/* ---------------------------------------------------------------- helpers */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// A plain Error: one that carries a host code ("invalid", "notFound", …) reaches the user as that code without the text.
function fail(ctx, key, vars) {
  return new Error(tr(ctx, key, vars));
}

// Letters, digits and `._-@:` only, no leading '-' (it would read as an option of ssh or psql).
export function safePart(part) {
  return typeof part === "string" && part.length > 0 && part.length <= 128 && !part.startsWith("-") && /^[A-Za-z0-9._@:-]+$/.test(part);
}

export function parseIntIn(text, lo, hi) {
  const s = String(text === undefined || text === null ? "" : text).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= lo && n <= hi ? n : null;
}

// What the form holds, with defaults; `port` is a number or null.
export function connectionOf(body) {
  const b = body || {};
  const str = (k, d) => (typeof b[k] === "string" ? b[k].trim() : d);
  return {
    mode: b.mode === "ssh" ? "ssh" : "direct",
    host: str("host", ""),
    port: str("port", "5432"),
    database: str("database", ""),
    user: str("user", ""),
    sshHost: str("sshHost", ""),
    container: str("container", ""),
    secret: b.password && typeof b.password.secret === "string" ? b.password.secret : "",
  };
}

// Returns the name of the first field that cannot be used, or "".
export function checkConnection(c) {
  if (c.mode === "ssh") {
    if (!safePart(c.sshHost)) return "sshHost";
    if (!safePart(c.container)) return "container";
  } else {
    if (!safePart(c.host)) return "host";
    if (parseIntIn(c.port, 1, 65535) === null) return "port";
  }
  if (!safePart(c.database)) return "database";
  if (!safePart(c.user)) return "user";
  return "";
}

// The script that runs a statement read-only: one transaction, always rolled back. The newline before the
// statement and after it protects against a `--` comment on either end; `standard_conforming_strings` is forced
// on because the SQL plugin writes values as '…' literals with only the quote doubled (D416).
export function readonlyScript(sql, timeoutMs) {
  const body = String(sql).trim().replace(/;+\s*$/, "");
  return `BEGIN READ ONLY;\nSET LOCAL statement_timeout = ${timeoutMs};\nSET LOCAL standard_conforming_strings = on;\n${body}\n;\nROLLBACK;\n`;
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;

// Reads the text the way PostgreSQL (and psql) do: '…' (and E'…' where a backslash escapes), "…", $tag$…$tag$
// (only where a `$` cannot be part of a name), -- and nested /* */ comments. Returns what the read-only check needs:
//   statements  how many statements are written (a final `;` does not make another),
//   backslash   a backslash outside strings, quoted names and comments — a psql meta-command (D416),
//   first       the first word of the first statement (leading parentheses skipped), upper-case.
export function scanSql(sql) {
  const s = String(sql);
  let i = 0;
  let statements = 0;
  let open = false; // a statement has started and not ended with `;`
  let backslash = false;
  let first = "";
  const begin = () => {
    if (!open) {
      open = true;
      statements++;
    }
  };
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "-" && n === "-") {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "/" && s[i + 1] === "*") (depth++, (i += 2));
        else if (s[i] === "*" && s[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
    } else if (c === "'") {
      begin();
      const escapes = i > 0 && /[eE]/.test(s[i - 1]) && !(i > 1 && IDENT_CHAR.test(s[i - 2]));
      i++;
      while (i < s.length) {
        if (escapes && s[i] === "\\") i += 2;
        else if (s[i] === "'") {
          if (s[i + 1] === "'") i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === '"') {
      begin();
      i++;
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "$" && !(i > 0 && IDENT_CHAR.test(s[i - 1])) && /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.test(s.slice(i, i + 140))) {
      begin();
      const tag = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(s.slice(i, i + 140))[0];
      const end = s.indexOf(tag, i + tag.length);
      i = end < 0 ? s.length : end + tag.length;
    } else if (c === ";") {
      open = false;
      i++;
    } else if (c === "\\") {
      backslash = true;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      begin();
      if (statements === 1 && first === "" && c !== "(") {
        const m = /^[A-Za-z]+/.exec(s.slice(i, i + 32));
        first = m ? m[0].toUpperCase() : "?";
      }
      i++;
    }
  }
  return { statements, backslash, first };
}

// Words a statement may start with. A read-only transaction stops writes; this stops what it cannot
// (COPY … TO PROGRAM, CALL, DO …), and is part of the same check.
export const READ_WORDS = ["SELECT", "WITH", "VALUES", "TABLE", "EXPLAIN", "SHOW"];

// null when `sql` may run, else the reason key.
export function refuse(sql) {
  const r = scanSql(sql);
  if (r.backslash) return "backslash";
  if (r.statements > 1) return "severalStatements";
  if (r.statements === 1 && !READ_WORDS.includes(r.first)) return "notRead";
  return null;
}

// A positive whole number of at most `max`, else null.
export function positiveInt(v, max) {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max ? v : null;
}

// CSV as psql writes it: an unquoted empty field is NULL, "" is an empty string.
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  let inQuotes = false;
  let pending = false;
  const endField = () => {
    record.push(!quoted && field === "" ? null : field);
    field = "";
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    pending = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "" && !quoted) {
      inQuotes = true;
      quoted = true;
    } else if (c === ",") endField();
    else if (c === "\r") {
      // part of CRLF
    } else if (c === "\n") {
      endField();
      records.push(record);
      record = [];
      pending = false;
    } else field += c;
  }
  if (pending) {
    endField();
    records.push(record);
  }
  return records;
}

function percentDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return null;
  }
}

// `postgres://user:password@host:port/database` or `ssh://HOST/CONTAINER?user=USER&db=DATABASE`.
// The password of a URL is not returned: it cannot be written into the keychain from here.
export function parseConnectionUrl(text) {
  const url = String(text || "").trim();
  const ssh = /^ssh:\/\/([^/?]*)\/([^?]*)(?:\?(.*))?$/.exec(url);
  if (ssh) {
    let user = "";
    let database = "";
    for (const pair of (ssh[3] || "").split("&").filter(Boolean)) {
      const i = pair.indexOf("=");
      if (i < 0) return { error: "badUrl" };
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (k === "user") user = v;
      else if (k === "db" || k === "database") database = v;
      else return { error: "badUrl" };
    }
    const c = { mode: "ssh", sshHost: ssh[1], container: ssh[2], user, database, host: "", port: "5432" };
    return checkConnection(c) ? { error: "badUrl" } : { connection: c, hadPassword: false };
  }
  const pg = /^postgres(?:ql)?:\/\/(.*)$/.exec(url);
  if (!pg) return { error: "badUrl" };
  const at = pg[1].lastIndexOf("@");
  if (at < 0) return { error: "badUrl" };
  const info = pg[1].slice(0, at);
  const rest = pg[1].slice(at + 1);
  const colon = info.indexOf(":");
  const user = percentDecode(colon < 0 ? info : info.slice(0, colon));
  const hadPassword = colon >= 0 && info.slice(colon + 1) !== "";
  const slash = rest.indexOf("/");
  const hostport = slash < 0 ? rest : rest.slice(0, slash);
  const database = percentDecode(slash < 0 ? "" : rest.slice(slash + 1).split("?")[0]);
  const p = /^(.*):(\d+)$/.exec(hostport);
  const host = p ? p[1] : hostport;
  const c = { mode: "direct", host, port: p ? p[2] : "5432", database, user, sshHost: "", container: "" };
  if (user === null || database === null || checkConnection(c)) return { error: "badUrl" };
  return { connection: c, hadPassword };
}

// What `ctx.host.process.run` gets for one script on one data source. Besides the script's own read-only
// transaction the session is read-only and times out by itself (PGOPTIONS), and psql reads no psqlrc (-X).
export function processSpec(c, script, timeoutMs) {
  const procTimeout = timeoutMs + (CONNECT_TIMEOUT_S + 5) * 1000;
  const options = `-c default_transaction_read_only=on -c statement_timeout=${timeoutMs}`;
  if (c.mode === "ssh") {
    const remote = `docker exec -i -e 'PGOPTIONS=${options}' ${c.container} psql -X -q --csv -v ON_ERROR_STOP=1 -U ${c.user} -d ${c.database} -f -`;
    return { program: "ssh", args: ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`, c.sshHost, remote], stdin: script, timeoutMs: procTimeout };
  }
  const env = { PGCONNECT_TIMEOUT: String(CONNECT_TIMEOUT_S), PGOPTIONS: options };
  if (c.secret) env.PGPASSWORD = `{{secret:${c.secret}}}`;
  return {
    program: "psql",
    args: ["-X", "-q", "--csv", "-w", "-v", "ON_ERROR_STOP=1", "-h", c.host, "-p", String(c.port), "-U", c.user, "-d", c.database, "-f", "-"],
    env,
    stdin: script,
    timeoutMs: procTimeout,
  };
}

// The first useful lines of what psql / ssh wrote on stderr.
export function errorText(res) {
  const lines = String(res.stderr || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^psql:.*?:\d+: (?:NOTICE|WARNING)/.test(l));
  const text = lines.slice(0, 4).join("\n");
  if (text) return text.replace(/^psql: error: /, "").replace(/^psql:[^:]*:\d+: /, "");
  return res.signal ? `signal ${res.signal}` : `exit ${res.code}`;
}

function runError(ctx, err) {
  const reason = err && err.params && err.params.reason ? `/${err.params.reason}` : "";
  const program = err && err.params && err.params.program ? ` ${err.params.program}` : "";
  return Object.assign(new Error(`${tr(ctx, "error.cannotRun")}${program} (${(err && err.code) || "error"}${reason})`), { code: err && err.code, params: err && err.params });
}

// The caller's own timeout must be a positive whole number of milliseconds (it is written into the script);
// without one, the setting.
async function timeoutOf(ctx, given) {
  if (given === undefined || given === null) return numSetting(ctx, "statementTimeoutMs", DEFAULT_TIMEOUT_MS);
  const n = positiveInt(given, MAX_TIMEOUT_MS);
  if (n === null) throw fail(ctx, "error.badTimeout", {});
  return n;
}

async function numSetting(ctx, name, fallback) {
  const raw = await ctx.host.settings.get(name);
  const n = Number(raw);
  return raw !== null && raw !== undefined && raw !== "" && Number.isInteger(n) && n > 0 && n <= MAX_TIMEOUT_MS ? n : fallback;
}

/* ---------------------------------------------------------------- running */

// Runs one read-only statement; returns { columns, rows, total, ms, truncated }.
export async function runReadonly(ctx, c, sql, opts) {
  const o = opts || {};
  const bad = checkConnection(c);
  if (bad) throw fail(ctx, "error.badField", { field: bad });
  if (!String(sql || "").trim()) throw fail(ctx, "error.emptySql", {});
  const why = refuse(sql);
  if (why) throw fail(ctx, `error.${why}`, {});
  const timeoutMs = await timeoutOf(ctx, o.timeoutMs);
  const maxRows = o.maxRows === undefined ? DEFAULT_MAX_ROWS : positiveInt(o.maxRows, 100000);
  if (maxRows === null) throw fail(ctx, "error.badTimeout", {});
  const started = Date.now();
  let res;
  try {
    res = await ctx.host.process.run(processSpec(c, readonlyScript(sql, timeoutMs), timeoutMs));
  } catch (err) {
    throw runError(ctx, err);
  }
  if (res.code !== 0) throw Object.assign(new Error(errorText(res)), { code: "failed" });
  const records = parseCsv(String(res.stdout || ""));
  const header = (records.shift() || []).map((v) => (v === null ? "" : v));
  const rows = [];
  let more = false;
  for (const r of records) {
    if (rows.length >= maxRows) {
      more = true;
      break;
    }
    rows.push(r);
  }
  const truncated = more || res.truncated === true;
  return { columns: header, rows, total: rows.length + (truncated ? 1 : 0), ms: Date.now() - started, truncated };
}

let captureSeq = 0;

// Like runReadonly, but psql's CSV goes straight into a file in the plugin's own folder (returned, relative).
export async function captureReadonly(ctx, c, sql, opts) {
  const o = opts || {};
  const bad = checkConnection(c);
  if (bad) throw fail(ctx, "error.badField", { field: bad });
  if (!String(sql || "").trim()) throw fail(ctx, "error.emptySql", {});
  const why = refuse(sql);
  if (why) throw fail(ctx, `error.${why}`, {});
  const timeoutMs = await timeoutOf(ctx, o.timeoutMs);
  const file = `tmp/q-${Date.now()}-${++captureSeq}.csv`;
  let res;
  try {
    res = await ctx.host.transfer.capture({ ...processSpec(c, readonlyScript(sql, timeoutMs), timeoutMs), to: file, overwrite: true });
  } catch (err) {
    throw runError(ctx, err);
  }
  if (res.code !== 0) throw Object.assign(new Error(errorText(res)), { code: "failed" });
  return file;
}

export function tableOutput(result) {
  return { type: "table", columns: result.columns.map((name, i) => ({ key: `c${i}`, label: name })), rows: result.rows, total: result.total };
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const b = (ctx.resource && ctx.resource.body) || {};
        const draft = ctx.draft || {};
        const mode = (typeof draft["body.mode"] === "string" ? draft["body.mode"] : b.mode) === "ssh" ? "ssh" : "direct";
        const ro = ctx.run ? { readOnly: true } : {};
        const f = (name, kind, extra) => ({ name, label: ctx.t(`field.${name}`), kind, bind: `body.${name}`, ...ro, ...(extra || {}) });
        const req = (field) => (ctx.run ? field : { ...field, required: true });
        const view = [
          { type: "form", id: "mode", layout: "strip", fields: [f("mode", "enum", { options: [{ value: "direct", label: ctx.t("mode.direct") }, { value: "ssh", label: ctx.t("mode.ssh") }] })] },
        ];
        if (mode === "ssh") {
          view.push({
            type: "form",
            id: "server",
            layout: "strip",
            fields: [req(f("sshHost", "text", { placeholder: ctx.t("field.sshHost.placeholder") })), req(f("container", "text", { placeholder: ctx.t("field.container.placeholder") }))],
          });
        } else {
          view.push({ type: "form", id: "server", layout: "strip", fields: [req(f("host", "text")), req(f("port", "text", { maxLength: 5 }))] });
        }
        view.push({ type: "form", id: "database", layout: "strip", fields: [req(f("database", "text")), req(f("user", "text"))] });
        if (mode === "direct") {
          view.push({ type: "form", id: "auth", layout: "strip", fields: [f("password", "secret", { hint: ctx.t("field.password.hint") })] });
        } else {
          view.push({ type: "text", id: "sshNote", text: tr(ctx, "note.ssh"), tone: "muted" });
        }
        view.push({ type: "text", id: "readonly", text: tr(ctx, "note.readonly"), tone: "muted" });
        if (!ctx.run) {
          view.push({
            type: "form",
            id: "import",
            layout: "strip",
            fields: [{ name: "importUrl", label: ctx.t("field.importUrl"), kind: "text", param: true, placeholder: ctx.t("field.importUrl.placeholder"), fill: true }],
          });
        }
        return { view };
      },

      async onEvent(ctx, event) {
        if (event !== "import") throw new Error(`unknown event ${event}`);
        const parsed = parseConnectionUrl(ctx.params && ctx.params.importUrl);
        if (parsed.error) return { message: tr(ctx, "message.badUrl") };
        const c = parsed.connection;
        const changes = { "body.mode": c.mode, "body.host": c.host, "body.port": c.port, "body.database": c.database, "body.user": c.user, "body.sshHost": c.sshHost, "body.container": c.container };
        return { changes, params: { importUrl: "" }, message: tr(ctx, parsed.hadPassword ? "message.importedPassword" : "message.imported") };
      },
    });

    host.actions.handle("test", async (ctx, input) => {
      const body = { ...((ctx.resource && ctx.resource.body) || {}) };
      for (const k of Object.keys(input || {})) if (k.startsWith("body.")) body[k.slice(5)] = input[k];
      const c = connectionOf(body);
      const r = await runReadonly(ctx, c, "SELECT version() AS version", { maxRows: 1 });
      const version = (r.rows[0] && r.rows[0][0]) || "";
      const text = tr(ctx, "test.ok", { version, ms: r.ms });
      return { output: { type: "text", text }, summary: { message: tr(ctx, "summary.test", { ms: r.ms }) } };
    });

    // Called by other plugins (exports.actions) on one data source (`ctx.resource`, chosen by the caller):
    // { sql, timeoutMs? } → a table in a data file the kernel reads (X2), so a big result never passes through
    // this plugin's memory. The kernel keeps at most 10,000 rows in the run and counts all of them.
    host.actions.handle("query", async (ctx, input) => {
      const i = input || {};
      if (!ctx.resource) throw fail(ctx, "error.noSource", {});
      const started = Date.now();
      try {
        const file = await captureReadonly(ctx, connectionOf(ctx.resource.body), i.sql, { timeoutMs: i.timeoutMs });
        return { output: { type: "table", file, header: true }, summary: { message: tr(ctx, "summary.ran", { ms: Date.now() - started }) } };
      } catch (err) {
        // A failure of the callee reaches the caller as a bare `pluginError` without its text, so the text (the
        // database's own message, already in the user's language where it is ours) is handed back as data.
        return { error: String((err && err.message) || err) };
      }
    });
  },
};
