// @vitest-environment jsdom
import "../design/testing/jsdom-setup";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ViewTreeSchema, type ViewNode, type ViewTree as Tree } from "../plugin-api";
import { codeMarkdown, ViewTree } from "./view-tree";

/** Same path as the kernel: plugin output → zod (defaults applied) → shell renderer. */
function nodes(tree: Tree): ViewNode[] {
  const parsed = ViewTreeSchema.parse(tree);
  return Array.isArray(parsed) ? parsed : [parsed];
}

describe("视图树渲染器", () => {
  it("form：只读字段列表，布尔与空值有明确显示", () => {
    render(
      <ViewTree
        onOpenLink={() => {}}
        nodes={nodes({
          type: "form",
          title: "详情",
          fields: [
            { label: "网址", value: "https://a.com", format: "url" },
            { label: "状态", value: "正常", format: "badge" },
            { label: "启用", value: true },
            { label: "备注", value: null },
            { label: "次数", value: 3 },
          ],
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "详情" })).toBeInTheDocument();
    expect(screen.getByText("https://a.com")).toBeInTheDocument();
    expect(screen.getByText("正常")).toBeInTheDocument();
    expect(screen.getByText("是")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("table：列、行、数字列、空表格文字", () => {
    const { container } = render(
      <ViewTree
        onOpenLink={() => {}}
        nodes={nodes([
          {
            type: "table",
            title: "响应头",
            columns: [
              { key: "name", label: "名字" },
              { key: "size", label: "大小", numeric: true },
            ],
            rows: [{ name: "a", size: 10 }, { name: "b", size: null }],
          },
          { type: "table", columns: [{ key: "x", label: "X" }], rows: [], emptyText: "没有数据" },
        ])}
      />,
    );
    const table = screen.getByRole("table", { name: "响应头" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("10")).toHaveClass("od-tabular");
    expect(screen.getByText("没有数据")).toBeInTheDocument();
    expect(container.querySelectorAll("table")).toHaveLength(2);
  });

  it("text：plain 保留换行，markdown 渲染，code 进代码块，tone 生效", () => {
    const { container } = render(
      <ViewTree
        onOpenLink={() => {}}
        nodes={nodes([
          { type: "text", text: "第一行\n第二行" },
          { type: "text", text: "# 标题\n\n**粗体**", format: "markdown" },
          { type: "text", title: "正文", text: "const a = 1;", format: "code" },
          { type: "text", text: "警告", tone: "warning" },
        ])}
      />,
    );
    expect(screen.getByText("第一行")).toBeInTheDocument();
    expect(screen.getByText("第二行")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(container.querySelector("strong")?.textContent).toBe("粗体");
    expect(container.querySelector("pre code")?.textContent).toContain("const a = 1;");
    expect(screen.getByText("警告")).toHaveClass("od-text--warning");
  });

  it("link：点击经宿主打开，不直接导航", () => {
    const open = vi.fn();
    render(<ViewTree onOpenLink={open} nodes={nodes({ type: "link", href: "https://example.com", text: "打开网址" })} />);
    fireEvent.click(screen.getByRole("button", { name: "打开网址" }));
    expect(open).toHaveBeenCalledWith("https://example.com");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("空视图显示一句话", () => {
    render(<ViewTree onOpenLink={() => {}} nodes={[]} />);
    expect(screen.getByText("这个视图没有内容。")).toBeInTheDocument();
  });

  it("代码块的围栏比正文中最长的反引号还长", () => {
    expect(codeMarkdown("a ``` b").startsWith("````\n")).toBe(true);
    expect(codeMarkdown("x").startsWith("```\n")).toBe(true);
  });
});
