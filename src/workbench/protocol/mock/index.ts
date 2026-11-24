/**
 * In-browser stand-in for the kernel (stage 0). It implements ProtocolClient over fake data kept in
 * memory and mirrored to localStorage, with small delays so the UI is exercised asynchronously.
 * Replace `createMockClient()` in main.tsx with the real client; nothing else in the UI changes.
 */
import type { ProtocolClient } from "../client";
import { DEMO_LANGUAGES } from "../../i18n/lang-files";
import { KernelError } from "../errors";
import type {
  ActionDecl,
  AuditRow,
  CommandContext,
  CommandEffect,
  Crumb,
  DropPosition,
  EnvParam,
  EnvView,
  EventHandler,
  HistoryEntry,
  Label,
  MenuCommand,
  NodeState,
  PageContext,
  PageDescriptor,
  ParamType,
  PluginDetail,
  ResolvedParam,
  Resource,
  ResourcePatch,
  ResultTabDecl,
  RefInfo,
  Run,
  RunOutput,
  RunRequest,
  SearchHit,
  TreeInfo,
  TreeNode,
  ViewField,
  ViewNode,
} from "../types";
import { type MockAuditRow, DAY, FILE_ROOTS, HOUR, KINDS, ME, MINUTE, OPERATIONS, SEED_FAVORITES, fmtDate, fmtDateTime, generateTable, prng, seedAudit, seedPlugins, seedRows, type FakeFile, type ParamValue, type PluginRow, type Row, type Sim } from "./data";

const DB_KEY = "onedesk.workbench.mock.v3";
const WORKSPACES_KEY = "onedesk.workbench.mock.workspaces";
const UI_PREFIX = "onedesk.workbench.ui.";

type OutSpec = { kind: "table"; dataset: string; rows: number; seed: number } | { kind: "text"; text: string; format?: "markdown" };
interface StoredRun extends Omit<Run, "output"> {
  out?: OutSpec;
}
interface HistoryRec extends Omit<HistoryEntry, "op"> {
  beforeRaw: unknown;
  afterRaw: unknown;
}
interface Db {
  rows: Record<string, Row>;
  plugins: PluginRow[];
  runs: StoredRun[];
  audit: MockAuditRow[];
  history: Record<string, HistoryRec[]>;
  favorites: string[];
  seq: number;
  runSeq: number;
}

const L = (en: string, zh: string): Label => ({ "en-US": en, "zh-CN": zh });
const wait = (ms = 12) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

const NEW_GROUP: MenuCommand = { id: "node.newGroup", label: L("New group", "新建分组"), icon: "folder-plus" };
const TREES: TreeInfo[] = [
  {
    id: "resources",
    title: L("Resources", "资源"),
    icon: "folder-tree",
    source: "stored",
    groups: true,
    toolbar: [],
    menu: [
      { id: "new:org.onedesk.sql:query", label: L("New SQL query", "新建 SQL 查询"), icon: "file-code" },
      { id: "new:org.onedesk.note:note", label: L("New note", "新建笔记"), icon: "notebook-pen" },
      NEW_GROUP,
    ],
  },
  { id: "environments", title: L("Environments", "环境"), icon: "layers", source: "stored", groups: false, toolbar: [], menu: [{ id: "new:core:env", label: L("New environment", "新建环境"), icon: "plus" }] },
  { id: "config", title: L("Workspace configuration", "工作区配置"), icon: "sliders-horizontal", source: "stored", groups: false, toolbar: [], menu: [] },
  { id: "plugins", title: L("Plugins", "插件"), icon: "puzzle", source: "provided", groups: false, toolbar: [], menu: [] },
  { id: "datasources", title: L("Data sources", "数据源"), icon: "database", source: "stored", groups: true, toolbar: [], menu: [{ id: "new:org.onedesk.sql:datasource", label: L("New data source", "新建数据源"), icon: "database" }, NEW_GROUP] },
  { id: "files", title: L("Files", "文件"), icon: "hard-drive", source: "provided", groups: false, toolbar: [], menu: [{ id: "import.folder", label: L("Import folder", "导入文件夹"), icon: "folder-input" }] },
  { id: "runs", title: L("Run records", "运行记录"), icon: "history", source: "provided", groups: false, toolbar: [], menu: [] },
  { id: "favorites", title: L("Favorites", "收藏"), icon: "star", source: "provided", groups: false, toolbar: [], menu: [] },
  { id: "deleted", title: L("Deleted", "已删除"), icon: "trash-2", source: "provided", groups: false, toolbar: [], menu: [] },
];

const CONFIG_FIELDS: Record<string, Partial<ViewField> & { label: Label }> = {
  "ui.language": { label: L("Interface language", "界面语言"), kind: "enum", options: [{ value: "en-US", label: "English" }, { value: "zh-CN", label: "简体中文" }, { value: "ja-JP", label: "日本語" }], hint: L("Takes effect at once.", "立即生效。") },
  "ui.advanced": { label: L("Advanced mode", "高级模式"), kind: "boolean" },
  "ui.theme": { label: L("Theme", "主题"), kind: "enum", options: [{ value: "system", label: L("Follow system", "跟随系统") }, { value: "light", label: L("Light", "浅色") }, { value: "dark", label: L("Dark", "深色") }] },
  "ui.density": { label: L("Density", "密度"), kind: "enum", options: [{ value: "comfortable", label: L("Comfortable", "宽松") }, { value: "compact", label: L("Compact", "紧凑") }] },
  "git.enabled": { label: L("Version resources with git", "用 git 版本化资源"), kind: "boolean" },
  "git.repository": { label: L("Repository location", "仓库位置"), kind: "text" },
  "git.debounce_seconds": { label: L("Commit delay (seconds)", "提交延迟（秒）"), kind: "number", hint: L("2–60 seconds.", "2–60 秒。") },
  "git.conflicts": { label: L("Unresolved conflicts", "未解决的冲突"), kind: "number", readOnly: true },
  "web.enabled": { label: L("Allow access from a browser", "允许浏览器访问"), kind: "boolean" },
  "web.lan": { label: L("Allow other devices on the local network", "允许局域网内其他设备"), kind: "boolean" },
  "web.port": { label: L("Port", "端口"), kind: "number" },
  "backup.schedule": { label: L("Scheduled backup", "定时备份"), kind: "enum", options: [{ value: "off", label: L("Off", "关闭") }, { value: "daily", label: L("Daily", "每天") }, { value: "weekly", label: L("Weekly", "每周") }] },
  "backup.keep": { label: L("Snapshots to keep", "保留的快照数"), kind: "number" },
  "export.directory": { label: L("Export folder", "导出目录"), kind: "text" },
};

const PARAM_HINTS: Record<string, Label> = {
  tenant_id: L("Tenant to query. Usually supplied by the environment.", "要查询的租户，通常由环境提供。"),
  limit: L("Maximum number of rows returned.", "返回的最大行数。"),
  start_time: L("Inclusive lower bound of created_at.", "created_at 的下界（含）。"),
  start_date: L("Inclusive start date.", "开始日期（含）。"),
  end_date: L("Exclusive end date.", "结束日期（不含）。"),
  db_schema: L("Schema name; differs between environments.", "库名，各环境不同。"),
  channel: L("Sales channel.", "销售渠道。"),
};

/* ------------------------------------------------------------------ SQL helpers (the "SQL plugin") */

/** Parameter names written as :name, ignoring strings, comments and ::casts. Order of first use. */
export function sqlParamNames(sql: string): string[] {
  const cleaned = sql.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  const out: string[] = [];
  const re = /(^|[^:\w]):([A-Za-z_][A-Za-z0-9_]*)/g;
  for (let m = re.exec(cleaned); m; m = re.exec(cleaned)) if (!out.includes(m[2]!)) out.push(m[2]!);
  return out;
}

function paramKind(name: string): ViewField["kind"] {
  if (/(_time|_at)$/.test(name)) return "datetime";
  if (/(^date$|_date$)/.test(name)) return "date";
  if (/^(limit|days|hours|page_size|min_\w+|max_\w+|\w+_id)$/.test(name)) return "number";
  if (name === "channel") return "enum";
  return "text";
}

function paramField(name: string, now: number): ViewField {
  const kind = paramKind(name);
  const field: ViewField = { name, label: name, kind, param: true, hint: PARAM_HINTS[name] };
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const t0 = midnight.getTime();
  const local = (t: number) => fmtDateTime(t).slice(0, 16).replace(" ", "T");
  if (kind === "datetime") {
    field.presets = [
      { label: L("Today 00:00", "今天零点"), value: local(t0) },
      { label: L("Yesterday 00:00", "昨天零点"), value: local(t0 - DAY) },
      { label: L("7 days ago 00:00", "7 天前零点"), value: local(t0 - 7 * DAY) },
      { label: L("Now", "现在"), value: local(now) },
    ];
  } else if (kind === "date") {
    const first = new Date(t0);
    first.setDate(1);
    const prev = new Date(first);
    prev.setMonth(prev.getMonth() - 1);
    field.presets = [
      { label: L("Today", "今天"), value: fmtDate(t0) },
      { label: L("Yesterday", "昨天"), value: fmtDate(t0 - DAY) },
      { label: L("First day of this month", "本月第一天"), value: fmtDate(first.getTime()) },
      { label: L("First day of last month", "上月第一天"), value: fmtDate(prev.getTime()) },
    ];
  } else if (kind === "enum") {
    field.options = ["app", "web", "mini-program", "pos", "partner", "douyin"].map((v) => ({ value: v, label: v }));
  }
  return field;
}

