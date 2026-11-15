// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusItem } from "./workbench";

describe("StatusItem", () => {
  it("names an icon-only button by its tooltip text", () => {
    render(<StatusItem icon="sun" title="Theme" onClick={() => undefined} />);
    expect(screen.getByRole("button", { name: "Theme" })).toBeTruthy();
  });

  it("keeps the visible text as the name when there is one, and lets callers override", () => {
    render(
      <>
        <StatusItem icon="box" title="Hint" onClick={() => undefined}>
          Workspace
        </StatusItem>
        <StatusItem icon="languages" title="Tip" aria-label="Language">
          English
        </StatusItem>
      </>,
    );
    expect(screen.getByRole("button", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Language" })).toBeTruthy();
  });
});
