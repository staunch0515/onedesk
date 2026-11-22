/**
 * Seed data for the mock kernel: SQL / operations flavoured, Chinese and English mixed, the way a
 * real workspace looks. Everything here is fake. Nothing in src/workbench outside protocol/mock
 * may import this file.
 */
import type { AuditRow, Label, OutputCell, OutputColumn, PluginPermission, PluginSetting, PluginVersion } from "../types";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const ME = "chen.hao";
export const ACTORS = [ME, "li.na", "ops-bot", "wang.wei"];

/* ------------------------------------------------------------------ rows */

export interface Row {
  id: string;
  kind: string;
  tree: string;
  parentId: string | null;
  pos: number;
  name: string;
  description: string;
  tags: string[];
  body: Record<string, unknown>;
  /** Stored state (§3.3); "disabled" and "missing-plugin" are derived from the plugin. */
  state: "ok" | "missing" | "conflict";
  origin: "original" | "subscribed" | "copied";
  originRef?: string;
  rev: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  deletedAt?: number;
  /** Round 19: visible to AI clients (off by default). */
  aiVisible?: boolean;
}

export interface ParamValue {
  type: "text" | "number" | "boolean" | "list" | "secret" | "ref";
  value: string;
  /** Parent value at the time this override was written (drives "changed upstream"). */
  based_on?: string;
}

/** How a fake run of this resource behaves. */
export interface Sim {
  dataset?: string;
  rows?: number;
  ms?: number;
  /** Text output instead of a table (statements that change data). */
  affected?: number;
}

export interface KindDef {
  plugin: string | null;
  label: Label;
  icon: string;
  tree: string;
}

export const KINDS: Record<string, KindDef> = {
  "core:group": { plugin: null, label: { "en-US": "Group", "zh-CN": "分组" }, icon: "folder", tree: "*" },
  "core:env": { plugin: null, label: { "en-US": "Environment", "zh-CN": "环境" }, icon: "layers", tree: "environments" },
  "core:config": { plugin: null, label: { "en-US": "Configuration", "zh-CN": "配置项" }, icon: "sliders-horizontal", tree: "config" },
  "org.onedesk.sql:query": { plugin: "org.onedesk.sql", label: { "en-US": "SQL query", "zh-CN": "SQL 查询" }, icon: "file-code", tree: "resources" },
  "org.onedesk.sql:datasource": { plugin: "org.onedesk.sql", label: { "en-US": "Data source", "zh-CN": "数据源" }, icon: "database", tree: "datasources" },
  "org.onedesk.note:note": { plugin: "org.onedesk.note", label: { "en-US": "Note", "zh-CN": "笔记" }, icon: "notebook-pen", tree: "resources" },
  "org.onedesk.http:request": { plugin: "org.onedesk.http", label: { "en-US": "HTTP request", "zh-CN": "HTTP 请求" }, icon: "send", tree: "resources" },
  "org.onedesk.mongo:query": { plugin: "org.onedesk.mongo", label: { "en-US": "MongoDB query", "zh-CN": "MongoDB 查询" }, icon: "leaf", tree: "resources" },
};

