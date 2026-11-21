# org.onedesk.catalog — 查询目录

把用户授权文件夹里的 `.sql` 文件建成只读的查询目录（`sqlpool-parity.md` A1–A10）。文件是源头，应用不改文件。表插件 `org.onedesk.table` 读同一份映射文件（经本插件导出的 `mapping` 动作）。

> 说明：本机没有 sqlpool 源码（`sqlpool-parity.md` 里的路径已不存在），下面的格式按 parity 清单和需求文档整理。若与 sqlpool 的实际文件有出入，以本文件为准修改插件，并在 `docs/decisions.md` 记一笔。

## 1. 查询文件

每个 `.sql` 文件以 YAML 头开始，两种写法都可以：

```sql
/* ---
id: sales.orders.recent
title: 最近的订单
description: 某个时间之后下的订单
datasource: 生产只读          # 可选：数据源的名称或 id
permissions: [read]           # 可选：列表或单个值，原样显示
tags: [sales]
params:
  - name: since
    type: datetime            # text | number | date | datetime | time | enum
    required: true
    description: 从这个时间起
  - name: status
    values: [paid, refunded]  # 有 values 即为 enum
--- */
SELECT o.{{order.id}}, o.{{order.total}}
FROM {{order}} o
WHERE o.{{order.created}} >= :since AND o.{{order.status}} = :status
```

```sql
-- ---
-- id: sales.top
-- params: [n]
-- ---
SELECT * FROM {{customer}} LIMIT :n
```

- `id` 必填，由字母、数字、`_`、`-` 组成，用 `.` 分段；同一个 id 出现在两个文件里时，后一个跳过。
- `params` 可以是映射列表、名字列表，或 `名字: 类型` 的映射。
- 头部无法解析、缺 id、id 不合法、参数不合法、没有正文的文件不进目录，在“索引报告”页和“重新索引”的结果里列出原因。
- 目录树按 id 的前两段分组：`sales.orders.recent` 在 `sales › orders` 下，`sales.top` 在 `sales` 下。

### 正文里的语法（本插件定义，规则 5）

| 写法 | 含义 |
|---|---|
| `:name` | 参数。与 SQL 插件相同：字符串、引号名、`$$`、注释里不算，`::` 是类型转换。值写成 SQL 字面量（单引号加倍，空 = NULL）。 |
| `{{实体}}` | 换成映射里的表名；时间版本实体换成“某一时刻生效的最新版本”的子查询（见 §3）。 |
| `{{实体.字段}}` | 换成映射里该字段的列名（只是列名，表别名自己写）。 |

检查（页面顶部的警告条）：正文用了但头部没声明的参数；声明了但没用的参数；映射里没有的占位符；用了占位符但映射文件不可用。

## 2. 映射文件

位置：插件设置 `mappingFile`（必须是以 `/` 开头的完整路径，须在授权文件夹内；相对路径会被拒绝，因为宿主把相对路径当作插件自己的目录）；留空则取授权文件夹顶层的 `mapping.yaml`、`mapping.yml` 或 `mapping.json`（取找到的第一个）。YAML 与 JSON 结构相同：

```yaml
entities:
  order:
    table: shop.orders            # 必填；schema.table 或 table
    description: 订单，每次修改一行新版本
    columns:                      # 字段名 → 列名；也可写 { column, description }
      id: order_id
      total: { column: total_amount, description: 含税金额 }
      created: created_at
      status: status
    versioned:                    # 可选：时间版本实体
      key: [order_id]             # 一条记录的键（可多列）
      from: valid_from            # 这个版本开始生效的时间
      to: valid_to                # 可选：这个版本失效的时间（空 = 仍有效）
      deleted: is_deleted         # 可选：布尔列，true = 这个版本表示已删除
  customer: shop.customers        # 简写：只有表名
```

- 实体名、字段名只能用字母、数字、`_`，不以数字开头。
- 不合格的条目跳过，不影响其余条目。
- 名字里不是“小写字母、数字、`_`”的部分会加双引号。
- 表插件按表名的前缀分组（`shop.orders` 去掉 schema 后按 `_` 分段）。

## 3. 时间版本实体

`{{order}}`（`versioned` 的实体）换成：

```sql
(SELECT * FROM (
   SELECT DISTINCT ON (order_id) * FROM shop.orders
   WHERE valid_from <= T AND (valid_to IS NULL OR valid_to > T)
   ORDER BY order_id, valid_from DESC
 ) AS od_v WHERE NOT od_v.is_deleted)
```

其中 `T = COALESCE(CAST(:as_of AS timestamptz), now())`。没有 `to` 就没有那半句，没有 `deleted` 就没有外层。后面没有写别名时自动加 `AS order`。页面在用到时间版本实体时多一个“截至时间”输入（参数名 `as_of`，UTC，留空 = 现在）；头部自己声明了 `as_of` 时用头部的声明。

## 4. 用到的宿主能力（名字见 `docs/handoff/round16-protocol.md`）

- 清单 `activation: ["workspace.opened"]`，代码 `host.events.on("workspace.opened", h)`：工作区打开后同步一次（X13）。
- `ctx.host.resources.upsertByKey("entry", [{ key: 路径, name?, description, body }], { othersMissing: true })`：一条批量命令。已索引的文件不传 `name`（保留用户改的名字），只写说明和正文；不在这批里的标为失效。
- 失效的资源带 `missing: true`（页面显示为 `broken` / `sourceMissing`）；按 D422 目录树照常列出它，用警告图标和“失效”徽标标出（提供树节点还不能带状态），页面照常打开并显示警告。
- 遍历按 `files.stat` 返回的真实路径去重；超过 5000 个文件或 12 层时停下，这次不标失效，并在报告里写明。
- SQL 插件导出的 `org.onedesk.sql:create`（尚未提供，见交接文件）：输入 `{ name, description, sql, source, params }`，输出 `link`，打开时带上 `params`。
