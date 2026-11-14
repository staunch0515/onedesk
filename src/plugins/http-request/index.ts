import { OneDeskError, definePlugin, type NetworkResponse, type Resource, type ViewNodeInput } from "@onedesk/plugin-api";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
const DEFAULT_TIMEOUT_MS = 30000;
/** RFC 9110 token characters for header names. */
/** Stored/returned bodies are cut to this many characters (approximates 1 MB). */
const MAX_BODY_CHARS = 1_000_000;
const HEADER_LINE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:(.*)$/;

interface StoredResponse {
  status: number;
  statusText: string;
  durationMs: number;
  headers: Record<string, string>;
  body: string;
  /** True when `body` was cut to MAX_BODY_CHARS. */
  truncated?: boolean;
  /** ISO time the response was received. */
  receivedAt: string;
}

const RESPONSE_PREFIX = "response:";
const responseKey = (resourceId: string) => `${RESPONSE_PREFIX}${resourceId}`;

function str(resource: Resource | undefined, name: string): string {
  const value = resource?.body[name];
  return typeof value === "string" ? value : "";
}

/** Parses `Key: Value` lines; blank lines are skipped. `error` names the first bad line (1-based). */
function parseHeaders(text: string): { headers: Record<string, string>; error?: string } {
  const merged = new Map<string, { name: string; values: string[] }>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const m = HEADER_LINE.exec(line);
    if (!m) return { headers: {}, error: `第 ${i + 1} 行请求头格式不正确，应为 Key: Value` };
    const value = m[2]!.trim();
    if (!/^[\t\x20-\x7E]*$/.test(value)) return { headers: {}, error: `第 ${i + 1} 行请求头的值含有不支持的字符，只能用可见 ASCII 字符` };
    // Header names are case-insensitive: merge repeats, keep the first spelling.
    const key = m[1]!.toLowerCase();
    const entry = merged.get(key);
    if (entry) entry.values.push(value);
    else merged.set(key, { name: m[1]!, values: [value] });
  }
  const headers: Record<string, string> = {};
  for (const { name, values } of merged.values()) headers[name] = values.join(", ");
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
  async activate(host) {
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
        const requestBody = str(resource, "body");
        const configured = await host.settings.get<number>("timeoutMs");
        const timeoutMs = typeof configured === "number" && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;

        let res: NetworkResponse;
        try {
          res = await host.network.fetch(url, {
            method,
            headers: parsed.headers,
            // GET and HEAD cannot carry a body.
            body: requestBody && method !== "GET" && method !== "HEAD" ? requestBody : undefined,
            timeoutMs,
            signal,
          });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          throw new OneDeskError("unavailable", `请求失败：${reason}`, { hint: "检查网址、网络连接或超时设置", cause: e });
        }

        const truncated = res.body.length > MAX_BODY_CHARS;
        const body = truncated ? res.body.slice(0, MAX_BODY_CHARS) : res.body;
        const stored: StoredResponse = {
          status: res.status,
          statusText: res.statusText,
          durationMs: res.durationMs,
          headers: res.headers,
          body,
          truncated,
          receivedAt: new Date().toISOString(),
        };
        // The resource may have been deleted while the request was in flight: do not leave an orphan.
        if (await host.resources.get(resource.id)) await host.storage.set(responseKey(resource.id), stored);

        const ok = res.status >= 200 && res.status < 300;
        return {
          type: "text",
          text: `${statusLine(stored)}\n\n${body}`,
          format: "code",
          message: [ok ? "" : `服务器返回 ${res.status}`, truncated ? "正文过大，已截断" : ""].filter(Boolean).join("；") || undefined,
        };
      },
    });

    host.ui.registerView({
      id: "response",
      label: "响应",
      icon: "reply",
      async render(resource) {
        const stored = await host.storage.get<StoredResponse>(responseKey(resource.id));
        if (!stored) return { type: "text", text: "运行“发送”查看响应", tone: "muted" };
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
          ...(stored.truncated ? [{ type: "text" as const, text: "正文过大，已截断", tone: "warning" as const }] : []),
          stored.body
            ? { type: "text", title: "正文", text: stored.body, format: "code" }
            : { type: "text", title: "正文", text: "响应没有正文", tone: "muted" },
        ];
        return nodes;
      },
    });

    // Drop the stored response together with its resource.
    host.events.on("resource.deleted", (event) => {
      if (event.kind === "http-request") host.storage.delete(responseKey(event.id)).catch(() => undefined);
    });

    // Remove responses whose resource no longer exists (e.g. deleted while the plugin was disabled).
    try {
      for (const key of await host.storage.keys()) {
        if (!key.startsWith(RESPONSE_PREFIX)) continue;
        if (!(await host.resources.get(key.slice(RESPONSE_PREFIX.length)))) await host.storage.delete(key);
      }
    } catch {
      // Cleanup is best effort; never block activation.
    }
  },
});