export function seedRows(now: number): Row[] {
  const rows: Row[] = [];
  const pos = new Map<string, number>();
  let n = 0;
  const add = (partial: Partial<Row> & Pick<Row, "id" | "kind" | "tree" | "name">): Row => {
    const parentId = partial.parentId ?? null;
    const slot = `${partial.tree}/${parentId ?? ""}`;
    const p = pos.get(slot) ?? 0;
    pos.set(slot, p + 1);
    n += 1;
    const created = now - (90 - (n % 60)) * DAY - n * 37 * MINUTE;
    const updated = now - ((n * 7) % 20) * DAY - ((n * 53) % 600) * MINUTE;
    const row: Row = {
      description: "",
      tags: [],
      body: {},
      state: "ok",
      origin: "original",
      rev: 1 + (n % 9),
      createdAt: created,
      createdBy: ACTORS[n % 2 === 0 ? 0 : 1]!,
      updatedAt: Math.max(created, updated),
      updatedBy: ACTORS[n % 3 === 0 ? 1 : 0]!,
      ...partial,
      parentId,
      pos: p,
    };
    rows.push(row);
    return row;
  };
  const group = (id: string, name: string, parentId: string | null, tree = "resources") => add({ id, kind: "core:group", tree, name, parentId });
  const sql = (id: string, name: string, parentId: string, text: string, sim: Sim, extra: Partial<Row> = {}) =>
    add({ id, kind: "org.onedesk.sql:query", tree: "resources", name, parentId, body: { sql: text.trim() + "\n", sim }, ...extra });
  const note = (id: string, name: string, parentId: string, body: Record<string, unknown>, extra: Partial<Row> = {}) =>
    add({ id, kind: "org.onedesk.note:note", tree: "resources", name, parentId, body, ...extra });

  /* ---- resources */
  group("g-orders", "订单 Orders", null);
  group("g-orders-daily", "日常核对 Daily checks", "g-orders");
  sql(
    "q-orders-today",
    "今日订单汇总",
    "g-orders-daily",
    `
-- 今日订单：按渠道汇总下单数、支付金额
SELECT o.order_id,
       o.created_at,
       c.name          AS customer,
       o.channel,
       o.status,
       o.pay_amount    AS amount,
       o.item_count    AS items
FROM   orders o
JOIN   customers c ON c.id = o.customer_id
WHERE  o.tenant_id = :tenant_id
  AND  o.created_at >= :start_time
  AND  o.channel = :channel
ORDER  BY o.created_at DESC
LIMIT  :limit`,
    { dataset: "orders", rows: 312, ms: 1400 },
    { description: "每天上午核对前一日订单；金额以支付金额为准。", tags: ["订单", "日报"] },
  );
  sql(
    "q-orders-overdue",
    "待发货订单超时",
    "g-orders-daily",
    `
SELECT o.order_id, o.paid_at,
       TIMESTAMPDIFF(HOUR, o.paid_at, NOW()) AS hours_waiting,
       w.name AS warehouse, c.name AS customer
FROM   orders o
JOIN   warehouses w ON w.id = o.warehouse_id
JOIN   customers c  ON c.id = o.customer_id
WHERE  o.status = 'paid'
  AND  o.paid_at < NOW() - INTERVAL :hours HOUR
ORDER  BY hours_waiting DESC`,
    { dataset: "overdue", rows: 47, ms: 900 },
    { tags: ["订单", "告警"] },
  );
  sql(
    "q-refund-recon",
    "退款对账 Refund reconciliation",
    "g-orders-daily",
    `
-- 历史表已在 2024 年归档，这条查询会失败（演示错误留在结果区）
SELECT r.refund_id, r.order_id, r.amount, l.amount AS ledger_amount
FROM   refunds r
LEFT   JOIN legacy_orders_2019 l ON l.order_id = r.order_id
WHERE  r.created_at >= :start_date
  AND  r.amount <> l.amount`,
    { dataset: "orders", rows: 0, ms: 1100 },
    { description: "Compares refunds with the ledger. Depends on a table that was archived.", tags: ["财务", "对账"] },
  );
  sql(
    "q-purge-sessions",
    "清理过期会话 Purge expired sessions",
    "g-orders-daily",
    `
DELETE FROM user_sessions
WHERE  expires_at < NOW() - INTERVAL :days DAY`,
    { affected: 1284, ms: 1000 },
    { description: "Writes data. Blocked in environments with protection.readonly.", tags: ["运维"] },
  );
  group("g-orders-monthly", "月度报表 Monthly", "g-orders");
  sql(
    "q-gmv-channel",
    "月度 GMV by channel",
    "g-orders-monthly",
    `
SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
       channel,
       COUNT(*)                          AS orders,
       SUM(pay_amount)                   AS gmv,
       ROUND(AVG(pay_amount), 2)         AS avg_order
FROM   orders
WHERE  created_at >= :start_date AND created_at < :end_date
  AND  status IN ('paid', 'shipped', 'done')
GROUP  BY month, channel
ORDER  BY month DESC, gmv DESC`,
    { dataset: "gmv", rows: 48, ms: 2200 },
    { tags: ["报表", "GMV"] },
  );
  sql(
    "q-repeat-rate",
    "复购率 Repeat purchase rate",
    "g-orders-monthly",
    `
WITH first_orders AS (
  SELECT customer_id, MIN(created_at) AS first_at FROM orders GROUP BY customer_id
)
SELECT DATE_FORMAT(f.first_at, '%Y-%m') AS cohort_month,
       COUNT(DISTINCT f.customer_id)     AS customers,
       COUNT(DISTINCT o.customer_id)     AS repeat_customers,
       ROUND(COUNT(DISTINCT o.customer_id) / COUNT(DISTINCT f.customer_id), 4) AS repeat_rate
FROM   first_orders f
LEFT   JOIN orders o ON o.customer_id = f.customer_id AND o.created_at > f.first_at
GROUP  BY cohort_month
ORDER  BY cohort_month DESC`,
    { dataset: "repeat", rows: 24, ms: 3100 },
    { tags: ["报表"] },
  );
  group("g-orders-archive", "归档", "g-orders-monthly");
  group("g-orders-2023", "2023", "g-orders-archive");
  sql("q-2023-summary", "2023 年度汇总", "g-orders-2023", `SELECT channel, COUNT(*) AS orders, SUM(pay_amount) AS gmv\nFROM   orders_2023\nGROUP  BY channel`, { dataset: "gmv", rows: 6, ms: 700 });

  group("g-users", "用户 Users", null);
  sql(
    "q-new-users",
    "新增用户按渠道",
    "g-users",
    `
SELECT DATE(created_at) AS date, channel,
       COUNT(*) AS new_users,
       SUM(activated_at IS NOT NULL) AS activated,
       ROUND(SUM(activated_at IS NOT NULL) / COUNT(*), 4) AS activation_rate
FROM   users
WHERE  created_at >= :start_date
GROUP  BY date, channel
ORDER  BY date DESC`,
    { dataset: "users_channel", rows: 120, ms: 1300 },
    { tags: ["用户", "增长"] },
  );
  sql(
    "q-inactive-users",
    "Inactive users (90d)",
    "g-users",
    `
SELECT u.id AS user_id, u.name, u.last_login_at,
       DATEDIFF(NOW(), u.last_login_at) AS days_inactive,
       s.lifetime_value
FROM   users u
JOIN   user_stats s ON s.user_id = u.id
WHERE  u.last_login_at < NOW() - INTERVAL :days DAY
  AND  s.lifetime_value >= :min_value
ORDER  BY s.lifetime_value DESC
LIMIT  :limit`,
    { dataset: "inactive", rows: 500, ms: 1900 },
    { description: "Win-back campaign list. Run against the read replica only.", tags: ["用户", "campaign"] },
  );
  note(
    "n-user-fields",
    "用户画像字段说明",
    "g-users",
    {
      summary: "user_stats 各字段的口径",
      owner: "data",
      review_date: "2026-12-01",
      content:
        "# 用户画像字段说明\n\n- lifetime_value：历史支付金额合计，不含退款。\n- last_login_at：最近一次登录（任意端）。\n- activated_at：完成首单的时间，没有则为空。\n\n口径变更需要在 #data-contract 频道公告，并更新 [[新增用户按渠道]]。\n",
    },
    { tags: ["文档"] },
  );

  group("g-ops", "运维 Ops", null);
  sql(
    "q-slow",
    "慢查询 Top 20",
    "g-ops",
    `
SELECT digest, LEFT(digest_text, 80) AS query_sample,
       count_star AS calls,
       ROUND(avg_timer_wait / 1e9, 1) AS avg_ms,
       ROUND(max_timer_wait / 1e9, 1) AS max_ms,
       sum_rows_examined AS rows_examined
FROM   performance_schema.events_statements_summary_by_digest
WHERE  schema_name = :db_schema
ORDER  BY avg_timer_wait DESC
LIMIT  20`,
    { dataset: "slow", rows: 20, ms: 800 },
    { tags: ["运维", "性能"] },
  );
  sql("q-repl", "Replication lag", "g-ops", `SHOW REPLICA STATUS`, { dataset: "repl", rows: 3, ms: 500 }, { tags: ["运维"] });
  sql(
    "q-sizes",
    "表空间占用 Table sizes",
    "g-ops",
    `
SELECT table_schema, table_name, table_rows AS \`rows\`,
       ROUND(data_length / 1048576, 1)  AS data_mb,
       ROUND(index_length / 1048576, 1) AS index_mb
FROM   information_schema.tables
WHERE  table_schema = :db_schema
ORDER  BY data_length DESC`,
    { dataset: "sizes", rows: 64, ms: 1000 },
  );
  sql(
    "q-export",
    "Long-running export (全量导出)",
    "g-ops",
    `
-- 大约 15 秒：用来演示进度、取消和任务面板
SELECT * FROM order_items
WHERE  created_at >= :start_date`,
    { dataset: "orders", rows: 800, ms: 15000 },
    { description: "Slow on purpose: shows progress, cancel and the task panel.", tags: ["导出"] },
  );
  note(
    "n-runbook",
    "值班手册 On-call runbook",
    "g-ops",
    {
      summary: "数据库值班：常见告警与处理",
      owner: "ops",
      review_date: "2026-11-30",
      content:
        "# 值班手册\n\n## 主从延迟 > 60s\n1. 运行 [[Replication lag]] 确认是哪一台。\n2. 看是否有长事务：`SELECT * FROM information_schema.innodb_trx`。\n3. 超过 10 分钟仍未恢复，升级到 DBA。\n\n## 磁盘 > 85%\n- 运行 [[表空间占用 Table sizes]]，优先清理 *_log 表。\n",
    },
    { tags: ["文档", "值班"] },
  );
  note("n-release", "发布检查清单 Release checklist", "g-ops", { summary: "每次发布前逐项确认", owner: "ops", review_date: "2026-11-20", content: "- [ ] 备份完成\n- [ ] 慢查询无新增\n- [ ] 回滚脚本已验证\n- [ ] 通知客服\n" });
  add({
    id: "m-events",
    kind: "org.onedesk.mongo:query",
    tree: "resources",
    name: "订单事件流 Order events",
    parentId: "g-ops",
    body: { collection: "order_events", filter: '{ "type": "status_changed" }' },
    description: "MongoDB plugin is disabled in this workspace.",
  });

  group("g-finance", "财务 Finance", null);
  sql("q-invoices", "发票开具明细", "g-finance", `SELECT invoice_no, issued_at, customer, amount, tax, status\nFROM   invoices\nWHERE  issued_at >= :start_date AND issued_at < :end_date\nORDER  BY issued_at`, { dataset: "invoices", rows: 210, ms: 1200 }, { tags: ["财务"] });
  sql("q-revenue", "Daily revenue", "g-finance", `SELECT DATE(paid_at) AS date, SUM(pay_amount) AS revenue,\n       SUM(refund_amount) AS refunds,\n       SUM(pay_amount) - SUM(refund_amount) AS net\nFROM   orders\nWHERE  paid_at >= :start_date\nGROUP  BY date\nORDER  BY date DESC`, { dataset: "revenue", rows: 90, ms: 1100 }, { tags: ["财务", "日报"] });
  sql("q-aging", "应收账龄 AR aging", "g-finance", `SELECT customer, current, d30, d60, d90, total\nFROM   v_ar_aging\nWHERE  as_of = :as_of_date\nORDER  BY total DESC`, { dataset: "aging", rows: 58, ms: 1500 }, { tags: ["财务"] });
  sql("q-recon-diff", "对账差异", "g-finance", `SELECT * FROM v_recon_diff WHERE biz_date = :biz_date`, { dataset: "invoices", rows: 12, ms: 900 }, { state: "conflict", description: "Changed both here and in the remote repository." });

  group("g-api", "API", null);
  add({ id: "h-health", kind: "org.onedesk.http:request", tree: "resources", name: "Health check", parentId: "g-api", body: { method: "GET", url: "https://api.example.com/healthz" } });
  add({ id: "h-fx", kind: "org.onedesk.http:request", tree: "resources", name: "获取汇率", parentId: "g-api", body: { method: "GET", url: "https://api.example.com/fx?base=CNY" } });

  group("g-scratch", "Scratch", null);
  sql("q-untitled", "Untitled query", "g-scratch", `SELECT 1`, { dataset: "generic", rows: 1, ms: 300 });
  note("n-kpi", "Shared: KPI 定义", "g-scratch", { summary: "", owner: "data", review_date: "", content: "" }, { state: "missing", origin: "subscribed", originRef: "甲公司 / 数据组 / KPI 定义", description: "The source of this subscription no longer exists." });
  note("n-meeting", "会议纪要 2026-11-12", "g-scratch", { summary: "数据周会", owner: "data", review_date: "", content: "1. 复购率口径下周统一。\n2. 慢查询 Top 20 每周一发群。\n3. 正式环境只读副本本月切换到新机房。\n" });
  group("g-empty", "待整理 Inbox", null);

  /* ---- environments: 默认 → 测试；默认 → 正式 → 正式·只读副本 */
  const env = (id: string, name: string, parentId: string | null, description: string, params: Record<string, ParamValue>) =>
    add({ id, kind: "core:env", tree: "environments", name, parentId, description, body: { params } });
  env("env-default", "默认 Default", null, "所有环境共用的基础参数。子环境只写与这里不同的值。", {
    datasource: { type: "ref", value: "ds-staging" },
    db_schema: { type: "text", value: "shop" },
    tenant_id: { type: "number", value: "1001" },
    limit: { type: "number", value: "1000" },
    channel: { type: "text", value: "app" },
    "protection.readonly": { type: "boolean", value: "false" },
    "ai.policy": { type: "text", value: "metadata-only" },
    "network.allow": { type: "list", value: "10.0.0.0/8, *.internal.example.com" },
    api_token: { type: "secret", value: "onedesk/default/api_token" },
  });
  env("env-staging", "测试 Staging", "env-default", "预发环境，数据每晚从正式库脱敏同步。可以写。", {
    datasource: { type: "ref", value: "ds-staging" },
    tenant_id: { type: "number", value: "9001" },
    "ai.policy": { type: "text", value: "allow" },
  });
  env("env-prod", "正式 Production", "env-default", "正式环境。默认只读；写操作需要在子环境里单独放开（不会生效，见 protection.readonly）。", {
    datasource: { type: "ref", value: "ds-prod" },
    limit: { type: "number", value: "500", based_on: "500" },
    "protection.readonly": { type: "boolean", value: "true" },
    "ai.policy": { type: "text", value: "deny" },
    api_token: { type: "secret", value: "onedesk/prod/api_token" },
  });
  env("env-prod-ro", "正式·只读副本 Replica", "env-prod", "报表类查询走只读副本，避免影响主库。", {
    datasource: { type: "ref", value: "ds-replica" },
    limit: { type: "number", value: "5000", based_on: "500" },
    "protection.readonly": { type: "boolean", value: "false" },
  });

  /* ---- workspace configuration */
  const cfg = (id: string, name: string, parentId: string | null, description: string, params: Record<string, ParamValue>, extra: Record<string, unknown> = {}) =>
    add({ id, kind: "core:config", tree: "config", name, parentId, description, body: { params, ...extra } });
  cfg("cfg-general", "通用 General", null, "Interface language and advanced mode.", {
    "ui.language": { type: "text", value: "en-US" },
    "ui.advanced": { type: "boolean", value: "false" },
  });
  cfg("cfg-appearance", "外观 Appearance", null, "Theme and density. Changes apply at once.", {
    "ui.theme": { type: "text", value: "system" },
    "ui.density": { type: "text", value: "comfortable" },
  });
  cfg("cfg-versioning", "版本化 Versioning", null, "Optional git versioning of resources (I.9).", {
    "git.enabled": { type: "boolean", value: "false" },
    "git.repository": { type: "text", value: "~/onedesk-repo" },
    "git.debounce_seconds": { type: "number", value: "5" },
  });
  cfg("cfg-conflicts", "冲突 Conflicts", "cfg-versioning", "Resources changed both locally and remotely.", { "git.conflicts": { type: "number", value: "1" } });
  cfg("cfg-web", "网页访问 Web access", null, "Open this workspace in a browser on the local network (I.10c).", {
    "web.enabled": { type: "boolean", value: "false" },
    "web.lan": { type: "boolean", value: "false" },
    "web.port": { type: "number", value: "7420" },
  });
  cfg("cfg-backup", "备份 Backup", null, "Snapshots and scheduled backups.", { "backup.schedule": { type: "text", value: "daily" }, "backup.keep": { type: "number", value: "14" } });
  cfg("cfg-audit", "审计 Audit", null, "", {}, { target: "core:audit" });
  cfg("cfg-io", "导入与导出 Import & export", null, "Export or import the whole workspace.", { "export.directory": { type: "text", value: "~/Exports" } });

  /* ---- data sources */
  const ds = (id: string, name: string, parentId: string, body: Record<string, unknown>, extra: Partial<Row> = {}) =>
    add({ id, kind: "org.onedesk.sql:datasource", tree: "datasources", name, parentId, body, ...extra });
  group("dg-prod", "生产 Production", null, "datasources");
  ds("ds-prod", "shop-prod (MySQL 8.0)", "dg-prod", { driver: "mysql", host: "db-prod-01.internal.example.com", port: "3306", database: "shop", user: "onedesk_ro", password: "onedesk/ds/shop-prod", ssl: "true", notes: "主库。只读账号。" });
  ds("ds-replica", "shop-replica (MySQL 8.0)", "dg-prod", { driver: "mysql", host: "db-prod-ro-02.internal.example.com", port: "3306", database: "shop", user: "onedesk_ro", password: "onedesk/ds/shop-replica", ssl: "true", notes: "只读副本，报表用。" });
  ds("ds-analytics", "analytics (PostgreSQL 16)", "dg-prod", { driver: "postgres", host: "pg-analytics.internal.example.com", port: "5432", database: "warehouse", user: "analyst", password: "onedesk/ds/analytics", ssl: "true", notes: "" });
  group("dg-test", "测试 Test", null, "datasources");
  ds("ds-staging", "shop-staging (MySQL 8.0)", "dg-test", { driver: "mysql", host: "db-staging.internal.example.com", port: "3306", database: "shop", user: "onedesk", password: "onedesk/ds/shop-staging", ssl: "false", notes: "每晚同步，数据已脱敏。" });
  ds("ds-local", "local.sqlite", "dg-test", { driver: "sqlite", host: "", port: "", database: "~/tmp/local.sqlite", user: "", password: "", ssl: "false", notes: "" }, { state: "missing", description: "The database file no longer exists." });

  /* ---- a few deleted items */
  const old = sql("q-old-report", "旧版周报 (deprecated)", "g-scratch", `SELECT * FROM weekly_report_v1`, { dataset: "generic", rows: 10 });
  old.deletedAt = now - 3 * DAY;
  const old2 = note("n-old-draft", "草稿：迁移方案", "g-scratch", { summary: "", owner: "ops", review_date: "", content: "TODO" });
  old2.deletedAt = now - 9 * DAY;

  return rows;
}

