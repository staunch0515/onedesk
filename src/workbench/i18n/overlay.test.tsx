// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLanguage } from "../app";
import { ProtocolProvider, type LanguageInfo, type ProtocolClient } from "../protocol";
import { StatusBarPart } from "../parts/status-bar";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { createMockClient } from "../protocol/mock";
import { buildI18n } from ".";

describe("shell text = built-in English + the chosen language's overlay (D379)", () => {
  it("uses the overlay and falls back to English for a key it lacks", () => {
    const i18n = buildI18n("ja-JP", { "common.close": "閉じる" });
    expect(i18n.t("common.close")).toBe("閉じる");
    expect(i18n.t("common.cancel")).toBe("Cancel");
  });

  it("falls back to English for an empty or non-string value, never to the key name", () => {
    const i18n = buildI18n("ja-JP", { "common.close": "", "common.cancel": 5 as unknown as string });
    expect(i18n.t("common.close")).toBe("Close");
    expect(i18n.t("common.cancel")).toBe("Cancel");
  });

  it("is plain English without overlay, and fills {placeholders}", () => {
    const i18n = buildI18n("en-US");
    expect(i18n.t("startup.failed", { reason: "boom" })).toContain("boom");
  });

  it("formats dates and numbers for a language the runtime does not know as English", () => {
    expect(buildI18n("xx-ZZZZZZZZ").number(1234.5)).toBe("1,234.5");
  });
});

function fakeClient(languages: () => Promise<LanguageInfo[]>, shell: ProtocolClient["i18n"] extends infer T ? (T extends { shell: infer S } ? S : never) : never) {
  const handlers = new Set<() => void>();
  const client = {
    i18n: { languages, shell },
    events: { subscribe: (topic: string, h: () => void) => (topic === "languages" ? (handlers.add(h), () => handlers.delete(h)) : () => undefined) },
  } as unknown as ProtocolClient;
  return { client, emit: () => handlers.forEach((h) => h()) };
}

function Probe({ configured }: { configured: string }) {
  const { locale, texts, languages } = useLanguage(configured);
  return (
    <p>
      {locale}|{texts ? Object.keys(texts).length : "none"}|{languages.map((l) => l.locale).join(",")}
    </p>
  );
}

describe("language choice follows the languages on offer", () => {
  it("returns to English when the chosen language disappears, and picks it up again", async () => {
    let list: LanguageInfo[] = [{ locale: "en-US", name: "English" }, { locale: "ja-JP", name: "日本語", plugin: "p.ja" }];
    const { client, emit } = fakeClient(async () => list, async (locale) => ({ locale, texts: { "common.close": "閉じる" } }));
    render(
      <ProtocolProvider client={client}>
        <Probe configured="ja-JP" />
      </ProtocolProvider>,
    );
    await waitFor(() => expect(screen.getByText("ja-JP|1|en-US,ja-JP")).toBeTruthy());
    list = [{ locale: "en-US", name: "English" }];
    emit();
    await waitFor(() => expect(screen.getByText("en-US|none|en-US")).toBeTruthy());
    list = [{ locale: "en-US", name: "English" }, { locale: "ja-JP", name: "日本語", plugin: "p.ja" }];
    emit();
    await waitFor(() => expect(screen.getByText("ja-JP|1|en-US,ja-JP")).toBeTruthy());
  });

  it("is English when the texts cannot be read", async () => {
    const { client } = fakeClient(async () => [{ locale: "en-US", name: "English" }, { locale: "ja-JP", name: "日本語" }], async () => Promise.reject(new Error("x")));
    render(
      <ProtocolProvider client={client}>
        <Probe configured="ja-JP" />
      </ProtocolProvider>,
    );
    await waitFor(() => expect(screen.getByText(/^ja-JP\|none/)).toBeTruthy());
  });
});

describe("the language picker", () => {
  it("lists i18n.languages and writes ui.language when one is chosen", async () => {
    const onSetting = vi.fn();
    const client = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    renderInShell(
      client,
      <StatusBarPart
        languages={[{ locale: "en-US", name: "English" }, { locale: "ja-JP", name: "日本語" }]}
        settings={{ locale: "en-US", theme: "light", density: "comfortable" }}
        onSetting={onSetting}
        resolvedTheme="light"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Language" });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    fireEvent.click(await screen.findByText("日本語"));
    expect(onSetting).toHaveBeenCalledWith("ui.language", "ja-JP");
  });
});
