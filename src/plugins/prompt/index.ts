import {
  OneDeskError,
  ParameterDefSchema,
  definePlugin,
  extractPlaceholders,
  fillPlaceholders,
  lintPlaceholders,
  type ParameterDef,
  type Resource,
} from "@onedesk/plugin-api";

function template(resource: Resource | undefined): string {
  const value = resource?.body.template;
  return typeof value === "string" ? value : "";
}

/** Parameter definitions from the body; invalid entries are dropped (validate() reports them on save). */
function parameters(body: Record<string, unknown> | undefined): ParameterDef[] {
  const raw = body?.parameters;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = ParameterDefSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Chinese error messages for a template + parameters pair; empty when fine. */
function templateProblems(tpl: string, params: ParameterDef[]): string[] {
  const problems = [...lintPlaceholders(tpl).errors];
  const defined = new Set(params.map((p) => p.name));
  const undefinedNames = extractPlaceholders(tpl).filter((n) => !defined.has(n));
  if (undefinedNames.length) problems.push(`模板中的 ${undefinedNames.map((n) => `{{${n}}}`).join("、")} 未在参数中定义`);
  return problems;
}

export default definePlugin({
  activate(host) {
    host.resources.registerKind({
      id: "prompt",
      name: "提示词",
      icon: "message-square-text",
      schema: [
        { name: "template", label: "模板", type: "longtext", required: true, placeholder: "用 {{name}} 表示参数" },
        { name: "parameters", label: "参数", type: "parameter" },
      ],
      defaultAction: "copy",
      views: ["preview"],
      describe(resource) {
        const names = parameters(resource.body).map((p) => p.name);
        return {
          summary: `提示词「${resource.name}」，${names.length ? `参数：${names.join("、")}` : "无参数"}`,
          usage: "运行“复制”，填写参数后得到完整的提示词文本并复制到剪贴板。",
        };
      },
      validate(body) {
        const errors: Record<string, string> = {};
        const tpl = typeof body.template === "string" ? body.template : "";
        const raw = body.parameters;
        if (raw !== undefined && !Array.isArray(raw)) {
          errors.parameters = "参数格式不正确";
          return errors;
        }
        const names = new Set<string>();
        for (const item of raw ?? []) {
          const parsed = ParameterDefSchema.safeParse(item);
          if (!parsed.success) {
            errors.parameters = "参数名只能包含字母、数字和下划线，且不以数字开头";
            break;
          }
          if (names.has(parsed.data.name)) {
            errors.parameters = `参数名重复：${parsed.data.name}`;
            break;
          }
          names.add(parsed.data.name);
        }
        const problems = templateProblems(tpl, parameters(body));
        if (problems.length) errors.template = problems.join("；");
        return errors;
      },
    });

    host.actions.register({
      id: "copy",
      label: "复制",
      icon: "copy",
      kinds: ["prompt"],
      input: { fromField: "parameters" },
      output: "text",
      async run({ resource }, input) {
        const tpl = template(resource);
        const params = parameters(resource?.body);
        const problems = templateProblems(tpl, params);
        if (problems.length) throw new OneDeskError("validation", problems.join("；"), { fields: { template: problems.join("；") } });

        // An unset or empty input falls back to the parameter default.
        const values: Record<string, unknown> = {};
        const missing: string[] = [];
        for (const p of params) {
          const given = input[p.name];
          const filled = given === undefined || given === null || given === "" ? p.default : String(given);
          if (filled === undefined || (filled === "" && p.required)) {
            if (p.required) missing.push(p.label || p.name);
            else values[p.name] = "";
          } else {
            values[p.name] = filled;
          }
        }
        if (missing.length) throw new OneDeskError("validation", `缺少参数：${missing.join("、")}`);

        let text: string;
        try {
          text = fillPlaceholders(tpl, values);
        } catch (e) {
          throw new OneDeskError("validation", e instanceof Error ? e.message : "参数填充失败");
        }
        try {
          await host.ui.copyText(text);
        } catch (e) {
          throw new OneDeskError("unavailable", `复制失败：${e instanceof Error ? e.message : String(e)}`);
        }
        return { type: "text", text, format: "plain", message: "已复制到剪贴板" };
      },
    });

    host.ui.registerView({
      id: "preview",
      label: "预览",
      icon: "eye",
      render(resource) {
        const tpl = template(resource);
        const params = parameters(resource.body);
        return [
          { type: "text", title: "模板", text: tpl || "模板为空", format: "plain",tone: tpl ? undefined : "muted" },
          {
            type: "table",
            title: "参数",
            columns: [
              { key: "name", label: "名称" },
              { key: "label", label: "标签" },
              { key: "default", label: "默认值" },
              { key: "required", label: "必填" },
            ],
            rows: params.map((p) => ({ name: p.name, label: p.label ?? "", default: p.default ?? "", required: p.required === true })),
            emptyText: "没有参数",
          },
        ];
      },
    });
  },
});
