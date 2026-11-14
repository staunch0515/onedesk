import { OneDeskError, definePlugin, type NetworkResponse, type Resource, type ViewNodeInput } from "@onedesk/plugin-api";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
const DEFAULT_TIMEOUT_MS = 30000;
/** RFC 9110 token characters for header names. */
const HEADER_LINE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:(.*)$/;

interface StoredResponse {
  status: number;
  statusText: string;
  durationMs: number;
  headers: Record<string, string>;
  body: string;
  /** ISO time the response was received. */
  receivedAt: string;
}

const responseKey = (resourceId: string) => `response:${resourceId}`;

function str(resource: Resource | undefined, name: string): string {
  const value = resource?.body[name];
  return typeof value === "string" ? value : "";
}

/** Parses `Key: Value` lines; blank lines are skipped. `error` names the first bad line (1-based). */
function parseHeaders(text: string): { headers: Record<string, string>; error?: string } {
  const headers: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const m = HEADER_LINE.exec(line);
    if (!m) return { headers, error: `第 ${i + 1} 行请求头格式不正确，应为 Key: Value` };
    headers[m[1]!] = m[2]!.trim();
  }
  return { headers };
}

function checkUrl(url: string): string | undefined {
  if (!url) return "网址不能为空";
  if (!/^https?:\/\//i.test(url)) return "网址只支持 http、https";
  try {
    new URL(url);
  } catch {
    return "网址格式不正确";
  }
  return undefined;
}

function statusLine(r: Pick<StoredResponse, "status" | "statusText" | "durationMs">): string {
  return `${r.status} ${r.statusText}`.trim() + ` · ${r.durationMs} ms`;
}

export default definePlugin({
  activate(host) {
    host.resources.registerKind({
      id: "http-request",
      name: "HTTP 请求",
      icon: "send",
      schema: [
        {
          name: "method",
          label: "方法",
          type: "select",
          default: "GET",
          options: METHODS.map((m) => ({ value: m, label: m })),
        },
        { name: "url", label: "网址", type: "url", required: true, placeholder: "https://api.example.com/items" },
        { name: "headers", label: "请求头", type: "longtext", description: "每行一个，格式 Key: Value" },
        { name: "body", label: "请求体", type: "longtext" },
      ],
      defaultAction: "send",
      views: ["response"],
      describe(resource) {
        const method = str(resource, "method") || "GET";
        return {
          summary: `HTTP 请求「${resource.name}」：${method} ${str(resource, "url") || "未填写网址"}`,
          usage: "运行“发送”发出请求并保存响应；“响应”视图显示上次响应。",
        };
      },
      validate(body) {
        const errors: Record<string, string> = {};
        const urlError = checkUrl(typeof body.url === "string" ? body.url.trim() : "");
        if (urlError) errors.url = urlError;
        const headerError = parseHeaders(typeof body.headers === "string" ? body.headers : "").error;
        if (headerError) errors.headers = headerError;
        return errors;
      },
    });

    host.actions.register({
      id: "send",
      label: "发送",
      icon: "send",
      kinds: ["http-request"],
      output: "text",
      async run({ resource, signal }) {
        if (!resource) throw new OneDeskError("validation", "请选择一个 HTTP 请求");
        const url = str(resource, "url").trim();
        const urlError = checkUrl(url);
        if (urlError) throw new OneDeskError("validation", urlError, { fields: { url: urlError } });
        const parsed = parseHeaders(str(resource, "headers"));
        if (parsed.error) throw new OneDeskError("validation", parsed.error, { fields: { headers: parsed.error } });
        const method = (str(resource, "method") || "GET").toUpperCase();
        if (!(METHODS as readonly string[]).includes(method)) throw new OneDeskError("validation", `不支持的方法：${method}`);
        const body = str(resource, "body");
        const configured = await host.settings.get<number>("timeoutMs");
        const timeoutMs = typeof configured === "number" && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;

        let res: NetworkResponse;
        try {
          res = await host.network.fetch(url, {
            method,
            headers: parsed.headers,
            // GET and HEAD cannot carry a body.
            body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
            timeoutMs,
            signal,
          });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          throw new OneDeskError("unavailable", `请求失败：${reason}`, { hint: "检查网址、网络连接或超时设置", cause: e });
        }

        const stored: StoredResponse = {
          status: res.status,
          statusText: res.statusText,
          durationMs: res.durationMs,
          headers: res.headers,
          body: res.body,
          receivedAt: new Date().toISOString(),
        };
        await host.storage.set(responseKey(resource.id), stored);

        const ok = res.status >= 200 && res.status < 300;
        return {
          type: "text",
          text: `${statusLine(stored)}\n\n${res.body}`,
          format: "code",
          message: ok ? undefined : `服务器返回 ${res.status}`,
        };
      },
    });

    host.ui.registerView({
      id: "response",
      label: "响应",
      icon: "reply",
      async render(resource) {
        const stored = await host.storage.get<StoredResponse>(responseKey(resource.id));
        if (!stored) return { type: "text", text: "还没有响应，运行“发送”查看响应。", tone: "muted" };
        const ok = stored.status >= 200 && stored.status < 300;
        const nodes: ViewNodeInput[] = [
          {
            type: "text",
            title: "状态",
            text: `${statusLine(stored)} · ${stored.receivedAt}`,
            tone: ok ? "success" : "danger",
          },
          {
            type: "table",
            title: "响应头",
            columns: [
              { key: "name", label: "名称" },
              { key: "value", label: "值" },
            ],
            rows: Object.entries(stored.headers).map(([name, value]) => ({ name, value })),
            emptyText: "没有响应头",
          },
          stored.body
            ? { type: "text", title: "正文", text: stored.body, format: "code" }
            : { type: "text", title: "正文", text: "响应没有正文", tone: "muted" },
        ];
        return nodes;
      },
    });

    // Drop the stored response together with its resource.
    host.events.on("resource.deleted", (event) => {
      if (event.kind === "http-request") void host.storage.delete(responseKey(event.id));
    });
  },
});
