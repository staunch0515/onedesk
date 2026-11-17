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
    expect(html).not.toContain("javascript");
    expect(html).toContain(" c ");
  });

  it("refuses every disguise of a forbidden protocol (case, entities, tabs, autolinks, reference style)", () => {
    const cases = [
      "[a](JAVASCRIPT:alert(1))",
      "[a](&#106;avascript:alert(1))",
      "[a](&#x6A;avascript:alert(1))",
      "[a](java&Tab;script:alert(1))",
      "[a](java\tscript:alert(1))",
      "[a](<javascript:alert(1)>)",
      "<javascript:alert(1)>",
      "<JavaScript:alert(1)>",
      "[a][r]\n\n[r]: javascript:alert(1)",
      "[a][r]\n\n[r]: &#106;avascript:alert(1)",
      "[a](vbscript:x) [b](data:text/html;base64,AAAA) [c](file:///etc/passwd) [d](//evil.example/x) [e](ftp://x)",
      "[a](https:/no-host)",
    ];
    for (const source of cases) {
      const html = renderMarkdown(source);
      expect(html, source).not.toMatch(/<a /);
      expect(html, source).not.toMatch(/href=/i);
    }
  });

  it("does not request images in any form", () => {
    for (const source of ["![a](http://e.com/x.png)", "![a][r]\n\n[r]: http://e.com/x.png", "![a](javascript:alert(1))", "<img src=x onerror=alert(1)>"]) {
      const html = renderMarkdown(source);
      expect(html, source).not.toMatch(/<img/i);
      expect(html, source).not.toMatch(/<[^>]*\ssrc=/i);
    }
  });

  it("escapes block and inline HTML, comments and attributes", () => {
    const html = renderMarkdown('<div onclick="x()">hi</div>\n\ntext <b onmouseover="x()">b</b> <!-- c --> <iframe src="//e"></iframe>\n\n<style>*{}</style>');
    expect(html).not.toMatch(/<(div|b|iframe|style)[ >]/i);
    expect(html).not.toContain("<!--");
    expect(html).toContain("&lt;div");
  });

  it("keeps a link that is allowed once decoded, with the decoded address", () => {
    expect(renderMarkdown("[a](&#104;ttps://e.com/a?b=1&amp;c=2)")).toContain('href="https://e.com/a?b=1&amp;c=2"');
    expect(renderMarkdown("<https://e.com/x>")).toContain('href="https://e.com/x"');
    expect(renderMarkdown("[mail](mailto:a@b.c)")).toContain('href="mailto:a@b.c"');
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
