import { definePlugin, type Resource } from "@onedesk/plugin-api";

function content(resource: Resource): string {
  const value = resource.body.content;
  return typeof value === "string" ? value : "";
}

export default definePlugin({
  activate(host) {
    host.resources.registerKind({
      id: "note",
      name: "笔记",
      icon: "notebook-pen",
      schema: [{ name: "content", label: "内容", type: "longtext", description: "支持 Markdown" }],
      views: ["markdown"],
      describe(resource) {
        const text = content(resource).trim();
        const firstLine = text.split("\n", 1)[0] ?? "";
        return {
          summary: text ? `笔记「${resource.name}」，共 ${text.length} 字：${firstLine.slice(0, 60)}` : `笔记「${resource.name}」，内容为空`,
          usage: "笔记正文是 Markdown 文本，可直接阅读或引用。",
        };
      },
    });

    host.ui.registerView({
      id: "markdown",
      label: "阅读",
      icon: "book-open",
      render(resource) {
        const text = content(resource);
        if (!text.trim()) return { type: "text", text: "点击编辑开始记录。", tone: "muted" };
        return { type: "text", text, format: "markdown" };
      },
    });
  },
});