export const SEED_FAVORITES = ["q-orders-today", "q-slow", "n-runbook", "q-revenue"];

/* ------------------------------------------------------------------ plugins */

export interface PluginRow {
  id: string;
  name: Label;
  icon: string;
  description: Label;
  author: string;
  license: string;
  homepage: string;
  enabled: boolean;
  builtin: boolean;
  installed: boolean;
  versions: PluginVersion[];
  settings: PluginSetting[];
  permissions: PluginPermission[];
  provides: { kinds: Label[]; actions: Label[]; trees: Label[]; resultTabs: Label[]; other: Label[] };
  /** The version that fails to load on this host, with the reason. */
  bad?: { version: string; reason: string };
  loadMs: number;
}

export function seedPlugins(now: number): PluginRow[] {
  const v = (version: string, daysAgo: number, active: boolean, notes: string, pinned = false): PluginVersion => ({ version, installedAt: now - daysAgo * DAY, active, pinned, notes, permissions: [], fingerprint: "" });
  const none = { kinds: [], actions: [], trees: [], resultTabs: [], other: [] };
  return [
    {
      id: "org.onedesk.sql",
      name: "SQL",
      icon: "file-code",
      description: {
        "en-US": "Write, parameterise and run SQL against the workspace's data sources. Parameters written as :name come from the tab's environment first, then from the form. Results are kept per run.",
        "zh-CN": "编写、参数化并执行 SQL。:name 形式的参数先从标签页的环境取值，环境里没有的才在表单里填。每次执行的结果单独保存。",
      },
      author: "OneDesk",
      license: "Apache-2.0",
      homepage: "https://onedesk.example.com/plugins/sql",
      enabled: true,
      builtin: true,
      installed: true,
      versions: [v("2.3.1", 6, true, "Fix: datetime presets ignored the time zone.", true), v("2.3.0", 31, false, "History opens in a new tab; export CSV with BOM."), v("2.2.0", 96, false, "Parameter strip; :name detection.")],
      settings: [
        { name: "default_limit", label: { "en-US": "Default row limit", "zh-CN": "默认行数上限" }, kind: "number", value: "1000", hint: { "en-US": "Used when a query has no LIMIT.", "zh-CN": "查询没有写 LIMIT 时使用。" } },
        { name: "history_rows", label: { "en-US": "Rows kept in history", "zh-CN": "历史中保留的行数" }, kind: "number", value: "1000" },
        { name: "null_text", label: { "en-US": "Show NULL as", "zh-CN": "NULL 的显示" }, kind: "text", value: "NULL" },
        { name: "confirm_writes", label: { "en-US": "Confirm statements that change data", "zh-CN": "写操作执行前确认" }, kind: "boolean", value: "true" },
      ],
      permissions: [
        { id: "process", label: { "en-US": "Run database clients", "zh-CN": "运行数据库客户端" }, detail: "mysql, psql, sqlite3", granted: true, required: true },
        { id: "network", label: { "en-US": "Connect to data sources", "zh-CN": "连接数据源" }, detail: "*.internal.example.com:3306, :5432", granted: true, required: true },
        { id: "secrets", label: { "en-US": "Read data source passwords", "zh-CN": "读取数据源密码" }, detail: "keychain: onedesk/ds/*", granted: true, required: true },
        { id: "files", label: { "en-US": "Write exported files", "zh-CN": "写出导出文件" }, detail: "~/Exports", granted: true, required: false },
      ],
      provides: {
        kinds: [KINDS["org.onedesk.sql:query"]!.label, KINDS["org.onedesk.sql:datasource"]!.label],
        actions: [{ "en-US": "Run", "zh-CN": "执行" }, { "en-US": "Explain", "zh-CN": "执行计划" }, { "en-US": "Format", "zh-CN": "格式化" }, { "en-US": "Test connection", "zh-CN": "测试连接" }],
        trees: [{ "en-US": "Data sources", "zh-CN": "数据源" }],
        resultTabs: [{ "en-US": "Sent SQL", "zh-CN": "最终 SQL" }],
        other: [],
      },
      loadMs: 41,
    },
    {
      id: "org.onedesk.note",
      name: { "en-US": "Notes", "zh-CN": "笔记" },
      icon: "notebook-pen",
      description: { "en-US": "Plain notes with a few structured fields. Links like [[name]] keep working when the target is renamed.", "zh-CN": "带少量结构化字段的笔记。[[名称]] 形式的引用在目标改名后仍然有效。" },
      author: "OneDesk",
      license: "Apache-2.0",
      homepage: "https://onedesk.example.com/plugins/note",
      enabled: true,
      builtin: true,
      installed: true,
      versions: [v("1.4.0", 20, true, "Review date field."), v("1.3.2", 140, false, "")],
      settings: [{ name: "default_owner", label: { "en-US": "Default owner", "zh-CN": "默认负责人" }, kind: "enum", value: "data", options: [{ value: "data", label: "data" }, { value: "ops", label: "ops" }, { value: "finance", label: "finance" }] }],
      permissions: [],
      provides: { ...none, kinds: [KINDS["org.onedesk.note:note"]!.label], actions: [{ "en-US": "Export Markdown", "zh-CN": "导出 Markdown" }] },
      loadMs: 12,
    },
    {
      id: "org.onedesk.files",
      name: { "en-US": "Disk files", "zh-CN": "硬盘文件" },
      icon: "hard-drive",
      description: { "en-US": "Browse folders you have authorised and import files as resources.", "zh-CN": "浏览已授权的文件夹，并把文件导入为资源。" },
      author: "OneDesk",
      license: "Apache-2.0",
      homepage: "https://onedesk.example.com/plugins/files",
      enabled: true,
      builtin: true,
      installed: true,
      versions: [v("1.1.0", 44, true, "Batched folder listing.")],
      settings: [{ name: "show_hidden", label: { "en-US": "Show hidden files", "zh-CN": "显示隐藏文件" }, kind: "boolean", value: "false" }],
      permissions: [{ id: "files", label: { "en-US": "Read authorised folders", "zh-CN": "读取已授权的文件夹" }, detail: "~/Documents/sql-archive, ~/Exports", granted: true, required: true }],
      provides: { ...none, trees: [{ "en-US": "Files", "zh-CN": "文件" }], actions: [{ "en-US": "Import folder", "zh-CN": "导入文件夹" }] },
      loadMs: 9,
    },
    {
      id: "org.onedesk.ai",
      name: { "en-US": "AI assistant", "zh-CN": "AI 助手" },
      icon: "sparkles",
      description: { "en-US": "Adds an “Analyze” action to table and text results, and can draft SQL. Bound by the environment's ai.policy.", "zh-CN": "给表格和文字结果加上“分析”动作，也可以起草 SQL。受环境的 ai.policy 约束。" },
      author: "OneDesk",
      license: "Apache-2.0",
      homepage: "https://onedesk.example.com/plugins/ai",
      enabled: true,
      builtin: false,
      installed: true,
      versions: [v("0.9.2", 3, true, "Respect ai.policy = metadata-only."), v("0.9.0", 28, false, "")],
      settings: [
        { name: "model", label: { "en-US": "Model", "zh-CN": "模型" }, kind: "enum", value: "default", options: [{ value: "default", label: { "en-US": "Provider default", "zh-CN": "服务商默认" } }, { value: "small", label: { "en-US": "Small and fast", "zh-CN": "小而快" } }] },
        { name: "max_rows", label: { "en-US": "Rows sent for analysis", "zh-CN": "发送分析的行数" }, kind: "number", value: "200" },
      ],
      permissions: [
        { id: "network", label: { "en-US": "Call the model provider", "zh-CN": "访问模型服务" }, detail: "api.example-llm.com:443", granted: true, required: true },
        { id: "results", label: { "en-US": "Read a result when you click Analyze", "zh-CN": "点击“分析”时读取该次结果" }, detail: "table, text", granted: true, required: true },
        { id: "secrets", label: { "en-US": "Read its API key", "zh-CN": "读取自己的 API 密钥" }, detail: "keychain: onedesk/ai/api_key", granted: false, required: true },
      ],
      provides: { ...none, resultTabs: [{ "en-US": "AI analysis", "zh-CN": "AI 分析" }], actions: [{ "en-US": "Analyze result", "zh-CN": "分析结果" }] },
      loadMs: 58,
    },
    {
      id: "org.onedesk.git",
      name: { "en-US": "Git versioning", "zh-CN": "Git 版本化" },
      icon: "git-branch",
      description: { "en-US": "Commits versioned resources to a git repository and pulls remote changes. Conflicts are never resolved silently.", "zh-CN": "把纳入版本化的资源提交到 git 仓库，并拉取远程改动。冲突不会被静默处理。" },
      author: "OneDesk",
      license: "Apache-2.0",
      homepage: "https://onedesk.example.com/plugins/git",
      enabled: true,
      builtin: false,
      installed: true,
      versions: [v("1.0.3", 12, true, ""), v("1.0.1", 70, false, "")],
      settings: [{ name: "git_path", label: { "en-US": "git executable", "zh-CN": "git 可执行文件" }, kind: "text", value: "/usr/bin/git" }],
      permissions: [
        { id: "process", label: { "en-US": "Run git", "zh-CN": "运行 git" }, detail: "/usr/bin/git", granted: true, required: true },
        { id: "network", label: { "en-US": "Reach the remote", "zh-CN": "访问远程仓库" }, detail: "github.com:443", granted: true, required: false },
      ],
      provides: { ...none, other: [{ "en-US": "Background task: sync", "zh-CN": "后台任务：同步" }] },
      loadMs: 22,
    },
    {
      id: "org.onedesk.lang.zh-cn",
      name: { "en-US": "Language: 简体中文", "zh-CN": "语言：简体中文" },
      icon: "languages",
      description: { "en-US": "Simplified Chinese interface text. English is built in and is the fallback.", "zh-CN": "简体中文界面文字。英语内置，并作为兜底。" },
      author: "OneDesk",
      license: "Apache-2.0",
      homepage: "https://onedesk.example.com/plugins/lang-zh-cn",
      enabled: true,
      builtin: true,
      installed: true,
      versions: [v("1.2.0", 6, true, "")],
      settings: [],
      permissions: [],
      provides: { ...none, other: [{ "en-US": "Interface language", "zh-CN": "界面语言" }] },
      loadMs: 4,
    },
    {
      id: "org.onedesk.mongo",
      name: "MongoDB",
      icon: "leaf",
      description: { "en-US": "Run MongoDB find and aggregate queries. Disabled here: its resources stay visible, greyed out.", "zh-CN": "执行 MongoDB 的 find 与 aggregate。这里已停用：它的资源仍然显示，为灰色。" },
      author: "Community · chen.yu",
      license: "MIT",
      homepage: "https://example.com/onedesk-mongo",
      enabled: false,
      builtin: false,
      installed: true,
      versions: [v("0.4.0", 51, true, "")],
      settings: [{ name: "timeout", label: { "en-US": "Timeout (s)", "zh-CN": "超时（秒）" }, kind: "number", value: "30" }],
      permissions: [{ id: "network", label: { "en-US": "Connect to MongoDB", "zh-CN": "连接 MongoDB" }, detail: "mongo.internal.example.com:27017", granted: true, required: true }],
      provides: { ...none, kinds: [KINDS["org.onedesk.mongo:query"]!.label], actions: [{ "en-US": "Run", "zh-CN": "执行" }] },
      loadMs: 0,
    },
    {
      id: "com.example.slack-notify",
      name: { "en-US": "Slack notify", "zh-CN": "Slack 通知" },
      icon: "bell-ring",
      description: { "en-US": "Posts a message when a long run ends. This version fails to load: its manifest asks for an API the host does not have.", "zh-CN": "长时间的运行结束时发一条消息。这个版本加载失败：清单要求的接口版本宿主不提供。" },
      author: "Community · example.com",
      license: "MIT",
      homepage: "https://example.com/onedesk-slack",
      enabled: true,
      builtin: false,
      installed: true,
      versions: [v("0.2.0", 2, true, "Requires apiVersion 3."), v("0.1.4", 40, false, "Last version that loads on this host.")],
      settings: [{ name: "channel", label: { "en-US": "Channel", "zh-CN": "频道" }, kind: "text", value: "#data-alerts" }],
      permissions: [{ id: "network", label: { "en-US": "Call Slack", "zh-CN": "访问 Slack" }, detail: "hooks.slack.com:443", granted: false, required: true }],
      provides: { ...none, other: [{ "en-US": "Notification on run end", "zh-CN": "运行结束通知" }] },
      bad: { version: "0.2.0", reason: 'manifest.json: apiVersion "3" is not supported by this host (supports "2"). Activate version 0.1.4 or update OneDesk.' },
      loadMs: 0,
    },
    {
      id: "org.onedesk.http",
      name: { "en-US": "HTTP requests", "zh-CN": "HTTP 请求" },
      icon: "send",
      description: { "en-US": "Not installed. Two resources in this workspace need it; they are shown with a marker until it is installed.", "zh-CN": "未安装。工作区里有两条资源需要它；安装之前它们带标记显示。" },
      author: "OneDesk",
      license: "Apache-2.0",
      homepage: "https://onedesk.example.com/plugins/http",
      enabled: false,
      builtin: false,
      installed: false,
      versions: [],
      settings: [],
      permissions: [],
      provides: { ...none, kinds: [KINDS["org.onedesk.http:request"]!.label] },
      loadMs: 0,
    },
  ];
}

