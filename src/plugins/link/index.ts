import { OneDeskError, definePlugin, type Resource, type ViewNodeInput } from "@onedesk/plugin-api";

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function bodyUrl(resource: Resource | undefined): string {
  const url = resource?.body.url;
  return typeof url === "string" ? url.trim() : "";
}

/** Returns an error message, or undefined when the URL is usable. */
function checkUrl(url: string): string | undefined {
  if (!url) return "网址不能为空";
  if (!SAFE_URL.test(url)) return "网址只支持 http、https、mailto";
  try {
    new URL(url);
  } catch {
    return "网址格式不正确";
  }
  return undefined;
}

export default definePlugin({
  activate(host) {
    host.resources.registerKind({
      id: "link",
      name: "网址",
      icon: "link",
      schema: [
        { name: "url", label: "网址", type: "url", required: true, placeholder: "https://example.com" },
        { name: "profile", label: "浏览器配置文件", type: "text", description: "暂不生效" },
      ],
      defaultAction: "open",
      views: ["details"],
      describe(resource) {
        const url = bodyUrl(resource);
        return {
          summary: `网址「${resource.name}」：${url || "未填写"}`,
          usage: "运行“打开”会在系统浏览器中打开该网址。",
        };
      },
      validate(body) {
        const error = checkUrl(typeof body.url === "string" ? body.url.trim() : "");
        const errors: Record<string, string> = {};
        if (error) errors.url = error;
        return errors;
      },
    });

    host.actions.register({
      id: "open",
      label: "打开",
      icon: "external-link",
      kinds: ["link"],
      output: "none",
      async run({ resource }) {
        const url = bodyUrl(resource);
        const error = checkUrl(url);
        if (error) throw new OneDeskError("validation", error, { fields: { url: error } });
        const profile = typeof resource?.body.profile === "string" && resource.body.profile ? resource.body.profile : undefined;
        await host.ui.openExternal(url, profile ? { profile } : undefined);
        return { type: "none", message: "已在浏览器中打开" };
      },
    });

    host.ui.registerView({
      id: "details",
      label: "详情",
      icon: "link",
      render(resource) {
        const url = bodyUrl(resource);
        const profile = typeof resource.body.profile === "string" ? resource.body.profile : "";
        const nodes: ViewNodeInput[] = [
          {
            type: "form",
            fields: [
              { label: "网址", value: url, format: "url" },
              { label: "浏览器配置文件", value: profile || "未设置", format: "text" },
            ],
          },
        ];
        // The link node only accepts http/https/mailto; an invalid URL is shown as plain text above.
        if (!checkUrl(url)) nodes.push({ type: "link", href: url, text: "打开网址" });
        return nodes;
      },
    });
  },
});
