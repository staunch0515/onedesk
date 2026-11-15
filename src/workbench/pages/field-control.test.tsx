// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { ViewField } from "../protocol";
import { FieldControl } from "./view-page";

const field: ViewField = { name: "token", label: "Token", kind: "secret", bind: "body.token" };
const show = (secret: { saved: boolean } | undefined, value = "", onChange = vi.fn()) =>
  render(
    <I18nProvider locale="en-US">
      <FieldControl field={field} value={value} onChange={onChange} size="md" readOnly={false} secret={secret} />
    </I18nProvider>,
  );

describe("secret form field", () => {
  it("is a write-only password box that only says a value is saved", () => {
    const onChange = vi.fn();
    show({ saved: true }, "", onChange);
    const box = screen.getByLabelText("Token") as HTMLInputElement;
    expect(box.type).toBe("password");
    expect(box.value).toBe("");
    expect(box.placeholder).toBe("Saved — type to replace");
    fireEvent.change(box, { target: { value: "new" } });
    expect(onChange).toHaveBeenCalledWith("new");
  });

  it("says nothing is stored yet when there is no value", () => {
    show({ saved: false });
    expect((screen.getByLabelText("Token") as HTMLInputElement).placeholder).toBe("Not set");
  });

  it("stays the old read-only box on demo pages", () => {
    show(undefined);
    expect((screen.getByLabelText("Token") as HTMLInputElement).readOnly).toBe(true);
  });
});
