// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownText, renderMarkdown } from "./markdown-text";

describe("MarkdownText", () => {
  it("shows raw HTML as text and never makes elements from it", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n**bold**');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("links only http, https and mailto; other protocols stay plain text", () => {
    const html = renderMarkdown("[a](https://e.com) [b](mailto:x@y.z) [c](javascript:alert(1)) [d](file:///etc/passwd) [e](data:text/html,x) [f](/rel) [g](#frag)");
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain('href="https://e.com"');
    expect(html).toContain('href="mailto:x@y.z"');
    expect(html).not.toContain("javascript:alert(1)\"");
    expect(html).toContain("[c](javascript:alert(1))");
  });

  it("does not load images but shows the alternative text", () => {
    const html = renderMarkdown("![a cat](https://e.com/cat.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("a cat");
  });

  it("escapes the name of a reference", () => {
    const html = renderMarkdown('[[x"><b>]]');
    expect(html).not.toContain("<b>");
  });

  it("starts headings one level down and keeps the written size class", () => {
    const html = renderMarkdown("# One\n\n###### Six");
    expect(html).toContain('<h2 class="od-markdown__h1">One</h2>');
    expect(html).toContain('<h6 class="od-markdown__h6">Six</h6>');
  });

  it("hands links and references to the caller; a broken reference cannot be opened", () => {
    const onLink = vi.fn();
    const onRef = vi.fn();
    render(<MarkdownText source={"[site](https://e.com) [[Alpha]] [[Gone]]"} onLinkClick={onLink} onReferenceClick={onRef} referenceState={(n) => (n === "Alpha" ? "ok" : "missing")} />);
    fireEvent.click(screen.getByText("site"));
    expect(onLink).toHaveBeenCalledWith("https://e.com");
    fireEvent.click(screen.getByText("Alpha"));
    expect(onRef).toHaveBeenCalledWith("Alpha");
    fireEvent.click(screen.getByText("Gone"));
    expect(onRef).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledTimes(1);
  });
});
