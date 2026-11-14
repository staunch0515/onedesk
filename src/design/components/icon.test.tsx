// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hasIcon, Icon } from "./icon";

describe("Icon", () => {
  it("resolves kebab-case names, PascalCase names and lucide aliases", () => {
    expect(hasIcon("file-text")).toBe(true);
    expect(hasIcon("FileText")).toBe(true);
    expect(hasIcon("trash-2")).toBe(true);
    expect(hasIcon("triangle-alert")).toBe(true);
    expect(hasIcon("alert-circle")).toBe(true);
  });

  it("rejects unknown names and non-icon exports", () => {
    expect(hasIcon("definitely-not-an-icon")).toBe(false);
    expect(hasIcon("icons")).toBe(false);
    expect(hasIcon("create-lucide-icon")).toBe(false);
  });

  it("renders decorative icons hidden and labelled icons as images", () => {
    const { container, getByRole } = render(
      <>
        <Icon name="link" />
        <Icon name="info" label="说明" size="lg" />
      </>,
    );
    const [decorative] = container.querySelectorAll("svg");
    expect(decorative).toHaveAttribute("aria-hidden", "true");
    expect(decorative).toHaveClass("od-icon", "od-icon--md");
    expect(getByRole("img", { name: "说明" })).toHaveClass("od-icon--lg");
  });

  it("falls back to a placeholder for unknown names instead of throwing", () => {
    const { container } = render(<Icon name="nope-nope" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
