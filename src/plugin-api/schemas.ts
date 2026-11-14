/**
 * OneDesk public plugin API — JSON shapes and their zod validators (apiVersion "1").
 * Everything here is data that crosses the plugin boundary and is validated by the host.
 * Frozen for milestone 1: changes only via the lead session + docs/decisions.md.
 */
import { z } from "zod";

export const API_VERSION = "1" as const;

// ---------------------------------------------------------------- identifiers

/** Reverse-domain plugin id, e.g. `org.onedesk.link`. */
export const PluginIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$/, "插件 id 必须是反向域名格式，如 org.example.link");

/** Local id for kinds, actions, views: lower-kebab-case. */
export const LocalIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "id 只能包含小写字母、数字和连字符，并以字母开头");

/** Parameter / field names usable in `{{name}}` placeholders (D08). */
export const ParamNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "名字只能包含字母、数字和下划线");

// ---------------------------------------------------------------- fields

export const FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "url",
  "boolean",
  "select",
  "reference",
  "parameter",
] as const;
export const FieldTypeSchema = z.enum(FIELD_TYPES);

/**
 * A field in a kind schema, action input, or plugin settings.
 * - `select`: requires `options`.
 * - `reference`: value is a resource id; `refKind` restricts the target kind.
 * - `parameter`: value is `ParameterDef[]` (a list of parameter definitions).
 */
export const FieldDefSchema = z
  .object({
    name: ParamNameSchema,
    label: z.string().min(1),
    type: FieldTypeSchema,
    required: z.boolean().optional(),
    description: z.string().optional(),
    placeholder: z.string().optional(),
    default: z.unknown().optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    refKind: z.string().optional(),
  })
  .refine((f) => f.type !== "select" || (f.options && f.options.length > 0), {
    message: "select 字段必须提供 options",
  });

/** One entry in a `parameter` field value. */
export const ParameterDefSchema = z.object({
  name: ParamNameSchema,
  label: z.string().optional(),
  default: z.string().optional(),
  required: z.boolean().optional(),
});

// ---------------------------------------------------------------- manifest

export const ManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "version 必须是语义化版本，如 1.0.0"),
  description: z.string().default(""),
  /** lucide icon name, kebab-case, e.g. `link`, `notebook-pen`. */
  icon: z.string().default("puzzle"),
  apiVersion: z.string(),
  /** Entry module file for external plugins (relative to the plugin folder). Ignored for built-ins. */
  main: z.string().default("index.js"),
  provides: z
    .object({
      kinds: z.array(LocalIdSchema).default([]),
      actions: z.array(LocalIdSchema).default([]),
      views: z.array(LocalIdSchema).default([]),
    })
    .default({ kinds: [], actions: [], views: [] }),
  requires: z
    .object({
      /** Host patterns allowed for `host.network.fetch`; `"*"` = any host (D13). */
      network: z.array(z.string().min(1)).default([]),
      /** Secret names readable via `host.secrets.get` (D14). */
      secrets: z.array(z.string().min(1)).default([]),
      /** Other plugin ids whose data/actions this plugin depends on. */
      plugins: z.array(PluginIdSchema).default([]),
    })
    .default({ network: [], secrets: [], plugins: [] }),
  settings: z.array(FieldDefSchema).default([]),
});

// ---------------------------------------------------------------- resources

export const VisibilitySchema = z.enum(["private", "public"]);
export const OriginSchema = z.enum(["original", "subscribed", "copied"]);

export const ResourceSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
  group: z.string(),
  tags: z.array(z.string()),
  description: z.string(),
  body: z.record(z.string(), z.unknown()),
  visibility: VisibilitySchema,
  aiVisible: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  origin: OriginSchema,
});

/** Input for creating a resource; omitted fields get defaults. */
export const ResourceDraftSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.string().min(1),
  name: z.string().trim().min(1, "名称不能为空"),
  group: z.string().default(""),
  tags: z.array(z.string().trim().min(1)).default([]),
  description: z.string().default(""),
  body: z.record(z.string(), z.unknown()).default({}),
  visibility: VisibilitySchema.default("private"),
  aiVisible: z.boolean().default(false),
  origin: OriginSchema.default("original"),
});

/** Partial update. `expectedVersion` enables optimistic concurrency. */
export const ResourcePatchSchema = z.object({
  name: z.string().trim().min(1, "名称不能为空").optional(),
  group: z.string().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  description: z.string().optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  visibility: VisibilitySchema.optional(),
  aiVisible: z.boolean().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------- view tree (D02)

export const FormNodeSchema = z.object({
  type: z.literal("form"),
  title: z.string().optional(),
  fields: z.array(
    z.object({
      label: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      /** Render hint for the value. */
      format: z.enum(["text", "url", "code", "badge"]).optional(),
    }),
  ),
});

export const TableNodeSchema = z.object({
  type: z.literal("table"),
  title: z.string().optional(),
  columns: z.array(
    z.object({ key: z.string(), label: z.string(), align: z.enum(["start", "end"]).optional(), numeric: z.boolean().optional() }),
  ),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  emptyText: z.string().optional(),
});

export const TextNodeSchema = z.object({
  type: z.literal("text"),
  title: z.string().optional(),
  text: z.string(),
  format: z.enum(["plain", "markdown", "code"]).default("plain"),
  tone: z.enum(["default", "muted", "success", "warning", "danger"]).optional(),
});

export const LinkNodeSchema = z.object({
  type: z.literal("link"),
  href: z.string().min(1),
  text: z.string().optional(),
});

export const ViewNodeSchema = z.discriminatedUnion("type", [FormNodeSchema, TableNodeSchema, TextNodeSchema, LinkNodeSchema]);
export const ViewTreeSchema = z.union([ViewNodeSchema, z.array(ViewNodeSchema)]);

// ---------------------------------------------------------------- action output

export const ACTION_OUTPUT_TYPES = ["text", "table", "file", "link", "none"] as const;
export const ActionOutputTypeSchema = z.enum(ACTION_OUTPUT_TYPES);

export const ActionOutputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), format: z.enum(["plain", "markdown", "code"]).optional(), message: z.string().optional() }),
  z.object({
    type: z.literal("table"),
    columns: TableNodeSchema.shape.columns,
    rows: TableNodeSchema.shape.rows,
    message: z.string().optional(),
  }),
  z.object({ type: z.literal("file"), name: z.string().min(1), mime: z.string().optional(), content: z.string(), message: z.string().optional() }),
  z.object({ type: z.literal("link"), href: z.string().min(1), text: z.string().optional(), message: z.string().optional() }),
  z.object({ type: z.literal("none"), message: z.string().optional() }),
]);

/** Action input: static fields, or derived from a `parameter` field in the resource body (D07). */
export const ActionInputSpecSchema = z.union([z.array(FieldDefSchema), z.object({ fromField: ParamNameSchema })]);

// ---------------------------------------------------------------- context & notify

export const InvocationSourceSchema = z.enum(["manual", "schedule", "ai"]);

export const NotifySchema = z.object({
  tone: z.enum(["info", "success", "warning", "danger"]).default("info"),
  title: z.string().min(1),
  description: z.string().optional(),
});
