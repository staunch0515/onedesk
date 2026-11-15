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
    view("zh-CN", { run: { code: "weird", message: "  " } });
    expect(screen.getByText("运行失败（原因：weird）。")).toBeTruthy();
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
    const { unmount } = view("zh-CN", { error: new KernelError("denied", { reason: "cancelled" }) });
    expect(screen.getByText("调用已被取消。")).toBeTruthy();
    unmount();
    view("zh-CN", { error: new KernelError("denied", { reason: "timeout" }) });
    expect(screen.getByText("调用时间太长。")).toBeTruthy();
  });
});