/* ------------------------------------------------------------------ fake result sets */

/** Small deterministic PRNG so the same run always shows the same rows. */
export function prng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["王伟", "李娜", "张敏", "刘洋", "陈静", "杨磊", "赵丽", "黄强", "周杰", "吴芳", "Emma Clark", "Liam Scott", "Noah Reed", "Olivia Hayes", "Mia Turner", "上海锦程贸易", "杭州云栖科技", "深圳前海物流", "Northwind Ltd", "Acme GmbH", "北京海淀图书", "广州越秀食品"];
const CHANNELS = ["app", "web", "mini-program", "pos", "partner", "douyin"];
const STATUSES = ["paid", "shipped", "done", "refunded", "cancelled"];
const WAREHOUSES = ["上海一仓", "上海二仓", "广州仓", "成都仓", "天津仓"];
const TABLES = ["orders", "order_items", "customers", "users", "user_stats", "user_sessions", "refunds", "invoices", "warehouses", "inventory", "inventory_log", "coupons", "coupon_usage", "audit_log", "payments", "payment_log"];

type Gen = (i: number, rnd: () => number, now: number) => OutputCell;
interface DatasetDef {
  columns: Array<OutputColumn & { gen: Gen }>;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export function fmtDateTime(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export const fmtDate = (t: number) => fmtDateTime(t).slice(0, 10);
const pick = <T,>(list: T[], rnd: () => number): T => list[Math.floor(rnd() * list.length)]!;
const money = (rnd: () => number, max: number) => Math.round(rnd() * rnd() * max * 100) / 100;
const col = (key: string, gen: Gen, numeric = false): OutputColumn & { gen: Gen } => ({ key, label: key, numeric, gen });
const month = (i: number, now: number) => {
  const d = new Date(now);
  d.setMonth(d.getMonth() - i);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

const DATASETS: Record<string, DatasetDef> = {
  orders: {
    columns: [
      col("order_id", (i) => 88_120_400 - i * 3, true),
      col("created_at", (i, r, now) => fmtDateTime(now - i * 4 * MINUTE - Math.floor(r() * 3 * MINUTE))),
      col("customer", (_i, r) => pick(NAMES, r)),
      col("channel", (_i, r) => pick(CHANNELS, r)),
      col("status", (_i, r) => pick(STATUSES, r)),
      col("amount", (_i, r) => money(r, 4200), true),
      col("items", (_i, r) => 1 + Math.floor(r() * 6), true),
    ],
  },
  overdue: {
    columns: [
      col("order_id", (i) => 88_101_200 - i * 17, true),
      col("paid_at", (i, r, now) => fmtDateTime(now - (30 + i * 2) * HOUR - Math.floor(r() * HOUR))),
      col("hours_waiting", (i) => 30 + i * 2, true),
      col("warehouse", (_i, r) => pick(WAREHOUSES, r)),
      col("customer", (_i, r) => pick(NAMES, r)),
    ],
  },
  gmv: {
    columns: [
      col("month", (i, _r, now) => month(Math.floor(i / 6), now)),
      col("channel", (i) => CHANNELS[i % 6]!),
      col("orders", (_i, r) => 800 + Math.floor(r() * 9000), true),
      col("gmv", (_i, r) => Math.round((200_000 + r() * 2_400_000) * 100) / 100, true),
      col("avg_order", (_i, r) => Math.round((120 + r() * 260) * 100) / 100, true),
    ],
  },
  repeat: {
    columns: [
      col("cohort_month", (i, _r, now) => month(i, now)),
      col("customers", (_i, r) => 3000 + Math.floor(r() * 5000), true),
      col("repeat_customers", (_i, r) => 600 + Math.floor(r() * 1800), true),
      col("repeat_rate", (_i, r) => Math.round((0.18 + r() * 0.2) * 10000) / 10000, true),
    ],
  },
  users_channel: {
    columns: [
      col("date", (i, _r, now) => fmtDate(now - Math.floor(i / 6) * DAY)),
      col("channel", (i) => CHANNELS[i % 6]!),
      col("new_users", (_i, r) => 40 + Math.floor(r() * 900), true),
      col("activated", (_i, r) => 10 + Math.floor(r() * 300), true),
      col("activation_rate", (_i, r) => Math.round((0.2 + r() * 0.4) * 10000) / 10000, true),
    ],
  },
  inactive: {
    columns: [
      col("user_id", (i) => 500_310 + i * 41, true),
      col("name", (_i, r) => pick(NAMES, r)),
      col("last_login_at", (i, r, now) => (r() < 0.04 ? null : fmtDateTime(now - (90 + i) * DAY - Math.floor(r() * DAY)))),
      col("days_inactive", (i) => 90 + i, true),
      col("lifetime_value", (i, r) => Math.round((90_000 / (i + 3) + r() * 300) * 100) / 100, true),
    ],
  },
  slow: {
    columns: [
      col("digest", (_i, r) => Math.floor(r() * 0xffffffff).toString(16).padStart(8, "0") + Math.floor(r() * 0xffffffff).toString(16).padStart(8, "0")),
      col("query_sample", (_i, r) => `SELECT * FROM ${pick(TABLES, r)} WHERE ${pick(["customer_id", "created_at", "status", "order_id"], r)} = ? ORDER BY created_at DESC LIMIT ?`),
      col("calls", (_i, r) => 20 + Math.floor(r() * 40_000), true),
      col("avg_ms", (i, r) => Math.round((4200 / (i + 1) + r() * 40) * 10) / 10, true),
      col("max_ms", (i, r) => Math.round((19_000 / (i + 1) + r() * 900) * 10) / 10, true),
      col("rows_examined", (_i, r) => Math.floor(r() * 90_000_000), true),
    ],
  },
  repl: {
    columns: [
      col("replica", (i) => `db-prod-ro-0${i + 1}`),
      col("io_running", () => "Yes"),
      col("sql_running", (i) => (i === 2 ? "No" : "Yes")),
      col("lag_seconds", (i) => (i === 2 ? null : i * 3), true),
      col("last_error", (i) => (i === 2 ? "Error 1062: Duplicate entry '88120133' for key 'PRIMARY'" : "")),
    ],
  },
  sizes: {
    columns: [
      col("table_schema", () => "shop"),
      col("table_name", (i) => (i < TABLES.length ? TABLES[i]! : `${TABLES[i % TABLES.length]!}_${2020 + (i % 5)}`)),
      col("rows", (i, r) => Math.floor(90_000_000 / (i + 1) + r() * 5000), true),
      col("data_mb", (i, r) => Math.round((48_000 / (i + 1) + r() * 20) * 10) / 10, true),
      col("index_mb", (i, r) => Math.round((17_000 / (i + 1) + r() * 12) * 10) / 10, true),
    ],
  },
  invoices: {
    columns: [
      col("invoice_no", (i) => `INV-2026-${pad(11_820 - i, 6)}`),
      col("issued_at", (i, r, now) => fmtDateTime(now - i * 3 * HOUR - Math.floor(r() * HOUR))),
      col("customer", (_i, r) => pick(NAMES.slice(15), r)),
      col("amount", (_i, r) => money(r, 180_000), true),
      col("tax", (_i, r) => money(r, 18_000), true),
      col("status", (_i, r) => pick(["issued", "issued", "issued", "void", "pending"], r)),
    ],
  },
  revenue: {
    columns: [
      col("date", (i, _r, now) => fmtDate(now - i * DAY)),
      col("revenue", (_i, r) => Math.round((180_000 + r() * 240_000) * 100) / 100, true),
      col("refunds", (_i, r) => Math.round(r() * 22_000 * 100) / 100, true),
      col("net", (_i, r) => Math.round((170_000 + r() * 230_000) * 100) / 100, true),
    ],
  },
  aging: {
    columns: [
      col("customer", (_i, r) => pick(NAMES.slice(15), r)),
      col("current", (_i, r) => money(r, 400_000), true),
      col("d30", (_i, r) => money(r, 200_000), true),
      col("d60", (_i, r) => money(r, 90_000), true),
      col("d90", (_i, r) => (r() < 0.5 ? 0 : money(r, 60_000)), true),
      col("total", (_i, r) => money(r, 700_000), true),
    ],
  },
  generic: {
    columns: [
      col("id", (i) => i + 1, true),
      col("name", (_i, r) => pick(NAMES, r)),
      col("value", (_i, r) => Math.round(r() * 10_000) / 100, true),
      col("updated_at", (i, r, now) => fmtDateTime(now - i * HOUR - Math.floor(r() * HOUR))),
    ],
  },
};

export function generateTable(dataset: string, count: number, seed: number, now: number): { columns: OutputColumn[]; rows: OutputCell[][] } {
  const def = DATASETS[dataset] ?? DATASETS.generic!;
  const rnd = prng(seed * 7919 + dataset.length);
  const rows: OutputCell[][] = [];
  for (let i = 0; i < count; i++) rows.push(def.columns.map((c) => c.gen(i, rnd, now)));
  return { columns: def.columns.map(({ key, label, numeric }) => ({ key, label, numeric })), rows };
}

/* ------------------------------------------------------------------ fake files (provided tree) */

export interface FakeFile {
  name: string;
  size?: number;
  modifiedDaysAgo?: number;
  content?: string;
  children?: FakeFile[];
}

export const FILE_ROOTS: FakeFile[] = [
  {
    name: "~/Documents/sql-archive",
    children: [
      {
        name: "2024",
        children: [
          { name: "q1-revenue.sql", size: 1840, modifiedDaysAgo: 610, content: "SELECT DATE(paid_at) AS date, SUM(pay_amount) AS revenue\nFROM   orders_2024\nWHERE  paid_at < '2024-04-01'\nGROUP  BY date;\n" },
          { name: "q2-revenue.sql", size: 1851, modifiedDaysAgo: 520, content: "SELECT DATE(paid_at) AS date, SUM(pay_amount) AS revenue\nFROM   orders_2024\nWHERE  paid_at >= '2024-04-01' AND paid_at < '2024-07-01'\nGROUP  BY date;\n" },
          { name: "churn.sql", size: 2210, modifiedDaysAgo: 480, content: "-- 流失用户：连续 60 天未下单\nSELECT user_id FROM user_stats WHERE last_order_at < NOW() - INTERVAL 60 DAY;\n" },
        ],
      },
      {
        name: "2025",
        children: [
          { name: "双十一复盘.sql", size: 5320, modifiedDaysAgo: 360, content: "SELECT channel, COUNT(*) AS orders, SUM(pay_amount) AS gmv\nFROM   orders\nWHERE  created_at BETWEEN '2025-11-10' AND '2025-11-12'\nGROUP  BY channel;\n" },
          { name: "warehouse-capacity.sql", size: 990, modifiedDaysAgo: 300, content: "SELECT warehouse_id, SUM(qty) FROM inventory GROUP BY warehouse_id;\n" },
        ],
      },
      { name: "migrate_users.sql", size: 12_480, modifiedDaysAgo: 200, content: "ALTER TABLE users ADD COLUMN activated_at DATETIME NULL;\nUPDATE users u JOIN (SELECT customer_id, MIN(created_at) t FROM orders GROUP BY customer_id) o ON o.customer_id = u.id SET u.activated_at = o.t;\n" },
      { name: "README.md", size: 420, modifiedDaysAgo: 200, content: "# sql-archive\n\n历史 SQL 存档。新的查询请直接在 OneDesk 里写。\n" },
    ],
  },
  {
    name: "~/Exports",
    children: [
      { name: "orders-2026-11-14.csv", size: 48_112, modifiedDaysAgo: 1, content: "order_id,created_at,customer,channel,status,amount,items\n88120400,2026-11-14 23:58:10,王伟,app,paid,318.00,2\n88120397,2026-11-14 23:54:41,Emma Clark,web,paid,1299.00,1\n…\n" },
      { name: "slow-queries.csv", size: 6_204, modifiedDaysAgo: 4, content: "digest,calls,avg_ms\n9f3a11c0e2b47d15,18233,4188.2\n…\n" },
      { name: "ar-aging-2026-10.xlsx", size: 88_300, modifiedDaysAgo: 15 },
    ],
  },
];

/* ------------------------------------------------------------------ audit seed */

export const OPERATIONS: Record<string, Label> = {
  "resource.update": { "en-US": "Edit resource", "zh-CN": "修改资源" },
  "resource.create": { "en-US": "Create resource", "zh-CN": "新建资源" },
  "resource.delete": { "en-US": "Delete resource", "zh-CN": "删除资源" },
  "resource.restore": { "en-US": "Restore resource", "zh-CN": "恢复资源" },
  "tree.move": { "en-US": "Move node", "zh-CN": "移动节点" },
  "run.start": { "en-US": "Start run", "zh-CN": "开始运行" },
  "run.end": { "en-US": "End run", "zh-CN": "运行结束" },
  "params.set": { "en-US": "Change parameter", "zh-CN": "修改参数" },
  "plugin.enable": { "en-US": "Enable plugin", "zh-CN": "启用插件" },
  "plugin.disable": { "en-US": "Disable plugin", "zh-CN": "停用插件" },
  "plugin.permission": { "en-US": "Change plugin permission", "zh-CN": "修改插件权限" },
  "policy.deny": { "en-US": "Blocked by policy", "zh-CN": "被策略拒绝" },
  "secrets.read": { "en-US": "Read secret", "zh-CN": "读取密钥" },
  "data.export": { "en-US": "Export data", "zh-CN": "导出数据" },
  "resource.aiVisible": { "en-US": "Change AI visibility", "zh-CN": "修改 AI 可见" },
  "mcp.call": { "en-US": "AI tool call", "zh-CN": "AI 工具调用" },
};

/** Demo audit rows carry their own label; the interface words operations by id (`i18n/kernel-texts.ts`). */
export interface MockAuditRow extends AuditRow {
  operationLabel: Label;
}

export function seedAudit(now: number): MockAuditRow[] {
  const rnd = prng(20261115);
  const ops = Object.keys(OPERATIONS);
  const targets = ["今日订单汇总", "慢查询 Top 20", "月度 GMV by channel", "Inactive users (90d)", "正式 Production", "测试 Staging", "shop-prod (MySQL 8.0)", "值班手册 On-call runbook", "Daily revenue", "SQL", "MongoDB"];
  const rows: MockAuditRow[] = [];
  let t = now - 20 * MINUTE;
  for (let i = 0; i < 160; i++) {
    t -= Math.floor(rnd() * 5 * HOUR) + 3 * MINUTE;
    const operation = pick(ops, rnd);
    const actor = rnd() < 0.6 ? ME : pick(ACTORS, rnd);
    const denied = operation === "policy.deny";
    const failed = !denied && operation === "run.end" && rnd() < 0.15;
    rows.push({
      id: `a-seed-${i}`,
      at: t,
      actor,
      source: actor === "ops-bot" ? "scheduled" : operation === "secrets.read" ? "plugin" : rnd() < 0.05 ? "ai" : "user",
      operation,
      operationLabel: OPERATIONS[operation]!,
      target: pick(targets, rnd),
      result: denied ? "denied" : failed ? "error" : "ok",
      detail: denied
        ? "protection.readonly (正式 Production): DELETE is not allowed"
        : failed
          ? "ERROR 1205 (HY000): Lock wait timeout exceeded"
          : operation === "params.set"
            ? `limit: ${500 + Math.floor(rnd() * 5) * 500} → ${1000 + Math.floor(rnd() * 5) * 500}`
            : operation === "run.end"
              ? `${Math.floor(rnd() * 900)} rows · ${(0.3 + rnd() * 3).toFixed(2)} s`
              : operation === "secrets.read"
                ? "onedesk/ds/shop-prod → org.onedesk.sql"
                : "",
    });
  }
  const aiCalls: Array<[string, Record<string, unknown>, number, number, boolean, string | null]> = [
    ["search", { query: "orders" }, 3, 41, true, null],
    ["describe", { id: "q-orders-today" }, 0, 12, true, null],
    ["run", { id: "q-orders-today", params: "[2 items]" }, 200, 830, true, null],
    ["org_onedesk_sql__run_sql", { sql: "SELECT * FROM orders" }, 0, 3, false, "aiFreeQuery"],
  ];
  aiCalls.forEach(([tool, args, count, ms, ok, code], i) => {
    rows.unshift({
      id: `a-ai-${i}`,
      at: now - (i + 1) * 4 * MINUTE,
      actor: "ai:Claude Desktop",
      source: "ai",
      operation: "mcp.call",
      operationLabel: OPERATIONS["mcp.call"]!,
      target: tool,
      result: ok ? "ok" : "denied",
      detail: JSON.stringify({ tool, args, rows: count, ms, ok, code, reason: null }),
    });
  });
  return rows;
}
