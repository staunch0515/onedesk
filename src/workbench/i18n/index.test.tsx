// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KernelError } from "../protocol/errors";
import { I18nProvider, useI18n } from ".";

function Show({ run, error }: { run?: { code: string; message: string }; error?: unknown }) {
  const { runError, error: words } = useI18n();
  return <p>{run ? runError(run) : words(error)}</p>;
}
const view = (locale: "en-US" | "zh-CN", props: Parameters<typeof Show>[0]) =>
  render(
    <I18nProvider locale={locale}>
      <Show {...props} />
    </I18nProvider>,
  );

describe("run failures and refusals in words", () => {
  it("words the kernel's codes, passes through a message for unknown ones, and is never blank", () => {
    view("en-US", { run: { code: "invalidInput", message: "" } });
    expect(screen.getByText(/not valid for this action/)).toBeTruthy();
  });

  it("falls back to a generic sentence with the code when nothing else is known", () => {
    view("en-US", { run: { code: "weird", message: "  " } });
    expect(screen.getByText("The run failed (reason: weird).")).toBeTruthy();
  });

  it("keeps the run's own message for a code it has no words for", () => {
    view("en-US", { run: { code: "weird", message: "custom message" } });
    expect(screen.getByText("custom message")).toBeTruthy();
  });

  it("words a save on a disabled plugin's resource (denied / pluginDisabled), and cancelled / timeout refusals", () => {
    view("en-US", { error: new KernelError("denied", { reason: "pluginDisabled" }) });
    expect(screen.getByText(/disabled/)).toBeTruthy();
  });

  it("words the host-call refusals for cancel and timeout", () => {
    const { unmount } = view("en-US", { error: new KernelError("denied", { reason: "cancelled" }) });
    expect(screen.getByText(/cancelled/i)).toBeTruthy();
    unmount();
    view("en-US", { error: new KernelError("denied", { reason: "timeout" }) });
    expect(screen.getByText(/too long|time/i)).toBeTruthy();
  });

  it("words a ProtocolError that arrived as plain data (an install preview's problem)", () => {
    view("en-US", { error: { code: "invalid", params: { reason: "schema" } } });
    expect(screen.queryByText("[object Object]")).toBeNull();
    expect(screen.getByText("The manifest does not match the format")).toBeTruthy();
  });
});

describe("kernel words come from the language's overlay like any other text (D387)", () => {
  it("uses the overlay's words for kernel ids, errors, operations and permissions, and English for what it lacks", () => {
    const texts = { "kernel.label.node.rename": "名前を変更", "kernel.error.denied": "拒否されました", "kernel.audit.resource.create": "作成", "kernel.permission.network": "ネットワーク" };
    let words!: ReturnType<typeof useI18n>;
    function Grab() {
      words = useI18n();
      return null;
    }
    render(
      <I18nProvider locale="ja-JP" texts={texts}>
        <Grab />
      </I18nProvider>,
    );
    expect(words.tx("node.rename")).toBe("名前を変更");
    expect(words.tx("node.open")).toBe("Open");
    expect(words.error(new KernelError("denied", {}))).toBe("拒否されました");
    expect(words.operation("resource.create")).toBe("作成");
    expect(words.permission("network")).toBe("ネットワーク");
    expect(words.permission("files")).toBe("Files in granted folders");
    expect(words.operation("unknown.op")).toBe("unknown.op");
  });
});