function sentSql(sql: string, params: Record<string, string>): string {
  return sql.replace(/(^|[^:\w]):([A-Za-z_][A-Za-z0-9_]*)/g, (whole, pre: string, name: string) => {
    const v = params[name];
    if (v === undefined || v === "") return whole;
    return pre + (/^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace("T", " ").replace(/'/g, "''")}'`);
  });
}

const SQL_KEYWORDS = /\b(select|from|where|and|or|join|left|right|inner|outer|on|group|by|order|limit|having|as|in|is|not|null|with|insert|into|values|update|set|delete|union|all|distinct|case|when|then|else|end|interval|between|like|desc|asc|show)\b/gi;
function formatSql(sql: string): string {
  return sql
    .split("\n")
    .map((line) => (/^\s*--/.test(line) ? line : line.replace(SQL_KEYWORDS, (k) => k.toUpperCase()).replace(/[ \t]+$/g, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/* ------------------------------------------------------------------ the mock */

export interface MockOptions {
  /** Start from fresh seed data, ignoring what localStorage holds. */
  fresh?: boolean;
  /** Skip the background run that is in progress on first start (stable screenshots). */
  quiet?: boolean;
}

const MOCK_BATCH = 200;

export function createMockClient(options: MockOptions = {}): ProtocolClient {
  const handlers = new Map<string, Set<EventHandler>>();
  const timers = new Map<string, number>();
  let saveTimer: number | undefined;

  const emit = (...topics: string[]) => {
    setTimeout(() => {
      for (const topic of new Set(topics)) for (const h of [...(handlers.get(topic) ?? [])]) h(topic);
    }, 0);
  };

  /** The demo's two workspaces (D400): only the name and the current one change; the data is the same. */
  const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  const workspaces: { items: { id: string; name: string; folder: string; lastOpened?: number }[]; current: string } = {
    items: [
      { id: "ws-shop", name: "电商数据 Shop Data", folder: "shop-data", lastOpened: 2 },
      { id: "ws-personal", name: "个人 Personal", folder: "personal", lastOpened: 1 },
    ],
    current: "ws-shop",
  };
  const saveWorkspaces = () => write(WORKSPACES_KEY, workspaces);

  /* ---------------------------------------------------------------- storage */
  const read = (key: string): unknown => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or unavailable: the prototype keeps working in memory */
    }
  };
  const persist = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => write(DB_KEY, db), 250);
  };

  const savedWorkspaces = options.fresh ? null : (read(WORKSPACES_KEY) as typeof workspaces | null);
  if (savedWorkspaces?.items?.length) Object.assign(workspaces, savedWorkspaces);
  // A tab opened with "new window" belongs to that workspace (not saved: the other tabs keep theirs).
  try {
    const asked = new URLSearchParams(window.location.search).get("workspace");
    if (asked && workspaces.items.some((w) => w.id === asked)) workspaces.current = asked;
  } catch {
    /* no window.location (tests) */
  }

  function seed(): Db {
    const now = Date.now();
    const rows: Record<string, Row> = {};
    for (const r of seedRows(now)) rows[r.id] = r;
    const fresh: Db = { rows, plugins: seedPlugins(now), runs: [], audit: seedAudit(now), history: {}, favorites: [...SEED_FAVORITES], seq: 1, runSeq: 1000 };
    seedRuns(fresh, now);
    seedHistory(fresh, now);
    return fresh;
  }

  function seedRuns(target: Db, now: number) {
    const rnd = prng(42);
    const ids = ["q-orders-today", "q-slow", "q-gmv-channel", "q-revenue", "q-inactive-users", "q-orders-overdue", "q-refund-recon", "q-new-users", "q-sizes", "q-repl", "q-invoices", "q-aging"];
    const envs = ["env-prod-ro", "env-prod", "env-staging"];
    const list: StoredRun[] = [];
    for (let i = 39; i >= 0; i--) {
      const row = target.rows[ids[(i * 5 + Math.floor(rnd() * 3)) % ids.length]!]!;
      const sim = (row.body.sim ?? {}) as Sim;
      const sql = String(row.body.sql ?? "");
      const envId = envs[i % 3]!;
      const startedAt = now - i * 5 * HOUR - Math.floor(rnd() * 2 * HOUR) - 25 * MINUTE;
      const ms = Math.round((sim.ms ?? 900) * (0.6 + rnd() * 0.9));
      const params: Record<string, string> = {};
      for (const name of sqlParamNames(sql)) params[name] = sampleValue(name, startedAt, target, envId);
      const failed = row.id === "q-refund-recon";
      const cancelled = !failed && i === 17;
      const count = Math.max(1, Math.round((sim.rows ?? 20) * (0.7 + rnd() * 0.3)));
      target.runSeq += 1;
      list.push({
        id: `run-${target.runSeq}`,
        seq: target.runSeq,
        title: row.name,
        icon: KINDS[row.kind]!.icon,
        resourceId: row.id,
        action: "run",
        actionLabel: L("Run", "执行"),
        envId,
        envName: target.rows[envId]!.name,
        actor: i % 7 === 3 ? "li.na" : i % 11 === 5 ? "ops-bot" : ME,
        source: i % 11 === 5 ? "scheduled" : "user",
        startedAt,
        endedAt: startedAt + ms,
        status: failed ? "error" : cancelled ? "cancelled" : "success",
        params,
        input: { "body.sql": sql },
        summary: failed || cancelled ? { durationMs: ms, message: cancelled ? "Cancelled by user" : undefined } : { rows: count, durationMs: ms },
        error: failed ? tableMissing() : undefined,
        out: failed || cancelled ? undefined : { kind: "table", dataset: sim.dataset ?? "generic", rows: count, seed: target.runSeq },
        kept: i === 4,
        inTaskPanel: i < 2,
        cancellable: false,
      });
    }
    target.runs = list;
    if (!options.quiet) {
      target.runSeq += 1;
      target.runs.push({
        id: `run-${target.runSeq}`,
        seq: target.runSeq,
        title: "Import folder ~/Documents/sql-archive",
        icon: "folder-input",
        action: "import",
        actionLabel: L("Import folder", "导入文件夹"),
        actor: ME,
        source: "user",
        startedAt: now - 4000,
        status: "running",
        params: {},
        input: { folder: "~/Documents/sql-archive" },
        progress: { fraction: 0.08, message: "Scanning…" },
        kept: false,
        inTaskPanel: true,
        cancellable: true,
      });
    }
  }

  function sampleValue(name: string, at: number, target: Db, envId: string): string {
    const fromEnv = resolveIn(target, envId, name);
    if (fromEnv.found) return fromEnv.value;
    const kind = paramKind(name);
    const midnight = new Date(at);
    midnight.setHours(0, 0, 0, 0);
    if (kind === "datetime") return fmtDateTime(midnight.getTime()).slice(0, 16);
    if (kind === "date") return name.startsWith("end") ? fmtDate(midnight.getTime() + DAY) : fmtDate(midnight.getTime() - (name.startsWith("start") ? 30 * DAY : 0));
    if (name === "days") return "90";
    if (name === "hours") return "24";
    if (name === "min_value") return "500";
    if (kind === "number") return "100";
    return "app";
  }

  function seedHistory(target: Db, now: number) {
    const rec = (id: string, daysAgo: number, actor: string, field: string, before: unknown, after: unknown): HistoryRec => ({
      id: `h-seed-${id}-${daysAgo}-${field}`,
      at: now - daysAgo * DAY - 3 * HOUR,
      actor,
      field,
      before: show(before),
      after: show(after),
      beforeRaw: before,
      afterRaw: after,
    });
    target.history["env-default"] = [
      rec("env-default", 2, "li.na", "param:limit", "500", "1000"),
      rec("env-default", 21, ME, "param:ai.policy", "deny", "metadata-only"),
      rec("env-default", 60, ME, "description", "基础参数。", target.rows["env-default"]!.description),
    ];
    target.history["env-prod"] = [
      rec("env-prod", 1, ME, "param:datasource", "ds-replica", "ds-prod"),
      rec("env-prod", 9, "li.na", "param:ai.policy", "metadata-only", "deny"),
      rec("env-prod", 30, ME, "param:limit", undefined, "500"),
      rec("env-prod", 45, ME, "param:protection.readonly", "false", "true"),
      rec("env-prod", 80, "wang.wei", "description", "正式环境。", target.rows["env-prod"]!.description),
    ];
    target.history["env-prod-ro"] = [rec("env-prod-ro", 12, ME, "param:limit", "2000", "5000"), rec("env-prod-ro", 33, ME, "param:protection.readonly", undefined, "false")];
    target.history["env-staging"] = [rec("env-staging", 5, ME, "param:tenant_id", "1001", "9001")];
  }

  const stored = options.fresh ? null : (read(DB_KEY) as Db | null);
  /** Round 19: the workspace's `mcp.policy` parameters (the real kernel keeps them in the config node). */
  const mcpConfig: Record<string, string> = { "mcp.enabled": "false", "mcp.rate_per_minute": "30", "mcp.max_rows": "200", "mcp.allow_free_query": "false", "mcp.env": "" };
  const db: Db = stored && stored.rows && stored.runs ? stored : seed();
  // Runs that were in progress when the page closed cannot continue (§8).
  for (const run of db.runs) {
    if (run.status === "running" && stored) {
      run.status = "error";
      run.endedAt = run.endedAt ?? Date.now();
      run.error = { code: "app.interrupted", message: "The application was closed while this was running.", hint: "Start it again." };
      run.cancellable = false;
    }
  }
  persist();

  /* ---------------------------------------------------------------- basics */
  const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(db.seq++).toString(36)}`;

  function show(v: unknown): string {
    if (v === undefined || v === null) return "—";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  }

  function audit(operation: string, target: string, detail = "", result: AuditRow["result"] = "ok", actor = ME, source: AuditRow["source"] = "user") {
    db.audit.unshift({ id: newId("a"), at: Date.now(), actor, source, operation, operationLabel: OPERATIONS[operation] ?? operation, target, result, detail });
    if (db.audit.length > 600) db.audit.length = 600;
    emit("audit");
  }

  const pluginOf = (kind: string) => db.plugins.find((p) => p.id === KINDS[kind]?.plugin);
  const pluginBroken = (p: PluginRow) => Boolean(p.bad && p.versions.find((v) => v.active)?.version === p.bad.version);

  function stateOf(row: Row): { state: NodeState; reason?: Label } {
    if (row.state === "conflict") return { state: "conflict", reason: L("Changed both here and remotely. Read-only until the conflict is resolved.", "本地和远程都改过。解决冲突前只读。") };
    if (row.state === "missing") return { state: "broken", reason: L(row.description || "The source no longer exists.", row.origin === "subscribed" ? "订阅的来源已不存在。" : "源头已不存在。") };
    const def = KINDS[row.kind];
    if (def?.plugin) {
      const p = pluginOf(row.kind);
      if (!p || !p.installed) return { state: "missing-plugin", reason: L(`Needs the plugin ${def.plugin}, which is not installed.`, `需要插件 ${def.plugin}，它没有安装。`) };
      if (!p.enabled) return { state: "disabled", reason: L(`The plugin ${def.plugin} is disabled.`, `插件 ${def.plugin} 已停用。`) };
    }
    return { state: "ok" };
  }

  const live = (r: Row) => !r.deletedAt;
  const childrenOf = (tree: string, parentId: string | null) =>
    Object.values(db.rows)
      .filter((r) => r.tree === tree && r.parentId === parentId && live(r))
      .sort((a, b) => a.pos - b.pos);

  function ancestors(row: Row): Row[] {
    const out: Row[] = [];
    for (let p = row.parentId ? db.rows[row.parentId] : undefined; p; p = p.parentId ? db.rows[p.parentId] : undefined) out.unshift(p);
    return out;
  }

  const targetOf = (row: Row): string | undefined => (row.kind === "core:group" ? undefined : ((row.body.target as string | undefined) ?? `resource:${row.id}`));

  function menuFor(row: Row): MenuCommand[] {
    const fav = db.favorites.includes(row.id);
    const newHere: MenuCommand[] =
      row.tree === "resources"
        ? [
            { id: "new:org.onedesk.sql:query", label: L("New SQL query here", "在此新建 SQL 查询"), icon: "file-code" },
            { id: "new:org.onedesk.note:note", label: L("New note here", "在此新建笔记"), icon: "notebook-pen" },
            { id: "node.newGroup", label: L("New group", "新建分组"), icon: "folder-plus" },
          ]
        : row.tree === "datasources"
          ? [
              { id: "new:org.onedesk.sql:datasource", label: L("New data source here", "在此新建数据源"), icon: "database" },
              { id: "node.newGroup", label: L("New group", "新建分组"), icon: "folder-plus" },
            ]
          : [];
    const edit: MenuCommand[] = [
      { id: "node.rename", label: L("Rename", "重命名"), icon: "pencil", shortcut: ["↵"], separatorBefore: true },
      { id: "node.duplicate", label: L("Duplicate", "复制一份"), icon: "copy" },
    ];
    const remove: MenuCommand = { id: "node.delete", label: L("Delete", "删除"), icon: "trash-2", danger: true, separatorBefore: true, shortcut: ["⌫"] };
    if (row.kind === "core:group") return [...newHere, edit[0]!, remove];
    if (row.kind === "core:config") return [{ id: "node.open", label: L("Open", "打开"), icon: "arrow-up-right" }];
    const open: MenuCommand = { id: "node.open", label: L("Open", "打开"), icon: "arrow-up-right" };
    const favorite: MenuCommand = fav
      ? { id: "node.unfavorite", label: L("Remove from favorites", "取消收藏"), icon: "star-off" }
      : { id: "node.favorite", label: L("Add to favorites", "收藏"), icon: "star" };
    const link: MenuCommand = { id: "node.copyLink", label: L("Copy link", "复制链接"), icon: "link" };
    if (row.kind === "core:env") {
      return [
        open,
        { id: "env.useInTab", label: L("Use in the active tab", "用于当前标签页"), icon: "circle-check" },
        { id: "env.newChild", label: L("New child environment", "新建子环境"), icon: "plus", separatorBefore: true },
        ...edit,
        remove,
      ];
    }
    return [open, favorite, ...edit, link, remove];
  }

  function toNode(row: Row): TreeNode {
    const def = KINDS[row.kind];
    const { state, reason } = stateOf(row);
    const isGroup = row.kind === "core:group";
    return {
      key: row.id,
      tree: row.tree,
      parentKey: row.parentId ?? undefined,
      label: row.name,
      icon: def?.icon ?? "file",
      kind: row.kind,
      expandable: isGroup || childrenOf(row.tree, row.id).length > 0,
      state,
      stateReason: reason,
      target: targetOf(row),
      menu: menuFor(row),
      draggable: row.kind !== "core:config",
      accepts: isGroup ? ["*"] : row.kind === "core:env" ? ["core:env"] : row.kind === "core:config" ? [] : [],
    };
  }

  function toResource(row: Row): Resource {
    const def = KINDS[row.kind];
    const { state, reason } = stateOf(row);
    return {
      id: row.id,
      kind: row.kind,
      kindLabel: def?.label ?? row.kind,
      icon: def?.icon ?? "file",
      tree: row.tree,
      parentId: row.parentId ?? undefined,
      name: row.name,
      description: row.description,
      tags: [...row.tags],
      body: clone(row.body),
      state,
      stateReason: reason,
      origin: row.origin,
      originRef: row.originRef,
      location: ancestors(row).map((a) => a.name),
      favorite: db.favorites.includes(row.id),
      aiVisible: Boolean(row.aiVisible),
      deleted: Boolean(row.deletedAt),
      readOnly: state !== "ok",
      rev: row.rev,
      pluginVersion: pluginOf(row.kind)?.versions.find((v) => v.active)?.version,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  /* ---------------------------------------------------------------- field paths & the single write entry (§4) */
  function getPath(row: Row, path: string): unknown {
    if (path.startsWith("param:")) return (row.body.params as Record<string, ParamValue> | undefined)?.[path.slice(6)]?.value;
    if (path === "name" || path === "description") return row[path];
    if (path === "tags") return row.tags;
    let cur: unknown = row;
    for (const part of path.split(".")) cur = (cur as Record<string, unknown> | undefined)?.[part];
    return cur;
  }

  function setPath(row: Row, path: string, value: unknown) {
    if (path.startsWith("param:")) {
      const params = ((row.body.params as Record<string, ParamValue> | undefined) ??= {}) as Record<string, ParamValue>;
      row.body.params = params;
      const name = path.slice(6);
      if (value === undefined) delete params[name];
      else params[name] = { ...(params[name] ?? { type: guessType(name) }), value: String(value) };
      return;
    }
    if (path === "name" || path === "description") {
      row[path] = String(value ?? "");
      return;
    }
    if (path === "tags") {
      row.tags = Array.isArray(value) ? value.map(String) : [];
      return;
    }
    const parts = path.split(".");
    let cur = row as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) cur = (cur[part] ??= {}) as Record<string, unknown>;
    cur[parts[parts.length - 1]!] = value;
  }

  function guessType(name: string): ParamType {
    for (const r of Object.values(db.rows)) {
      const p = (r.body.params as Record<string, ParamValue> | undefined)?.[name];
      if (p) return p.type;
    }
    return paramKind(name) === "number" ? "number" : "text";
  }

  /** Every change to a resource goes through here: history, audit, rev, events — once. */
  function applyPatch(row: Row, patch: ResourcePatch, opts: { actor?: string; restoredFrom?: string; operation?: string } = {}): boolean {
    let changed = false;
    for (const [path, value] of Object.entries(patch)) {
      const before = clone(getPath(row, path));
      if (JSON.stringify(before) === JSON.stringify(value)) continue;
      setPath(row, path, value);
      changed = true;
      (db.history[row.id] ??= []).unshift({
        id: newId("h"),
        at: Date.now(),
        actor: opts.actor ?? ME,
        field: path,
        before: show(before),
        after: show(value),
        beforeRaw: before,
        afterRaw: value,
        restoredFrom: opts.restoredFrom,
      });
      audit(opts.operation ?? (path.startsWith("param:") ? "params.set" : "resource.update"), row.name, `${path}: ${show(before)} → ${show(value)}`);
    }
    if (!changed) return false;
    row.rev += 1;
    row.updatedAt = Date.now();
    row.updatedBy = opts.actor ?? ME;
    persist();
    touch(row);
    return true;
  }

  function touch(row: Row) {
    const topics = [`resource:${row.id}`, `tree:${row.tree}`];
    if (db.favorites.includes(row.id)) topics.push("tree:favorites");
    if (row.kind === "core:config") topics.push("config");
    if (row.kind === "core:env") topics.push("env");
    emit(...topics);
  }

  /* ---------------------------------------------------------------- environments (§6) */
  function paramsOf(row: Row): Record<string, ParamValue> {
    return (row.body.params ?? {}) as Record<string, ParamValue>;
  }

  function resolveIn(target: Db, envId: string | null, name: string): ResolvedParam {
    for (let env = envId ? target.rows[envId] : undefined; env && !env.deletedAt; env = env.parentId ? target.rows[env.parentId] : undefined) {
      const p = paramsOf(env)[name];
      if (p) return { name, found: true, value: p.value, display: p.type === "ref" ? (target.rows[p.value]?.name ?? p.value) : p.value, sourceName: env.name };
    }
    return { name, found: false, value: "", display: "", sourceName: "" };
  }

  function declaredParams(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const r of Object.values(db.rows)) {
      if (!live(r) || r.kind !== "org.onedesk.sql:query") continue;
      for (const name of sqlParamNames(String(r.body.sql ?? ""))) map.set(name, [...(map.get(name) ?? []), r.name]);
    }
    return map;
  }

  function envView(envId: string): EnvView | null {
    const env = db.rows[envId];
    if (!env || env.kind !== "core:env" || env.deletedAt) return null;
    const chain = [...ancestors(env), env];
    const declared = declaredParams();
    const names: string[] = [];
    for (const layer of chain) for (const n of Object.keys(paramsOf(layer))) if (!names.includes(n)) names.push(n);
    for (const n of declared.keys()) if (!names.includes(n)) names.push(n);
    const params: EnvParam[] = names.map((name) => {
      const own = paramsOf(env)[name];
      const parent = env.parentId ? resolveIn(db, env.parentId, name) : { name, found: false, value: "", display: "", sourceName: "" };
      const parentType = parent.found ? guessType(name) : undefined;
      const type = own?.type ?? parentType ?? guessType(name);
      const value = own ? own.value : parent.value;
      const param: EnvParam = {
        name,
        type,
        value,
        display: type === "ref" ? (db.rows[value]?.name ?? value) : undefined,
        sourceId: own ? env.id : parent.found ? (chain.find((c) => c.name === parent.sourceName)?.id ?? "") : "",
        sourceName: own ? env.name : parent.sourceName,
        own: Boolean(own),
        inherited: parent.found ? { value: parent.display || parent.value, sourceName: parent.sourceName } : undefined,
        declaredBy: declared.get(name) ?? [],
        description: PARAM_HINTS[name],
      };
      if (parent.found) {
        const above = ancestors(env);
        const nearest = [...above].reverse().find((a) => paramsOf(a)[name]);
        param.layers = above.map((a) => {
          const v = paramsOf(a)[name];
          return { envId: a.id, name: a.name, value: v ? (v.type === "ref" ? (db.rows[v.value]?.name ?? v.value) : v.value) : undefined, effective: a.id === nearest?.id };
        });
      }
      if (own && own.based_on !== undefined && parent.found && parent.value !== own.based_on) param.changedUpstream = { was: own.based_on, now: parent.value };
      if (name === "protection.readonly" && own?.value === "false" && parent.found && parent.value === "true") {
        param.restricted = L(`Not in effect: ${parent.sourceName} sets read-only, and a child can only be stricter.`, `不生效：${parent.sourceName} 设为只读，子环境只能更严。`);
      }
      return param;
    });
    return {
      id: env.id,
      name: env.name,
      description: env.description,
      rev: 1,
      chain: chain.map((c) => ({ id: c.id, name: c.name })),
      params,
      children: childrenOf("environments", env.id).map((c) => ({ id: c.id, name: c.name })),
    };
  }

  /* ---------------------------------------------------------------- pages (§9) */
  function crumbsFor(row: Row): Crumb[] {
    const tree = TREES.find((t) => t.id === row.tree);
    return [
      ...ancestors(row).map((a): Crumb => ({ label: a.name, icon: KINDS[a.kind]?.icon, tree: a.tree, key: a.id, target: targetOf(a) })),
      { label: row.name, icon: KINDS[row.kind]?.icon, tree: tree?.id, key: row.id },
    ];
  }

  const SQL_TABS: ResultTabDecl[] = [
    { id: "result", label: L("Result", "结果"), icon: "table-2", type: "output" },
    { id: "sent", label: L("Sent SQL", "最终 SQL"), icon: "file-terminal", type: "view" },
    { id: "history", label: L("History", "历史"), icon: "history", type: "history" },
    { id: "ai", label: L("AI analysis", "AI 分析"), icon: "sparkles", type: "view" },
  ];

  const commonMore: ActionDecl[] = [
    { id: "node.duplicate", label: L("Duplicate", "复制一份"), icon: "copy", role: "command" },
    { id: "node.copyLink", label: L("Copy link", "复制链接"), icon: "link", role: "command" },
    { id: "node.delete", label: L("Delete", "删除"), icon: "trash-2", role: "command", danger: true },
  ];

  function sqlView(sql: string, envId: string | null | undefined, opts: { readOnly?: boolean; values?: Record<string, string> } = {}): ViewNode[] {
    const now = Date.now();
    const fields = sqlParamNames(sql).map((name) => {
      const field = paramField(name, now);
      if (opts.values) return { ...field, envValue: opts.values[name] ?? "", readOnly: true, presets: undefined };
      const fromEnv = resolveIn(db, envId ?? null, name);
      return fromEnv.found ? { ...field, envValue: fromEnv.display || fromEnv.value, envSource: fromEnv.sourceName } : field;
    });
    const nodes: ViewNode[] = [];
    if (fields.length > 0) nodes.push({ type: "form", id: "params", layout: "strip", label: L("Parameters", "参数"), fields });
    nodes.push({
      type: "form",
      id: "editor",
      layout: "stack",
      label: "SQL",
      fields: [{ name: "sql", label: "SQL", kind: "code", bind: "body.sql", fill: true, language: "sql", readOnly: opts.readOnly, placeholder: L("Write SQL. Parameters are written as :name.", "编写 SQL。参数写成 :name。") }],
    });
    return nodes;
  }

  function kindPage(kind: string, body: Record<string, unknown>, ctx: PageContext, isNew: boolean): Pick<PageDescriptor, "view" | "actions" | "resultTabs" | "usesEnv" | "recompute" | "values" | "autosave"> {
    const draft = ctx.draft ?? {};
    if (kind === "org.onedesk.sql:query") {
      const saved = String(body.sql ?? "");
      const sql = typeof draft["body.sql"] === "string" ? (draft["body.sql"] as string) : saved;
      return {
        view: sqlView(sql, ctx.envId),
        actions: [
          { id: "run", label: L("Run", "执行"), icon: "play", role: "run", primary: true, shortcut: ["⌘", "↵"] },
          { id: "save", label: L("Save", "保存"), icon: "save", role: "save", shortcut: ["⌘", "S"] },
          { id: "save-run", label: L("Save & run", "保存并执行"), icon: "save-all", role: "save-run" },
          { id: "format", label: L("Format", "格式化"), icon: "align-left", role: "event" },
          { id: "explain", label: L("Explain plan", "执行计划"), icon: "list-tree", role: "run" },
          { id: "export-sh", label: L("Export as .sh", "导出为 .sh"), icon: "file-terminal", role: "event" },
          ...(isNew ? [] : commonMore),
        ],
        resultTabs: SQL_TABS,
        usesEnv: true,
        recompute: true,
        values: { "body.sql": saved },
        autosave: false,
      };
    }
    if (kind === "org.onedesk.note:note") {
      return {
        view: [
          {
            type: "form",
            id: "meta",
            layout: "strip",
            label: L("Properties", "属性"),
            fields: [
              { name: "summary", label: L("Summary", "摘要"), kind: "text", bind: "body.summary" },
              { name: "owner", label: L("Owner", "负责人"), kind: "enum", bind: "body.owner", options: ["data", "ops", "finance"].map((v) => ({ value: v, label: v })) },
              { name: "review_date", label: L("Review by", "复查日期"), kind: "date", bind: "body.review_date" },
            ],
          },
          { type: "form", id: "content", layout: "stack", label: L("Content", "内容"), fields: [{ name: "content", label: L("Content", "内容"), kind: "longtext", bind: "body.content", fill: true, placeholder: L("Write the note. [[name]] links to another resource.", "写下笔记。[[名称]] 可以引用另一条资源。") }] },
        ],
        actions: [
          { id: "save", label: L("Save", "保存"), icon: "save", role: "save", primary: true, shortcut: ["⌘", "S"] },
          { id: "export-md", label: L("Export Markdown", "导出 Markdown"), icon: "download", role: "event" },
          ...(isNew ? [] : commonMore),
        ],
        resultTabs: [],
        usesEnv: false,
        recompute: false,
        values: { "body.summary": body.summary ?? "", "body.owner": body.owner ?? "data", "body.review_date": body.review_date ?? "", "body.content": body.content ?? "" },
        autosave: false,
      };
    }
    if (kind === "org.onedesk.sql:datasource") {
      const f = (name: string, label: Label, k: ViewField["kind"] = "text", extra: Partial<ViewField> = {}): ViewField => ({ name, label, kind: k, bind: `body.${name}`, ...extra });
      return {
        view: [
          {
            type: "form",
            id: "connection",
            layout: "stack",
            label: L("Connection", "连接"),
            fields: [
              f("driver", L("Driver", "驱动"), "enum", { options: [{ value: "mysql", label: "MySQL" }, { value: "postgres", label: "PostgreSQL" }, { value: "sqlite", label: "SQLite" }] }),
              f("host", L("Host", "主机")),
              f("port", L("Port", "端口"), "number"),
              f("database", L("Database", "数据库")),
              f("user", L("User", "用户")),
              f("password", L("Password", "密码"), "secret", { hint: L("Only the keychain entry name is stored; the value never leaves the keychain.", "这里只保存钥匙串条目的名字，值不离开钥匙串。") }),
              f("ssl", L("Require TLS", "要求 TLS"), "boolean"),
              f("notes", L("Notes", "备注"), "longtext"),
            ],
          },
        ],
        actions: [
          { id: "test", label: L("Test connection", "测试连接"), icon: "plug-zap", role: "run", primary: true },
          { id: "save", label: L("Save", "保存"), icon: "save", role: "save", shortcut: ["⌘", "S"] },
          ...(isNew ? [] : commonMore),
        ],
        resultTabs: [{ id: "result", label: L("Result", "结果"), icon: "terminal", type: "output" }],
        usesEnv: false,
        recompute: false,
        values: Object.fromEntries(["driver", "host", "port", "database", "user", "password", "ssl", "notes"].map((k) => [`body.${k}`, body[k] ?? (k === "driver" ? "mysql" : k === "ssl" ? "false" : "")])),
        autosave: false,
      };
    }
    if (kind === "core:config") {
      const params = (body.params ?? {}) as Record<string, ParamValue>;
      const fields = Object.entries(params).map(([name, p]): ViewField => {
        const def = CONFIG_FIELDS[name];
        return { name, label: def?.label ?? name, kind: def?.kind ?? (p.type === "boolean" ? "boolean" : p.type === "number" ? "number" : "text"), bind: `param:${name}`, options: def?.options, hint: def?.hint, readOnly: def?.readOnly };
      });
      return {
        view: [{ type: "form", id: "settings", layout: "stack", label: L("Settings", "设置"), fields }],
        actions: [],
        resultTabs: [],
        usesEnv: false,
        recompute: false,
        values: Object.fromEntries(Object.entries(params).map(([name, p]) => [`param:${name}`, p.value])),
        autosave: true,
      };
    }
    // Kinds whose plugin is missing or disabled: show what is stored, read-only.
    return {
      view: [{ type: "text", id: "raw", mono: true, tone: "muted", text: JSON.stringify(body, null, 2) }],
      actions: isNew ? [] : commonMore,
      resultTabs: [],
      usesEnv: false,
      recompute: false,
      values: {},
      autosave: false,
    };
  }

  const missingPage = (target: string, title: string): PageDescriptor => ({
    target,
    title,
    icon: "file-question",
    found: false,
    state: "broken",
    breadcrumb: [{ label: title }],
    page: "missing",
    view: [],
    actions: [],
    resultTabs: [],
    usesEnv: false,
    hasInfo: false,
    readOnly: true,
    recompute: false,
    values: {},
    autosave: false,
  });

  const shellPage = (target: string, title: string, icon: string, page: PageDescriptor["page"], breadcrumb: Crumb[], extra: Partial<PageDescriptor> = {}): PageDescriptor => ({
    target,
    title,
    icon,
    found: true,
    state: "ok",
    breadcrumb,
    page,
    view: [],
    actions: [],
    resultTabs: [],
    usesEnv: false,
    hasInfo: false,
    readOnly: false,
    recompute: false,
    values: {},
    autosave: false,
    ...extra,
  });

  function fileAt(path: string): { file: FakeFile; trail: FakeFile[] } | null {
    let list = FILE_ROOTS;
    const trail: FakeFile[] = [];
    for (const part of path.split("/")) {
      const file = list[Number(part)];
      if (!file) return null;
      trail.push(file);
      list = file.children ?? [];
    }
    return { file: trail[trail.length - 1]!, trail };
  }

  const fmtSize = (n?: number) => (n === undefined ? "" : n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

  function resolvePage(target: string, ctx: PageContext): PageDescriptor {
    const [scheme, rest = ""] = [target.slice(0, target.indexOf(":")), target.slice(target.indexOf(":") + 1)];
    if (scheme === "resource") {
      const row = db.rows[rest];
      if (!row) return missingPage(target, rest);
      if (row.deletedAt) return { ...missingPage(target, row.name), stateReason: L("This item is in Deleted. Restore it to open it again.", "这一项在“已删除”里。恢复后才能再打开。") };
      const { state, reason } = stateOf(row);
      const base = { target, title: row.name, icon: KINDS[row.kind]?.icon ?? "file", kindLabel: KINDS[row.kind]?.label, found: true, state, stateReason: reason, breadcrumb: crumbsFor(row), resourceId: row.id };
      if (row.kind === "core:env") {
        return {
          ...shellPage(target, row.name, base.icon, "env", base.breadcrumb, { resourceId: row.id, kindLabel: base.kindLabel }),
          actions: [
            { id: "env.useInTab", label: L("Use in tab", "用于标签页"), icon: "circle-check", role: "command" },
            { id: "env.newChild", label: L("New child", "新建子环境"), icon: "plus", role: "command" },
            { id: "export-sh", label: L("Export .sh", "导出 .sh"), icon: "file-terminal", role: "event" },
            { id: "node.duplicate", label: L("Duplicate", "复制一份"), icon: "copy", role: "command" },
            { id: "node.delete", label: L("Delete", "删除"), icon: "trash-2", role: "command", danger: true },
          ],
        };
      }
      const page = kindPage(row.kind, row.body, ctx, false);
      const readOnly = state !== "ok";
      return {
        ...base,
        page: "view",
        ...page,
        actions: readOnly ? page.actions.filter((a) => a.role === "command").map((a) => ({ ...a, disabled: a.id !== "node.delete" && a.id !== "node.copyLink" })) : page.actions,
        hasInfo: row.kind !== "core:config",
        readOnly,
      };
    }
    if (scheme === "new") {
      const [kind = "", query = ""] = rest.split("?");
      const def = KINDS[kind];
      if (!def) return missingPage(target, kind);
      const parentId = new URLSearchParams(query).get("parent");
      const parent = parentId ? db.rows[parentId] : undefined;
      const title = kind.endsWith(":query") ? "Untitled query" : kind.endsWith(":note") ? "Untitled note" : "New data source";
      const page = kindPage(kind, {}, ctx, true);
      return {
        target,
        title,
        icon: def.icon,
        kindLabel: def.label,
        found: true,
        state: "ok",
        breadcrumb: [...(parent ? crumbsFor(parent) : []), { label: title, icon: def.icon }],
        page: "view",
        ...page,
        hasInfo: false,
        readOnly: false,
      };
    }
    if (scheme === "plugin") {
      const p = db.plugins.find((x) => x.id === rest);
      if (!p) return missingPage(target, rest);
      const name = typeof p.name === "string" ? p.name : (p.name["en-US"] ?? "");
      return shellPage(target, name, p.icon, "plugin", [{ label: name, icon: p.icon, tree: "plugins", key: p.id }], {
        state: !p.installed ? "missing-plugin" : pluginBroken(p) ? "broken" : p.enabled ? "ok" : "disabled",
      });
    }
    if (scheme === "run") {
      const run = db.runs.find((r) => r.id === rest);
      if (!run) return missingPage(target, rest);
      const row = run.resourceId ? db.rows[run.resourceId] : undefined;
      const title = `#${run.seq} ${run.title}`;
      const crumbs: Crumb[] = [...(row ? crumbsFor(row).map((c, i, all) => (i === all.length - 1 ? { ...c, target: `resource:${row.id}` } : c)) : []), { label: `#${run.seq}`, icon: "history" }];
      const isSql = typeof run.input["body.sql"] === "string";
      return {
        target,
        title,
        icon: "history",
        kindLabel: L("Run record", "运行记录"),
        found: true,
        state: "ok",
        breadcrumb: crumbs,
        page: "view",
        view: isSql ? sqlView(String(run.input["body.sql"]), run.envId, { readOnly: true, values: run.params }) : [{ type: "text", id: "input", mono: true, text: JSON.stringify(run.input, null, 2) }],
        actions: [
          ...(row && !row.deletedAt
            ? ([
                { id: "run.reuse", label: L("Reuse parameters", "复用参数"), icon: "repeat", role: "command", primary: true },
                { id: "run.openResource", label: L("Open query", "打开查询"), icon: "arrow-up-right", role: "command" },
              ] satisfies ActionDecl[])
            : []),
          { id: run.kept ? "run.unkeep" : "run.keep", label: run.kept ? L("Stop keeping", "取消保留") : L("Keep result", "保留结果"), icon: run.kept ? "pin-off" : "pin", role: "command" },
        ],
        resultTabs: isSql ? SQL_TABS.filter((t) => t.id !== "history") : [{ id: "result", label: L("Result", "结果"), icon: "terminal", type: "output" }],
        resourceId: undefined,
        runId: run.id,
        usesEnv: false,
        hasInfo: false,
        readOnly: true,
        recompute: false,
        values: clone(run.input),
        autosave: false,
      };
    }
    if (scheme === "core") {
      if (rest === "audit") return shellPage(target, "审计 Audit", "scroll-text", "audit", [{ label: "审计 Audit", icon: "scroll-text", tree: "config", key: "cfg-audit" }]);
      if (rest === "deleted") return shellPage(target, "Deleted", "trash-2", "deleted", [{ label: "Deleted", icon: "trash-2" }]);
    }
    if (scheme === "node" && rest.startsWith("files/")) {
      const path = rest.slice(6);
      const hit = fileAt(path);
      if (!hit) return missingPage(target, rest);
      const { file, trail } = hit;
      const parts = path.split("/");
      const crumbs = trail.map((f, i): Crumb => ({ label: f.name, icon: f.children ? "folder" : "file", tree: "files", key: `f:${parts.slice(0, i + 1).join("/")}`, target: i < trail.length - 1 ? `node:files/${parts.slice(0, i + 1).join("/")}` : undefined }));
      const view: ViewNode[] = file.children
        ? [
            {
              type: "table",
              id: "files",
              columns: [{ key: "name", label: "Name" }, { key: "size", label: "Size" }, { key: "modified", label: "Modified" }, { key: "type", label: "Type" }],
              rows: file.children.map((c) => [c.name, fmtSize(c.size), c.modifiedDaysAgo === undefined ? "" : fmtDate(Date.now() - c.modifiedDaysAgo * DAY), c.children ? "Folder" : (c.name.split(".").pop() ?? "").toUpperCase()]),
              rowTargets: file.children.map((_c, i) => `node:files/${path}/${i}`),
            },
          ]
        : file.content !== undefined
          ? [{ type: "text", id: "content", mono: true, text: file.content, language: file.name.endsWith(".sql") ? "sql" : undefined }]
          : [{ type: "placeholder", id: "binary", icon: "file", message: L("This file type has no preview.", "这种文件没有预览。") }];
      return {
        ...shellPage(target, file.name.split("/").pop()!, file.children ? "folder" : "file", "view", crumbs),
        view,
        kindLabel: file.children ? L("Folder", "文件夹") : L("File", "文件"),
        actions: file.children
          ? [{ id: "import.folder", label: L("Import folder", "导入文件夹"), icon: "folder-input", role: "command", primary: true }]
          : [{ id: "file.import", label: L("Import as SQL query", "导入为 SQL 查询"), icon: "file-input", role: "event", disabled: !file.name.endsWith(".sql") }, { id: "file.copyPath", label: L("Copy path", "复制路径"), icon: "clipboard", role: "command" }],
        readOnly: true,
      };
    }
    return missingPage(target, target);
  }

  /* ---------------------------------------------------------------- runs (§8) */
  function tableMissing(): NonNullable<Run["error"]> {
    return {
    code: "1146 (42S02)",
    message: "Table 'shop.legacy_orders_2019' doesn't exist",
    detail: "ERROR 1146 (42S02) at line 3: Table 'shop.legacy_orders_2019' doesn't exist\n  near: LEFT JOIN legacy_orders_2019 l ON l.order_id = r.order_id",
    hint: "The table was archived in 2024. Use orders_archive.orders_2019, or run this against the analytics data source.",
    };
  }

  function outputOf(run: StoredRun): RunOutput | undefined {
    if (!run.out) return run.status === "success" ? { type: "none" } : undefined;
    if (run.out.kind === "text") return (run.out.format ? { type: "text", text: run.out.text, format: run.out.format } : { type: "text", text: run.out.text }) as RunOutput;
    const { columns, rows } = generateTable(run.out.dataset, Math.min(run.out.rows, 1000), run.out.seed, run.startedAt);
    return { type: "table", columns, rows, total: run.out.rows, truncated: run.out.rows > 1000 };
  }

  const publicRun = (run: StoredRun, withOutput: boolean): Run => {
    const { out: _out, ...rest } = run;
    return { ...clone(rest), output: withOutput ? outputOf(run) : undefined };
  };

  function finish(run: StoredRun, result: { status: Run["status"]; out?: OutSpec; error?: Run["error"]; message?: string; rows?: number }) {
    window.clearInterval(timers.get(run.id));
    timers.delete(run.id);
    run.status = result.status;
    run.endedAt = Date.now();
    run.progress = undefined;
    run.out = result.out;
    run.partial = undefined;
    run.error = result.error;
    run.cancellable = false;
    run.summary = { rows: result.rows, message: result.message, durationMs: run.endedAt - run.startedAt };
    audit(
      result.error?.code.startsWith("policy") ? "policy.deny" : "run.end",
      run.title,
      result.error ? result.error.message : result.rows !== undefined ? `${result.rows} rows · ${(run.summary.durationMs! / 1000).toFixed(2)} s` : (result.message ?? ""),
      result.error ? (result.error.code.startsWith("policy") ? "denied" : "error") : "ok",
    );
    // Keep the newest 200 per resource (I.5); kept runs are exempt.
    if (run.resourceId) {
      const mine = db.runs.filter((r) => r.resourceId === run.resourceId && !r.kept);
      if (mine.length > 200) db.runs = db.runs.filter((r) => r !== mine[0]);
    }
    persist();
    emit(`run:${run.id}`, "runs", "tree:runs");
  }

  function animate(run: StoredRun, totalMs: number, message: (fraction: number) => string, done: () => void, failAt?: { fraction: number; fail: () => void }) {
    const started = Date.now();
    const id = window.setInterval(() => {
      const fraction = Math.min(1, (Date.now() - started) / totalMs);
      if (failAt && fraction >= failAt.fraction) return failAt.fail();
      if (fraction >= 1) return done();
      run.progress = { fraction, message: message(fraction) };
      emit(`run:${run.id}`, "runs");
    }, 140);
    timers.set(run.id, id);
  }

  function startRun(req: RunRequest): string {
    const row = req.resourceId ? db.rows[req.resourceId] : undefined;
    const def = row ? KINDS[row.kind] : undefined;
    db.runSeq += 1;
    const env = req.envId ? db.rows[req.envId] : undefined;
    const sql = typeof req.input["body.sql"] === "string" ? (req.input["body.sql"] as string) : undefined;
    const labels: Record<string, Label> = { run: L("Run", "执行"), explain: L("Explain plan", "执行计划"), test: L("Test connection", "测试连接"), import: L("Import folder", "导入文件夹") };
    const run: StoredRun = {
      id: `run-${db.runSeq}`,
      seq: db.runSeq,
      title: row?.name ?? (req.action === "import" ? "Import folder ~/Documents/sql-archive" : "Untitled query"),
      icon: def?.icon ?? (req.action === "import" ? "folder-input" : "file-code"),
      resourceId: row?.id,
      action: req.action,
      actionLabel: labels[req.action] ?? req.action,
      tabId: req.tabId || undefined,
      envId: env?.id,
      envName: env?.name,
      actor: ME,
      source: "user",
      startedAt: Date.now(),
      status: "running",
      params: { ...req.params },
      input: clone(req.input),
      progress: { fraction: 0, message: "Starting…" },
      kept: false,
      inTaskPanel: true,
      cancellable: true,
    };
    db.runs.push(run);
    audit("run.start", run.title, env ? `env: ${env.name}` : "");
    emit("runs", "tree:runs", `run:${run.id}`);
    persist();

    const fail = (error: NonNullable<Run["error"]>) => finish(run, { status: "error", error });

    if (req.action === "import") {
      const total = 212;
      animate(run, 38_000, (f) => `Imported ${Math.floor(f * total)} / ${total} files · ${10 + Math.floor(f * 7)} files/s`, () => finish(run, { status: "success", message: `${total} files imported, 3 skipped (same name)` }));
      return run.id;
    }
    if (req.action === "test") {
      const body = (row?.body ?? {}) as Record<string, string>;
      const host = String(req.input["body.host"] ?? body.host ?? "");
      animate(
        run,
        900,
        () => `Connecting to ${host || String(req.input["body.database"] ?? "")}…`,
        () =>
          row?.state === "missing" || String(req.input["body.driver"]) === "sqlite"
            ? fail({ code: "SQLITE_CANTOPEN", message: "unable to open database file", detail: `sqlite3: ${String(req.input["body.database"] ?? "")}: unable to open database file`, hint: "Check that the file exists and that OneDesk may read its folder." })
            : finish(run, { status: "success", out: { kind: "text", text: `Connected to ${host}:${String(req.input["body.port"] ?? "")} in 38 ms\nServer: ${String(req.input["body.driver"]) === "postgres" ? "PostgreSQL 16.4" : "MySQL 8.0.36"} · TLS 1.3 · user ${String(req.input["body.user"] ?? "")}\nRead-only: yes` }, message: "Connected in 38 ms" }),
      );
      return run.id;
    }

    if (req.action === "generate" || req.action === "org.onedesk.ai:analyze") {
      // Round 18 (X17): an AI-style run whose text arrives piece by piece as `Run.partial` (the whole text so far each time).
      const full = "## Summary\n\nOrders grew **12%** week over week.\n\n- Most growth came from repeat customers\n- Refunds stayed flat\n\n```sql\nSELECT 1;\n```";
      animate(
        run,
        3000,
        (f) => {
          run.partial = { type: "text", text: full.slice(0, Math.ceil(full.length * f)), format: "markdown" } as RunOutput;
          return "Generating…";
        },
        () => finish(run, { status: "success", out: { kind: "text", text: full, format: "markdown" }, message: "Generated" }),
      );
      return run.id;
    }

    // SQL run / explain
    const text = sql ?? "";
    const sim = ((row?.body.sim as Sim | undefined) ?? { dataset: "generic", rows: 25, ms: 900 }) as Sim;
    const source = resolveIn(db, req.envId, "datasource");
    const missing = sqlParamNames(text).filter((n) => !run.params[n]);
    if (!text.trim()) {
      setTimeout(() => fail({ code: "input.empty", message: "There is no SQL to run.", hint: "Write a statement in the editor." }), 200);
    } else if (!req.envId || !env) {
      setTimeout(() => fail({ code: "env.missing", message: "This tab has no environment, so there is no data source to run against.", hint: "Pick an environment at the top right of the tab." }), 200);
    } else if (missing.length > 0) {
      setTimeout(() => fail({ code: "input.missing", message: `No value for ${missing.map((m) => `:${m}`).join(", ")}.`, hint: "Fill it in the parameter strip, or define it in the environment." }), 200);
    } else if (/^\s*(--[^\n]*\n\s*)*(delete|update|insert|drop|truncate|alter)\b/i.test(text) && resolveEffectiveReadonly(req.envId)) {
      setTimeout(
        () =>
          fail({
            code: "policy.readonly",
            message: `Blocked by policy: ${env.name} is read-only (protection.readonly).`,
            detail: "The statement changes data. Nothing was sent to the data source.",
            hint: "Run it in an environment that allows writes, e.g. 测试 Staging.",
          }),
        350,
      );
    } else if (req.action === "explain") {
      animate(run, 600, () => "Explaining…", () =>
        finish(run, {
          status: "success",
          out: {
            kind: "text",
            text: "+----+-------------+-------+------+---------------------+--------------+---------+-------+--------+-------------+\n| id | select_type | table | type | possible_keys       | key          | key_len | ref   | rows   | Extra       |\n+----+-------------+-------+------+---------------------+--------------+---------+-------+--------+-------------+\n|  1 | SIMPLE      | o     | ref  | idx_tenant_created  | idx_tenant_… | 8       | const | 184220 | Using where |\n|  1 | SIMPLE      | c     | eq_… | PRIMARY             | PRIMARY      | 8       | o.cu… |      1 | NULL        |\n+----+-------------+-------+------+---------------------+--------------+---------+-------+--------+-------------+\n2 rows in set, 1 warning (0.01 sec)",
          },
          message: "2 rows",
        }),
      );
    } else {
      const limit = Number(run.params.limit);
      const total = sim.affected !== undefined ? 0 : Math.max(0, Number.isFinite(limit) && limit > 0 ? Math.min(sim.rows ?? 25, limit) : (sim.rows ?? 25));
      const ms = sim.ms ?? 900;
      const name = source.found ? source.display : "data source";
      const message = (f: number) => (f < 0.12 ? `Connecting to ${name}…` : f < 0.35 ? "Executing…" : `Fetched ${Math.floor(((f - 0.35) / 0.65) * total).toLocaleString("en-US")} / ${total.toLocaleString("en-US")} rows`);
      const broken = /legacy_orders_2019/i.test(text);
      animate(
        run,
        ms,
        message,
        () =>
          sim.affected !== undefined
            ? finish(run, { status: "success", out: { kind: "text", text: `Query OK, ${sim.affected.toLocaleString("en-US")} rows affected (${(ms / 1000).toFixed(2)} sec)` }, message: `${sim.affected.toLocaleString("en-US")} rows affected` })
            : finish(run, { status: "success", out: { kind: "table", dataset: sim.dataset ?? "generic", rows: total, seed: run.seq }, rows: total }),
        broken ? { fraction: 0.3, fail: () => fail(tableMissing()) } : undefined,
      );
    }
    return run.id;
  }

  function resolveEffectiveReadonly(envId: string | null): boolean {
    // "Any layer forbids → forbidden" (§6.3): walk the whole chain, not just the nearest value.
    for (let env = envId ? db.rows[envId] : undefined; env; env = env.parentId ? db.rows[env.parentId] : undefined) {
      if (paramsOf(env)["protection.readonly"]?.value === "true") return true;
    }
    return false;
  }

  // Resume the animation of a freshly seeded background run.
  for (const run of db.runs) {
    if (run.status === "running" && run.action === "import") {
      animate(run, 38_000, (f) => `Imported ${Math.floor(f * 212)} / 212 files · ${10 + Math.floor(f * 7)} files/s`, () => finish(run, { status: "success", message: "212 files imported, 3 skipped (same name)" }));
    }
  }

  /* ---------------------------------------------------------------- provided trees */
  const runIcon = (r: StoredRun) => (r.status === "running" ? "loader" : r.status === "success" ? "circle-check" : r.status === "error" ? "circle-alert" : "circle-slash");

  function providedChildren(tree: string, parentKey: string | null): TreeNode[] {
    const base = { tree, parentKey: parentKey ?? undefined, expandable: false, state: "ok" as NodeState, draggable: false, accepts: [] as string[] };
    if (tree === "plugins") {
      return [...db.plugins]
        .sort((a, b) => Number(b.installed) - Number(a.installed) || a.id.localeCompare(b.id))
        .map((p) => ({
          ...base,
          key: p.id,
          label: typeof p.name === "string" ? p.name : `${p.name["en-US"]}`,
          icon: p.icon,
          kind: "plugin",
          state: !p.installed ? "missing-plugin" : pluginBroken(p) ? "broken" : p.enabled ? "ok" : "disabled",
          stateReason: !p.installed ? L("Not installed", "未安装") : pluginBroken(p) ? L("Failed to load", "加载失败") : p.enabled ? undefined : L("Disabled", "已停用"),
          badge: p.versions.find((v) => v.active)?.version,
          target: `plugin:${p.id}`,
          menu: [
            { id: "node.open", label: L("Open plugin page", "打开插件页"), icon: "arrow-up-right" },
            p.enabled ? { id: "plugin.disable", label: L("Disable", "停用"), icon: "circle-slash", disabled: !p.installed } : { id: "plugin.enable", label: L("Enable", "启用"), icon: "circle-check", disabled: !p.installed },
          ],
        }));
    }
    if (tree === "runs") {
      return [...db.runs]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 80)
        .map((r) => ({
          ...base,
          key: r.id,
          label: `#${r.seq} ${r.title}`,
          icon: runIcon(r),
          kind: "run",
          badge: fmtDateTime(r.startedAt).slice(5, 16),
          state: r.status === "cancelled" ? "disabled" : "ok",
          target: `run:${r.id}`,
          menu: [
            { id: "node.open", label: L("Open run", "打开这次运行"), icon: "arrow-up-right" },
            ...(r.resourceId ? [{ id: "run.reuse", label: L("Reuse parameters", "复用参数"), icon: "repeat" }, { id: "run.openResource", label: L("Open query", "打开查询"), icon: "file-code" }] : []),
          ],
        }));
    }
    if (tree === "favorites") {
      return db.favorites
        .map((id) => db.rows[id])
        .filter((r): r is Row => Boolean(r && live(r)))
        .map((r) => ({
          ...toNode(r),
          ...base,
          key: `fav:${r.id}`,
          state: stateOf(r).state,
          target: targetOf(r),
          menu: [
            { id: "node.open", label: L("Open", "打开"), icon: "arrow-up-right" },
            { id: "node.reveal", label: L("Show in its tree", "在所属的树中显示"), icon: "locate" },
            { id: "node.unfavorite", label: L("Remove from favorites", "取消收藏"), icon: "star-off", separatorBefore: true },
          ],
        }));
    }
    if (tree === "deleted") {
      return Object.values(db.rows)
        .filter((r) => r.deletedAt && (!r.parentId || !db.rows[r.parentId]?.deletedAt || db.rows[r.parentId]!.deletedAt !== r.deletedAt))
        .sort((a, b) => b.deletedAt! - a.deletedAt!)
        .map((r) => ({
          ...base,
          key: `del:${r.id}`,
          label: r.name,
          icon: KINDS[r.kind]?.icon ?? "file",
          kind: r.kind,
          badge: fmtDate(r.deletedAt!).slice(5),
          target: "core:deleted",
          menu: [
            { id: "deleted.restore", label: L("Restore", "恢复"), icon: "undo-2" },
            { id: "deleted.purge", label: L("Delete permanently", "永久删除"), icon: "trash-2", danger: true, separatorBefore: true },
          ],
        }));
    }
    if (tree === "files") {
      const list = parentKey ? (fileAt(parentKey.slice(2))?.file.children ?? []) : FILE_ROOTS;
      const prefix = parentKey ? `${parentKey.slice(2)}/` : "";
      return list.map((f, i) => ({
        ...base,
        key: `f:${prefix}${i}`,
        label: f.name,
        icon: f.children ? "folder" : f.name.endsWith(".sql") ? "file-code" : f.name.endsWith(".csv") || f.name.endsWith(".xlsx") ? "file-spreadsheet" : "file-text",
        kind: f.children ? "folder" : "file",
        expandable: Boolean(f.children),
        badge: f.children ? undefined : fmtSize(f.size),
        target: `node:files/${prefix}${i}`,
        menu: [
          { id: "node.open", label: L("Open", "打开"), icon: "arrow-up-right" },
          { id: "file.copyPath", label: L("Copy path", "复制路径"), icon: "clipboard" },
          ...(f.children ? [{ id: "import.folder", label: L("Import folder", "导入文件夹"), icon: "folder-input", separatorBefore: true }] : []),
        ],
      }));
    }
    return [];
  }

  /* ---------------------------------------------------------------- commands */
  const rowOfKey = (key: string | null | undefined): Row | undefined => (key ? db.rows[key.replace(/^(fav|del):/, "")] : undefined);

  function softDelete(row: Row) {
    const at = Date.now();
    const all = [row];
    for (let i = 0; i < all.length; i++) all.push(...Object.values(db.rows).filter((r) => r.parentId === all[i]!.id && live(r)));
    for (const r of all) r.deletedAt = at;
    audit("resource.delete", row.name, all.length > 1 ? `${all.length} items` : "");
    persist();
    emit(`tree:${row.tree}`, "tree:deleted", "tree:favorites", ...all.map((r) => `resource:${r.id}`), row.kind === "core:env" ? "env" : "tree:deleted");
    return all;
  }

  function createRow(kind: string, tree: string, parentId: string | null, name: string, body: Record<string, unknown>): Row {
    const siblings = childrenOf(tree, parentId);
    const now = Date.now();
    const row: Row = { id: newId("r"), kind, tree, parentId, pos: (siblings[siblings.length - 1]?.pos ?? -1) + 1, name, description: "", tags: [], body, state: "ok", origin: "original", rev: 1, createdAt: now, createdBy: ME, updatedAt: now, updatedBy: ME };
    db.rows[row.id] = row;
    audit("resource.create", name, KINDS[kind]?.plugin ?? "core");
    persist();
    emit(`tree:${tree}`, kind === "core:env" ? "env" : `tree:${tree}`);
    return row;
  }

  const uniqueName = (tree: string, parentId: string | null, base: string) => {
    const names = new Set(childrenOf(tree, parentId).map((r) => r.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  };

  function execute(id: string, ctx: CommandContext): CommandEffect[] {
    const tree = ctx.tree;
    const key = ctx.nodeKey ?? null;
    const fromTarget = ctx.target?.startsWith("resource:") ? db.rows[ctx.target.slice(9)] : undefined;
    const row = rowOfKey(key) ?? fromTarget;
    const run = db.runs.find((r) => r.id === (key ?? ctx.target?.replace(/^run:/, "")));

    if (id.startsWith("new:")) {
      const kind = id.slice(4);
      if (kind === "core:env") {
        const parent = row?.kind === "core:env" ? row : undefined;
        const created = createRow("core:env", "environments", parent?.id ?? null, uniqueName("environments", parent?.id ?? null, "New environment"), { params: {} });
        return [{ type: "reveal", tree: "environments", key: created.id }, { type: "open", target: `resource:${created.id}` }, { type: "rename", tree: "environments", key: created.id }];
      }
      const parent = row ? (row.kind === "core:group" ? row.id : row.parentId) : null;
      const okTree = KINDS[kind]?.tree;
      return [{ type: "open", target: `new:${kind}${parent && row?.tree === okTree ? `?parent=${parent}` : ""}` }];
    }
    switch (id) {
      case "node.open": {
        const t = key?.startsWith("f:") ? `node:files/${key.slice(2)}` : tree === "plugins" && key ? `plugin:${key}` : run ? `run:${run.id}` : key?.startsWith("del:") ? "core:deleted" : row ? targetOf(row) : undefined;
        return t ? [{ type: "open", target: t }] : [];
      }
      case "node.rename":
        return row && tree ? [{ type: "rename", tree, key: row.id }] : [];
      case "node.reveal":
        return row ? [{ type: "reveal", tree: row.tree, key: row.id }] : [];
      case "node.duplicate": {
        if (!row) return [];
        const copy = createRow(row.kind, row.tree, row.parentId, uniqueName(row.tree, row.parentId, `${row.name} copy`), clone(row.body));
        copy.description = row.description;
        copy.tags = [...row.tags];
        copy.origin = "copied";
        return [{ type: "reveal", tree: copy.tree, key: copy.id }, { type: "toast", message: L(`Duplicated as “${copy.name}”`, `已复制为“${copy.name}”`), tone: "success" }];
      }
      case "node.favorite":
      case "node.unfavorite": {
        if (!row) return [];
        db.favorites = id === "node.favorite" ? [...new Set([...db.favorites, row.id])] : db.favorites.filter((f) => f !== row.id);
        persist();
        emit("tree:favorites", `tree:${row.tree}`, `resource:${row.id}`);
        return [{ type: "toast", message: id === "node.favorite" ? L("Added to favorites", "已收藏") : L("Removed from favorites", "已取消收藏"), tone: "success" }];
      }
      case "node.copyLink":
        return [{ type: "toast", message: L(`Link copied: onedesk://resource/${row?.id ?? ""}`, `已复制链接：onedesk://resource/${row?.id ?? ""}`), tone: "info" }];
      case "node.delete": {
        if (!row) return [];
        const all = softDelete(row);
        return [...all.map((r): CommandEffect => ({ type: "close-target", target: `resource:${r.id}` })), { type: "toast", message: L(`Moved “${row.name}” to Deleted`, `“${row.name}”已移到“已删除”`), tone: "info" }];
      }
      case "node.newGroup": {
        const t = tree ?? row?.tree ?? "resources";
        const parent = row ? (row.kind === "core:group" ? row.id : row.parentId) : null;
        const g = createRow("core:group", t, parent, uniqueName(t, parent, "New group"), {});
        return [{ type: "reveal", tree: t, key: g.id }, { type: "rename", tree: t, key: g.id }];
      }
      case "env.useInTab":
        return row ? [{ type: "set-tab-env", envId: row.id }] : [];
      case "env.newChild":
        return execute("new:core:env", ctx);
      case "plugin.enable":
      case "plugin.disable": {
        const p = db.plugins.find((x) => x.id === key);
        if (p) setPluginEnabled(p, id === "plugin.enable");
        return [];
      }
      case "deleted.restore":
        if (row) undelete(row);
        return row ? [{ type: "toast", message: L(`Restored “${row.name}”`, `已恢复“${row.name}”`), tone: "success" }, { type: "reveal", tree: row.tree, key: row.id }] : [];
      case "deleted.purge":
        if (row) purge(row);
        return [];
      case "run.reuse":
        return run?.resourceId ? [{ type: "open", target: `resource:${run.resourceId}`, state: { params: { ...run.params }, envId: run.envId ?? null } }, { type: "toast", message: L(`Parameters of run #${run.seq} filled in`, `已填入第 ${run.seq} 次运行的参数`), tone: "info" }] : [];
      case "run.openResource":
        return run?.resourceId ? [{ type: "open", target: `resource:${run.resourceId}` }] : [];
      case "run.keep":
      case "run.unkeep":
        if (run) {
          run.kept = id === "run.keep";
          persist();
          emit(`run:${run.id}`, "runs");
        }
        return [{ type: "toast", message: id === "run.keep" ? L("Result kept; it is exempt from the 200-run limit", "已保留结果，不受 200 次的限制") : L("Result no longer kept", "已取消保留"), tone: "success" }];
      case "file.copyPath":
        return [{ type: "toast", message: L("Path copied", "已复制路径"), tone: "info" }];
      case "import.folder":
        startRun({ action: "import", target: "node:files/0", tabId: "", envId: null, input: { folder: "~/Documents/sql-archive" }, params: {} });
        return [{ type: "show-tasks" }, { type: "toast", message: L("Import started; progress is in the task panel", "已开始导入，进度在任务面板"), tone: "info" }];
      case "import.file":
        return [{ type: "toast", message: L("The system file picker is not part of this prototype", "原型不包含系统的文件选择窗口"), tone: "warning" }];
      case "open.audit":
        return [{ type: "open", target: "core:audit" }];
      case "open.deleted":
        return [{ type: "open", target: "core:deleted" }];
      case "demo.failing":
        return [{ type: "open", target: "resource:q-refund-recon" }];
      case "demo.reset":
        try {
          localStorage.removeItem(DB_KEY);
          for (const k of Object.keys(localStorage)) if (k.startsWith(UI_PREFIX)) localStorage.removeItem(k);
        } catch {
          /* ignore */
        }
        window.clearTimeout(saveTimer);
        return [{ type: "reload" }];
      default:
        return [{ type: "toast", message: L(`“${id}” is not implemented in the prototype`, `原型没有实现“${id}”`), tone: "warning" }];
    }
  }

  function undelete(row: Row) {
    const at = row.deletedAt;
    for (const r of Object.values(db.rows)) if (r.deletedAt === at) delete r.deletedAt;
    if (row.parentId && db.rows[row.parentId]?.deletedAt) row.parentId = null;
    audit("resource.restore", row.name);
    persist();
    emit(`tree:${row.tree}`, "tree:deleted", "tree:favorites", `resource:${row.id}`, row.kind === "core:env" ? "env" : "tree:deleted");
  }

  function purge(row: Row) {
    const at = row.deletedAt;
    for (const r of Object.values(db.rows)) if (r.deletedAt === at) delete db.rows[r.id];
    audit("resource.delete", row.name, "permanent");
    persist();
    emit("tree:deleted");
  }

  function setPluginEnabled(p: PluginRow, enabled: boolean) {
    if (!p.installed || p.enabled === enabled) return;
    p.enabled = enabled;
    // A disabled plugin's runs are cancelled (§8).
    if (!enabled) {
      for (const run of db.runs) {
        if (run.status === "running" && run.resourceId && KINDS[db.rows[run.resourceId]?.kind ?? ""]?.plugin === p.id) finish(run, { status: "cancelled", message: "Plugin disabled" });
      }
    }
    audit(enabled ? "plugin.enable" : "plugin.disable", p.id);
    persist();
    emit("plugins", "tree:plugins", "tree:resources", "tree:datasources", "tree:favorites");
  }

  /** Demo only (round 7): the one notification plugin declares that it needs the HTTP plugin; the real kernel derives this from `depends`. */
  const DEMO_DEPENDS: Record<string, { id: string; range: string }> = { "com.example.slack-notify": { id: "org.onedesk.http", range: ">=0.1.0" } };

  function pluginDeps(p: PluginRow): Pick<PluginDetail, "depends" | "dependents"> {
    const need = DEMO_DEPENDS[p.id];
    const depends = need
      ? [(() => {
          const target = db.plugins.find((x) => x.id === need.id);
          const activeVersion = target?.installed && target.enabled ? target.versions.find((v) => v.active)?.version : undefined;
          return { id: need.id, range: need.range, satisfied: activeVersion !== undefined, activeVersion };
        })()]
      : [];
    const dependents = Object.entries(DEMO_DEPENDS)
      .filter(([id, d]) => d.id === p.id && db.plugins.some((x) => x.id === id && x.installed && x.enabled))
      .map(([id]) => id);
    return { depends, dependents };
  }

  function pluginDetail(p: PluginRow): PluginDetail {
    const broken = pluginBroken(p);
    const kinds = Object.entries(KINDS).filter(([, d]) => d.plugin === p.id).map(([k]) => k);
    return {
      ...clone({ id: p.id, name: p.name, icon: p.icon, description: p.description, author: p.author, license: p.license, homepage: p.homepage, enabled: p.enabled, builtin: p.builtin, versions: p.versions, settings: p.settings, permissions: p.permissions, provides: p.provides }),
      load: !p.installed
        ? { state: "not-installed" }
        : !p.enabled
          ? { state: "disabled" }
          : broken
            ? { state: "error", message: p.bad!.reason }
            : { state: "loaded", at: Date.now() - 2 * HOUR, ms: p.loadMs || 18 },
      resourceCount: Object.values(db.rows).filter((r) => live(r) && kinds.includes(r.kind)).length,
      folders: [...(demoGrants.get(p.id) ?? [])],
      unconfirmed: [],
      ...pluginDeps(p),
    };
  }

  /* ---------------------------------------------------------------- round 5: references, protection, export/import (demo) */
  /** `readonly` / `noExport` when a workspace configuration node switches the policy on (§6.3). */
  function protections(): string[] {
    const out: string[] = [];
    for (const r of Object.values(db.rows)) {
      if (r.kind !== "core:config" || !live(r)) continue;
      const p = paramsOf(r);
      if (p["protection.readonly"]?.value === "true" && !out.includes("readonly")) out.push("readonly");
      if (p["protection.no_export"]?.value === "true" && !out.includes("noExport")) out.push("noExport");
    }
    return out;
  }
  function deny(reason: "readonly" | "noExport"): never {
    const layer = Object.values(db.rows).find((r) => r.kind === "core:config" && live(r))?.id ?? "";
    throw new KernelError("denied", { reason, layer });
  }
  const guardWrite = () => protections().includes("readonly") && deny("readonly");
  const refTarget = (name: string) => {
    const all = Object.values(db.rows).filter((r) => r.name === name && !r.kind.startsWith("core:"));
    return all.find(live) ?? all[0];
  };
  const FIELD_LABELS_ZH: Record<string, string> = { text: "正文", note: "备注", description: "说明" };
  /** `[[name]]` in the string fields of a body, in order. */
  function outgoingRefs(row: Row): RefInfo[] {
    const out: RefInfo[] = [];
    for (const [field, value] of Object.entries(row.body)) {
      if (typeof value !== "string") continue;
      for (const m of value.matchAll(/\[\[([^\[\]\n]{1,200})\]\]/g)) {
        const target = refTarget(m[1]!);
        out.push({ source: { id: row.id, name: row.name }, field: `body.${field}`, fieldLabel: { "en-US": field.charAt(0).toUpperCase() + field.slice(1), "zh-CN": FIELD_LABELS_ZH[field] ?? field }, text: m[1]!, ...(target ? { target: { id: target.id, name: target.name } } : {}), state: !target ? "missing" : target.deletedAt ? "deleted" : "ok" });
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- the client */
  async function updateResource(id: string, patch: ResourcePatch): Promise<Resource> {
    await wait(40);
    const row = db.rows[id];
    if (!row) throw new Error("Resource not found");
    if (stateOf(row).state === "conflict") throw new Error("This resource has a conflict and is read-only");
    guardWrite();
    applyPatch(row, patch);
    return toResource(row);
  }

  async function createResource(newTarget: string, patch: ResourcePatch): Promise<Resource> {
    await wait(40);
    const [kind = "", query = ""] = newTarget.slice(4).split("?");
    const def = KINDS[kind];
    if (!def) throw new Error("Unknown kind");
    const parentId = new URLSearchParams(query).get("parent");
    const base = kind.endsWith(":query") ? "Untitled query" : kind.endsWith(":note") ? "Untitled note" : "New data source";
    const row = createRow(kind, def.tree, parentId, uniqueName(def.tree, parentId, String(patch.name ?? base)), kind.endsWith(":query") ? { sql: "", sim: { dataset: "generic", rows: 25, ms: 900 } } : {});
    for (const [path, value] of Object.entries(patch)) setPath(row, path, value);
    persist();
    touch(row);
    return toResource(row);
  }

  const demoGrants = new Map<string, string[]>();

  const client: ProtocolClient = {
    version: "0.1-mock",

    // The demo has no kernel: the language plugins' own files are read directly (i18n/lang-files.ts).
    i18n: {
      async languages() {
        return [
          { locale: "en-US", name: "English" },
          ...DEMO_LANGUAGES.map((l) => ({ locale: l.locale, name: l.name })),
        ];
      },
      async shell(locale) {
        return { locale, texts: { ...(DEMO_LANGUAGES.find((l) => l.locale === locale)?.texts ?? {}) } };
      },
    },

    workspace: {
      async info() {
        await wait();
        return { id: "ws-shop", name: "电商数据 Shop Data" };
      },
      async list() {
        await wait();
        return [...workspaces.items].sort((x, y) => (y.lastOpened ?? 0) - (x.lastOpened ?? 0)).map((w) => ({ ...w, current: w.id === workspaces.current }));
      },
      async create(name) {
        await wait();
        const clean = name.trim();
        if (!clean || [...clean].length > 100) throw new KernelError("invalidParams", {});
        const entry = { id: `ws-${workspaces.items.length + 1}-${Math.abs(hash(clean))}`, name: clean, folder: clean.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "workspace" };
        workspaces.items.push(entry);
        saveWorkspaces();
        emit("app.workspacesChanged");
        return { ...entry, current: false };
      },
      async switchTo(id) {
        await wait();
        const found = workspaces.items.find((w) => w.id === id);
        if (!found) throw new KernelError("notFound", { what: "workspace" });
        workspaces.current = id;
        found.lastOpened = Date.now();
        saveWorkspaces();
        return { ...found, current: true };
      },
      async rename(id, name) {
        await wait();
        const clean = name.trim();
        if (!clean || [...clean].length > 100) throw new KernelError("invalidParams", {});
        const found = workspaces.items.find((w) => w.id === id);
        if (!found) throw new KernelError("notFound", { what: "workspace" });
        found.name = clean;
        saveWorkspaces();
        emit("app.workspacesChanged");
      },
      async openWindow(id) {
        await wait();
        // The demo has no windows: another tab shows it (the demo state is shared through localStorage).
        const url = new URL(window.location.href);
        url.searchParams.set("workspace", id);
        window.open(url.toString(), "_blank", "noopener");
      },
      async remove(id) {
        await wait();
        if (id === workspaces.current) throw new KernelError("conflict", { reason: "inUse" });
        if (!workspaces.items.some((w) => w.id === id)) throw new KernelError("notFound", { what: "workspace" });
        workspaces.items = workspaces.items.filter((w) => w.id !== id);
        saveWorkspaces();
        emit("app.workspacesChanged");
      },
      async startTargets() {
        await wait(2);
        return ["resource:q-orders-today", "resource:env-prod", "plugin:org.onedesk.sql", "resource:n-runbook"];
      },
      async getConfig(name) {
        await wait(2);
        for (const r of Object.values(db.rows)) if (r.kind === "core:config" && live(r) && paramsOf(r)[name]) return paramsOf(r)[name]!.value;
        return name in mcpConfig ? mcpConfig[name]! : null;
      },
      async setConfig(name, value) {
        await wait(2);
        const row = Object.values(db.rows).find((r) => r.kind === "core:config" && paramsOf(r)[name]);
        if (!row && name in mcpConfig) {
          mcpConfig[name] = value;
          audit("workspace.setConfig", name, value);
          emit("config", "mcp");
        }
        if (row) applyPatch(row, { [`param:${name}`]: value });
      },
      async export(folder) {
        await wait(40);
        if (protections().includes("noExport")) deny("noExport");
        if (!folder.startsWith("/")) throw new KernelError("invalid", { reason: "notAbsolute" });
        audit("workspace.export", folder, "mock");
        const rows = Object.values(db.rows).filter(live).length;
        return { folder, resources: rows, revisions: Object.keys(db.history).length, runs: db.runs.length, audit: db.audit.length, blobs: 0 };
      },
      async importPreview(folder) {
        await wait(40);
        if (folder.includes("bad")) return { valid: false, problem: { code: "invalid", params: { reason: "notExport" } }, source: "", exportedAt: 0, create: 0, update: 0, skipped: [], fingerprint: "", grantHosts: [], secretNames: [] };
        return {
          valid: true,
          source: "Personal",
          exportedAt: Date.now() - DAY,
          create: 4,
          update: 1,
          skipped: [
            { name: "Weekly sync", kind: "org.example.sync.job", reason: "unknownKind" },
            { name: "Workspace settings", kind: "core:config", reason: "config" },
            { name: "Old report", kind: "org.onedesk.sql.query", reason: "needsVersion" },
          ],
          fingerprint: "mock-fingerprint",
          grantHosts: ["api.example.com:443"],
          secretNames: ["api-token"],
        };
      },
      async import(folder, fingerprint) {
        await wait(60);
        guardWrite();
        if (fingerprint !== "mock-fingerprint") throw new KernelError("conflict", { reason: "changedSincePreview" });
        const group = createRow("core:group", "resources", null, uniqueName("resources", null, "Personal"), {});
        audit("workspace.import", group.name, folder);
        emit("tree:resources");
        return { created: 4, updated: 1, skipped: [{ name: "Weekly sync", kind: "org.example.sync.job", reason: "unknownKind" }, { name: "Old report", kind: "org.onedesk.sql.query", reason: "needsVersion" }], group: { id: group.id, name: group.name } };
      },
    },

    refs: {
      async outgoing(id) {
        await wait(4);
        const row = db.rows[id];
        return row ? outgoingRefs(row) : [];
      },
      async incoming(id) {
        await wait(4);
        return Object.values(db.rows)
          .filter((r) => live(r) && r.id !== id)
          .flatMap((r) => outgoingRefs(r))
          .filter((r) => r.target?.id === id && r.state === "ok");
      },
    },

    tree: {
      async list() {
        await wait(2);
        return clone(TREES);
      },
      async children(tree, parentKey, offset = 0) {
        await wait(tree === "files" && parentKey ? 120 : 8);
        const info = TREES.find((t) => t.id === tree);
        if (!info) return { nodes: [] };
        // Batches of 200 like the kernel (§5), so the interface's on-demand reading is exercised.
        const all = info.source === "stored" ? childrenOf(tree, parentKey).map(toNode) : providedChildren(tree, parentKey);
        const batch = all.slice(offset, offset + MOCK_BATCH);
        return { nodes: clone(batch), ...(offset + MOCK_BATCH < all.length ? { next: offset + MOCK_BATCH } : {}) };
      },
      async path(tree, key) {
        await wait(2);
        if (tree === "files") {
          const parts = key.slice(2).split("/");
          return parts.map((_p, i) => `f:${parts.slice(0, i + 1).join("/")}`);
        }
        const row = db.rows[key];
        return row ? [...ancestors(row).map((a) => a.id), row.id] : [key];
      },
      async move(tree, key, targetKey, position: DropPosition) {
        await wait();
        const row = db.rows[key];
        const target = targetKey ? db.rows[targetKey] : undefined;
        if (!row || row.tree !== tree) throw new Error("Node not found");
        const parentId = position === "inside" ? (target?.id ?? null) : (target?.parentId ?? null);
        for (let p = parentId ? db.rows[parentId] : undefined; p; p = p.parentId ? db.rows[p.parentId] : undefined) {
          if (p.id === row.id) throw new Error("A node cannot be moved into itself");
        }
        const from = row.parentId;
        const siblings = childrenOf(tree, parentId).filter((r) => r.id !== row.id);
        const index = position === "inside" || !target ? siblings.length : siblings.findIndex((r) => r.id === target.id) + (position === "after" ? 1 : 0);
        siblings.splice(Math.max(0, index), 0, row);
        row.parentId = parentId;
        siblings.forEach((r, i) => (r.pos = i));
        (db.history[row.id] ??= []).unshift({ id: newId("h"), at: Date.now(), actor: ME, field: "location", before: show(from ? db.rows[from]?.name : "/"), after: show(parentId ? db.rows[parentId]?.name : "/"), beforeRaw: from, afterRaw: parentId });
        audit("tree.move", row.name, `→ ${parentId ? db.rows[parentId]!.name : "/"}`);
        persist();
        touch(row);
      },
      async createGroup(tree, parentKey, name) {
        await wait();
        return clone(toNode(createRow("core:group", tree, parentKey, uniqueName(tree, parentKey, name), {})));
      },
      async rename(_tree, key, name) {
        await wait();
        const row = db.rows[key];
        if (row && name) applyPatch(row, { name });
      },
    },

    resource: {
      async get(id) {
        await wait();
        const row = db.rows[id];
        return row ? toResource(row) : null;
      },
      async delete(id) {
        await wait();
        const row = db.rows[id];
        if (row) softDelete(row);
      },
      async setFavorite(id, favorite) {
        const row = db.rows[id];
        if (!row) return;
        db.favorites = favorite ? [...new Set([...db.favorites, id])] : db.favorites.filter((f) => f !== id);
        persist();
        emit("tree:favorites", `tree:${row.tree}`, `resource:${id}`);
      },
      async setAiVisible(id, visible, withChildren) {
        await wait();
        const row = db.rows[id];
        if (!row || !live(row)) throw new KernelError("notFound", { what: "resource" });
        const all = [row];
        if (withChildren) for (let i = 0; i < all.length; i++) all.push(...Object.values(db.rows).filter((r) => r.parentId === all[i]!.id && live(r)));
        let changed = 0;
        for (const r of all) {
          if (Boolean(r.aiVisible) !== visible) {
            r.aiVisible = visible;
            changed++;
          }
        }
        audit("resource.aiVisible", row.name, JSON.stringify({ visible, count: changed }));
        persist();
        emit(`tree:${row.tree}`, ...all.map((r) => `resource:${r.id}`));
        return { changed };
      },
      async history(id) {
        await wait();
        return (db.history[id] ?? []).map(({ beforeRaw: _b, afterRaw: _a, ...entry }) => ({ ...entry, op: entry.restoredFrom ? "restore" : "update" }));
      },
      async restore(id, entryId) {
        await wait(30);
        const row = db.rows[id];
        const entry = db.history[id]?.find((h) => h.id === entryId);
        if (!row || !entry) throw new Error("History entry not found");
        if (entry.field === "location") {
          row.parentId = (entry.beforeRaw as string | null) ?? null;
          persist();
          touch(row);
          return;
        }
        applyPatch(row, { [entry.field]: entry.beforeRaw }, { restoredFrom: entry.id, operation: "resource.restore" });
      },
      async listDeleted() {
        await wait();
        return Object.values(db.rows)
          .filter((r) => r.deletedAt)
          .sort((a, b) => b.deletedAt! - a.deletedAt!)
          .map((r) => ({ ...toResource(r), updatedAt: r.deletedAt! }));
      },
      async undelete(id) {
        await wait();
        const row = db.rows[id];
        if (row) undelete(row);
      },
      async purge(id) {
        await wait();
        const row = db.rows[id];
        if (row) purge(row);
      },
    },

    params: {
      async env(envId) {
        await wait();
        return envView(envId);
      },
      async envOptions() {
        await wait(4);
        const out: Array<{ id: string; name: string; depth: number }> = [];
        const walk = (parentId: string | null, depth: number) => {
          for (const r of childrenOf("environments", parentId)) {
            if (r.kind === "core:env") out.push({ id: r.id, name: r.name, depth });
            walk(r.id, depth + 1);
          }
        };
        walk(null, 0);
        return out;
      },
      async resolve(envId, name) {
        await wait(4);
        return resolveIn(db, envId, name);
      },
      async set(envId, name, value, _basis, type) {
        await wait(20);
        const env = db.rows[envId];
        if (!env) throw new Error("Environment not found");
        const had = paramsOf(env)[name];
        const parent = env.parentId ? resolveIn(db, env.parentId, name) : undefined;
        applyPatch(env, { [`param:${name}`]: value });
        const now = paramsOf(env)[name];
        if (now && type) now.type = type;
        if (now && !had && parent?.found) now.based_on = parent.value;
        persist();
        emit("env");
      },
      async unset(envId, name) {
        await wait(20);
        const env = db.rows[envId];
        if (env) applyPatch(env, { [`param:${name}`]: undefined });
        emit("env");
      },
      async known() {
        await wait(4);
        return [
          { name: "ui.language", type: "text", merge: "plain", layers: ["config"] },
          { name: "network.allow", type: "list", merge: "allowList", layers: ["config", "env"] },
          { name: "protection.readonly", type: "boolean", merge: "deny", layers: ["config", "env"] },
          { name: "protection.no_export", type: "boolean", merge: "deny", layers: ["config", "env"] },
        ];
      },
      async rename(envId, name, newName) {
        await wait(20);
        const env = db.rows[envId];
        const own = env && paramsOf(env)[name];
        if (!env || !own || name === newName) return;
        const { type, value } = own;
        applyPatch(env, { [`param:${name}`]: undefined, [`param:${newName}`]: value });
        const now = paramsOf(env)[newName];
        if (now) now.type = type;
        persist();
        emit("env", `resource:${env.id}`);
      },
      async acknowledge(envId, name) {
        await wait(20);
        const env = db.rows[envId];
        const own = env && paramsOf(env)[name];
        if (!env || !own || !env.parentId) return;
        own.based_on = resolveIn(db, env.parentId, name).value;
        persist();
        emit("env", `resource:${env.id}`);
      },
    },

    plugin: {
      // Demo only: folder grants live in memory; the real ones are the kernel's.
      async grants(plugin) {
        return { plugin, folders: [...(demoGrants.get(plugin) ?? [])] };
      },
      async grantFolder(plugin, path) {
        demoGrants.set(plugin, [...new Set([...(demoGrants.get(plugin) ?? []), path])]);
        return { plugin, folders: [...demoGrants.get(plugin)!] };
      },
      async replaceFolder(plugin, path, newPath) {
        demoGrants.set(plugin, [...new Set((demoGrants.get(plugin) ?? []).map((p) => (p === path ? newPath : p)))]);
        return { plugin, folders: [...demoGrants.get(plugin)!] };
      },
      async revokeFolder(plugin, path) {
        demoGrants.set(plugin, (demoGrants.get(plugin) ?? []).filter((p) => p !== path));
        return { plugin, folders: [...demoGrants.get(plugin)!] };
      },
      async get(id) {
        await wait();
        const p = db.plugins.find((x) => x.id === id);
        return p ? pluginDetail(p) : null;
      },
      async setEnabled(id, enabled) {
        await wait(60);
        const p = db.plugins.find((x) => x.id === id);
        if (p) setPluginEnabled(p, enabled);
      },
      async activateVersion(id, version) {
        await wait(120);
        const p = db.plugins.find((x) => x.id === id);
        if (!p) return { upgraded: 0, kept: 0 };
        for (const v of p.versions) v.active = v.version === version;
        audit("plugin.enable", p.id, `version ${version}`);
        persist();
        emit("plugins", "tree:plugins");
        return { upgraded: 0, kept: 0 };
      },
      async setPinned(id, version, pinned) {
        await wait(20);
        const p = db.plugins.find((x) => x.id === id);
        if (!p) return;
        for (const v of p.versions) v.pinned = pinned && v.version === version;
        persist();
        emit("plugins");
      },
      async setSetting(id, name, value) {
        await wait(20);
        const s = db.plugins.find((x) => x.id === id)?.settings.find((x) => x.name === name);
        if (!s || s.value === value) return;
        audit("params.set", id, `${name}: ${s.value} → ${value}`);
        s.value = value;
        persist();
        emit("plugins");
      },
      async undoUpgrade() {
        return { restored: 0, modified: [] };
      },
      async confirmPermissions() {},
      async setPermission(id, permission, granted) {
        await wait(20);
        const perm = db.plugins.find((x) => x.id === id)?.permissions.find((x) => x.id === permission);
        if (!perm) return;
        perm.granted = granted;
        audit("plugin.permission", id, `${permission}: ${granted ? "granted" : "revoked"}`);
        persist();
        emit("plugins");
      },
      async reload(id) {
        await wait(400);
        audit("plugin.enable", id, "reload");
        emit("plugins", "tree:plugins");
      },
    },

    page: {
      async save(target, changes) {
        if (target.startsWith("new:")) {
          const created = await createResource(target, changes);
          return { page: clone(resolvePage(`resource:${created.id}`, {})) };
        }
        if (!target.startsWith("resource:")) throw new Error("Unknown target");
        await updateResource(target.slice(9), changes);
        return { page: { ...clone(resolvePage(target, {})), restrictions: protections() } };
      },
      async resolve(target, context = {}) {
        await wait(context.draft ? 20 : 10);
        const restrictions = protections();
        return { ...clone(resolvePage(target, context)), ...(restrictions.length > 0 ? { restrictions } : {}) };
      },
      async event(target, event, context) {
        await wait(60);
        if (event === "format") {
          const sql = String(context.draft?.["body.sql"] ?? "");
          const next = formatSql(sql);
          return next === sql ? { message: L("Already formatted", "已经是格式化后的样子") } : { changes: { "body.sql": next }, message: L("Formatted (not saved yet)", "已格式化（尚未保存）") };
        }
        if (event === "export-sh") return { message: L("Exported to ~/Exports/query.sh with the current environment's values", "已按当前环境的参数值导出到 ~/Exports/query.sh") };
        if (event === "export-md") return { message: L("Exported to ~/Exports as Markdown", "已导出 Markdown 到 ~/Exports") };
        if (event === "export-csv") return { message: L("Saved to ~/Exports (CSV, UTF-8 with BOM)", "已保存到 ~/Exports（CSV，UTF-8 带 BOM）") };
        if (event === "file.import") return { message: L("Imported as a SQL query in “待整理 Inbox”", "已导入为 SQL 查询，放在“待整理 Inbox”") };
        return { message: L(`“${event}” is not implemented in the prototype (${target})`, `原型没有实现“${event}”`) };
      },
    },

    result: {
      async actions(runId) {
        await wait(6);
        const run = db.runs.find((r) => r.id === runId);
        if (!run || run.status !== "success" || (run.out?.kind !== "table" && run.out?.kind !== "text")) return [];
        const blocked = protections().includes("noExport");
        return [{ plugin: "org.onedesk.ai", id: "analyze", action: "org.onedesk.ai:analyze", label: "Analyze with AI", icon: "sparkles", enabled: !blocked, ...(blocked ? { disabledReason: "noExport" } : {}) }];
      },
    },
    run: {
      async start(request) {
        await wait(15);
        guardWrite();
        if (request.resultRun && !db.runs.some((r) => r.id === request.resultRun && r.status === "success")) throw new KernelError("invalid", { reason: "badResultRun" });
        return startRun(request);
      },
      async export(id, path) {
        await wait(30);
        if (protections().includes("noExport")) deny("noExport");
        const run = db.runs.find((r) => r.id === id);
        if (!run || run.status !== "success" || run.out?.kind !== "table") throw new KernelError("invalid", { reason: "notTable" });
        if (!path.startsWith("/")) throw new KernelError("invalid", { reason: "notAbsolute" });
        audit("run.export", run.title, path);
        return { path, rows: run.out.rows };
      },
      async get(id) {
        await wait(6);
        const run = db.runs.find((r) => r.id === id);
        return run ? publicRun(run, true) : null;
      },
      async cancel(id) {
        await wait(20);
        const run = db.runs.find((r) => r.id === id);
        if (run?.status === "running") finish(run, { status: "cancelled", message: "Cancelled by user" });
      },
      async listFor(resourceId) {
        await wait();
        return db.runs
          .filter((r) => r.resourceId === resourceId)
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((r) => publicRun(r, false));
      },
      async tasks() {
        await wait(4);
        return db.runs
          .filter((r) => r.inTaskPanel)
          .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt)
          .map((r) => publicRun(r, false));
      },
      async clearFinished() {
        await wait(4);
        for (const r of db.runs) if (r.status !== "running") r.inTaskPanel = false;
        persist();
        emit("runs");
      },
      async render(id, tabId) {
        await wait(10);
        const run = db.runs.find((r) => r.id === id);
        if (!run) return [];
        if (tabId === "sent") return [{ type: "text", id: "sent", mono: true, language: "sql", text: sentSql(String(run.input["body.sql"] ?? ""), run.params) }];
        if (tabId === "ai") {
          return [
            {
              type: "placeholder",
              id: "ai",
              icon: "sparkles",
              message: L(
                "AI analysis is a placeholder in this prototype. Here the AI plugin will show a Markdown answer about this result, editable and saved with the run.",
                "AI 分析在原型里只是占位。这里将由 AI 插件给出关于这次结果的 Markdown 回答，可编辑，并随这次运行保存。",
              ),
              action: { label: L("Analyze this result", "分析这次结果"), disabled: true },
            },
          ];
        }
        return [];
      },
      async setKept(id, kept, name) {
        await wait(4);
        const run = db.runs.find((r) => r.id === id);
        if (run) {
          run.kept = kept;
          if (kept && name) run.keptName = name;
        }
        persist();
        emit(`run:${id}`, "runs");
      },
    },

    search: {
      async query(text, limit = 20) {
        await wait(25);
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length === 0) return [];
        const hits: Array<SearchHit & { score: number }> = [];
        for (const r of Object.values(db.rows)) {
          if (!live(r) || r.kind === "core:group") continue;
          const name = r.name.toLowerCase();
          const hay = `${name} ${r.description} ${r.tags.join(" ")} ${String(r.body.sql ?? "")} ${String(r.body.content ?? "")}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) continue;
          const target = targetOf(r);
          if (!target) continue;
          hits.push({
            target,
            title: r.name,
            icon: KINDS[r.kind]?.icon ?? "file",
            subtitle: [TREES.find((t) => t.id === r.tree)?.title, ...ancestors(r).map((a) => a.name)].map((x) => (typeof x === "string" ? x : (x?.["en-US"] ?? ""))).join(" / "),
            state: stateOf(r).state,
            score: (words.every((w) => name.includes(w)) ? 100 : 0) + (db.favorites.includes(r.id) ? 10 : 0) + Math.max(0, 9 - (Date.now() - r.updatedAt) / (3 * DAY)),
          });
        }
        for (const p of db.plugins) {
          const name = typeof p.name === "string" ? p.name : `${p.name["en-US"] ?? ""} ${p.name["zh-CN"] ?? ""}`;
          if (words.every((w) => `${name} ${p.id}`.toLowerCase().includes(w))) hits.push({ target: `plugin:${p.id}`, title: typeof p.name === "string" ? p.name : (p.name["en-US"] ?? ""), icon: p.icon, subtitle: `Plugins / ${p.id}`, state: "ok", score: 50 });
        }
        return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score: _s, ...hit }) => hit);
      },
    },

    mcp: {
      async status() {
        await wait(2);
        const env = mcpConfig["mcp.env"] ? db.rows[mcpConfig["mcp.env"]] : undefined;
        return {
          enabled: mcpConfig["mcp.enabled"] === "true",
          ratePerMinute: Number(mcpConfig["mcp.rate_per_minute"]),
          maxRows: Number(mcpConfig["mcp.max_rows"]),
          allowFreeQuery: mcpConfig["mcp.allow_free_query"] === "true",
          envId: env?.id,
          envName: env?.name,
          tools: 4,
        };
      },
    },

    audit: {
      async list(filter) {
        await wait(20);
        const text = filter.text?.toLowerCase();
        const since = filter.sinceMs ? Date.now() - filter.sinceMs : 0;
        return clone(
          db.audit.filter(
            (a) =>
              a.at >= since &&
              (!filter.actor || a.actor === filter.actor) &&
              (!filter.source || a.actor === filter.source || a.actor.startsWith(`${filter.source}:`)) &&
              (!filter.operation || a.operation === filter.operation) &&
              (!filter.result || a.result === filter.result) &&
              (!text || `${a.target} ${a.detail} ${a.actor}`.toLowerCase().includes(text)),
          ),
        );
      },
      async facets() {
        await wait(4);
        return { actors: [...new Set(db.audit.map((a) => a.actor))].sort(), operations: Object.keys(OPERATIONS) };
      },
    },

    command: {
      async palette() {
        await wait(4);
        const create = L("Create", "新建");
        const go = L("Go to", "前往");
        const demo = L("Prototype", "原型");
        return [
          { id: "new:org.onedesk.sql:query", label: L("New SQL query", "新建 SQL 查询"), icon: "file-code", group: create, shortcut: ["⌘", "N"] },
          { id: "new:org.onedesk.note:note", label: L("New note", "新建笔记"), icon: "notebook-pen", group: create },
          { id: "new:org.onedesk.sql:datasource", label: L("New data source", "新建数据源"), icon: "database", group: create },
          { id: "new:core:env", label: L("New environment", "新建环境"), icon: "layers", group: create },
          { id: "import.folder", label: L("Import folder…", "导入文件夹…"), icon: "folder-input", group: create },
          { id: "open.audit", label: L("Open audit log", "打开审计记录"), icon: "scroll-text", group: go },
          { id: "open.deleted", label: L("Open deleted items", "打开已删除"), icon: "trash-2", group: go },
          { id: "demo.failing", label: L("Open the query that fails", "打开会失败的查询"), icon: "circle-alert", group: demo, keywords: ["error", "错误"] },
          { id: "demo.reset", label: L("Reset demo data and layout", "重置演示数据和布局"), icon: "rotate-ccw", group: demo, keywords: ["reset", "重置"] },
        ];
      },
      async newItems() {
        await wait(4);
        return [
          { id: "new:org.onedesk.sql:query", label: L("SQL query", "SQL 查询"), icon: "file-code" },
          { id: "new:org.onedesk.note:note", label: L("Note", "笔记"), icon: "notebook-pen" },
          { id: "new:org.onedesk.sql:datasource", label: L("Data source", "数据源"), icon: "database" },
          { id: "new:core:env", label: L("Environment", "环境"), icon: "layers" },
          { id: "node.newGroup", label: L("Group", "分组"), icon: "folder-plus" },
          { id: "new:org.onedesk.http:request", label: L("HTTP request (plugin not installed)", "HTTP 请求（插件未安装）"), icon: "send", disabled: true },
          { id: "import.folder", label: L("Import folder…", "导入文件夹…"), icon: "folder-input", separatorBefore: true },
          { id: "import.file", label: L("Import file…", "导入文件…"), icon: "file-input" },
        ];
      },
      async execute(id, context) {
        await wait(20);
        return execute(id, context);
      },
    },

    ui: {
      async get<T>(key: string) {
        return read(UI_PREFIX + key) as T | null;
      },
      async set(key, value) {
        write(UI_PREFIX + key, value);
      },
    },

    events: {
      subscribe(topic, handler) {
        const set = handlers.get(topic) ?? new Set<EventHandler>();
        handlers.set(topic, set);
        set.add(handler);
        return () => {
          set.delete(handler);
        };
      },
    },
  };

  return client;
}
