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

describe("ui.language on the configuration page (D379)", () => {
  it("is a dropdown of the languages on offer, not a text box, and keeps a configured language whose plugin is off", async () => {
    const { kernelLikeClient, renderInShell } = await import("../testing/harness");
    const { createMockClient } = await import("../protocol/mock");
    const mock = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(mock, { i18n: { languages: async () => [{ locale: "en-US", name: "English" }, { locale: "ja-JP", name: "日本語", plugin: "p" }], shell: async (locale) => ({ locale, texts: {} }) } });
    const onChange = vi.fn();
    const lang: ViewField = { name: "ui.language", label: "ui.language", kind: "text", bind: "params.ui.language" };
    renderInShell(client, <FieldControl field={lang} value="zh-CN" onChange={onChange} size="md" readOnly={false} />);
    const box = await screen.findByRole("combobox", { name: "Interface language" });
    expect(box.textContent).toBe("zh-CN");
    fireEvent.keyDown(box, { key: "Enter" });
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["English", "日本語", "zh-CN"]);
  });
});

describe("time and reference fields (D414)", () => {
  it("a time field is a text box with a UTC hint and its preset menu", () => {
    const time = { name: "at", label: "At", kind: "time", presets: [{ value: "00:00", label: "Midnight" }] } as unknown as ViewField;
    render(
      <I18nProvider locale="en-US">
        <FieldControl field={time} value="" onChange={vi.fn()} size="md" readOnly={false} />
      </I18nProvider>,
    );
    expect((screen.getByLabelText("At") as HTMLInputElement).placeholder).toBe("HH:MM (UTC)");
    expect(screen.getByRole("button", { name: /At/ })).toBeTruthy();
  });

  it("a reference field is a choice list of the options the page gives", () => {
    const ref = { name: "src", label: "Source", kind: "ref", options: [{ value: "r1", label: "Main DB" }] } as unknown as ViewField;
    render(
      <I18nProvider locale="en-US">
        <FieldControl field={ref} value="r1" onChange={vi.fn()} size="md" readOnly={false} />
      </I18nProvider>,
    );
    expect(screen.getByRole("combobox", { name: "Source" })).toBeTruthy();
  });
});

describe("a configuration parameter that holds a resource id (datasource.default)", () => {
  const id = "9199c85d0be109830eeceb0228330c43";
  const param: ViewField = { name: "datasource.default", label: "datasource.default", kind: "text", bind: "params.datasource.default" };

  it("says which resource the id is, under the box that keeps the id editable", async () => {
    const { kernelLikeClient, renderInShell } = await import("../testing/harness");
    const { createMockClient } = await import("../protocol/mock");
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, resource: { ...base.resource, get: async (rid: string) => (rid === id ? ({ id, name: "Shop DB", deleted: false } as never) : null) } };
    renderInShell(client, <FieldControl field={param} value={id} onChange={vi.fn()} size="md" readOnly={false} />);
    expect(await screen.findByText("Shop DB")).toBeTruthy();
    expect((screen.getByLabelText("datasource.default") as HTMLInputElement).value).toBe(id);
  });

  it("stays a plain box for other text, and for an id that names nothing", async () => {
    const { kernelLikeClient, renderInShell } = await import("../testing/harness");
    const { createMockClient } = await import("../protocol/mock");
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, resource: { ...base.resource, get: async () => null } };
    renderInShell(client, <FieldControl field={param} value={id} onChange={vi.fn()} size="md" readOnly={false} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("Shop DB")).toBeNull();
    expect((screen.getByLabelText("datasource.default") as HTMLInputElement).value).toBe(id);
  });
});
