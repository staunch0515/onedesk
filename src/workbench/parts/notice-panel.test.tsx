// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useToast } from "../../design";
import { createMockClient } from "../protocol/mock";
import { addNotice, markAllRead, NOTICE_LIMIT, unreadCount } from "../state/notices";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { NoticePanel } from "./notice-panel";
import { StatusBarPart } from "./status-bar";
import { useUi } from "../state/context";

let show!: ReturnType<typeof useToast>["toast"];
const Grab = () => {
  show = useToast().toast;
  return null;
};
const Panel = () => (useUi((s) => s.noticesOpen) ? <NoticePanel /> : null);

function setup() {
  const client = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
  const { store } = renderInShell(
    client,
    <>
      <Grab />
      <StatusBarPart settings={{ locale: "en-US", theme: "light", density: "comfortable" }} onSetting={() => undefined} resolvedTheme="light" />
      <Panel />
    </>,
  );
  return { store };
}

describe("notice list in the status bar (D376)", () => {
  it("counts what appeared, opens a list with level and text, and clears", async () => {
    const { store } = setup();
    await act(async () => void show({ tone: "danger", title: "Could not save", description: "disk full" }));
    await act(async () => void show({ tone: "success", title: "Saved" }));
    const bell = screen.getByRole("button", { name: "Notices (2 unread)" });
    expect(within(bell).getByText("2")).toBeTruthy();
    expect(store.get().notices.map((n) => n.text)).toEqual(["Saved", "Could not save"]);

    await act(async () => void fireEvent.click(bell));
    const panel = screen.getByRole("region", { name: "Notices" });
    expect(within(panel).getByText("Could not save")).toBeTruthy();
    expect(within(panel).getByText("disk full")).toBeTruthy();
    expect(within(panel).getByRole("img", { name: "Error" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notices" })).toBeTruthy(); // nothing unread any more

    await act(async () => void fireEvent.click(within(panel).getByRole("button", { name: "Clear" })));
    expect(within(screen.getByRole("region", { name: "Notices" })).getByText("Nothing has been shown in this session.")).toBeTruthy();
    expect(store.get().notices).toEqual([]);
  });

  it("a notice that arrives while the list is open is already read", async () => {
    const { store } = setup();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Notices" })));
    await act(async () => void show({ tone: "warning", title: "Heads up" }));
    expect(unreadCount(store.get().notices)).toBe(0);
    expect(within(screen.getByRole("region", { name: "Notices" })).getByText("Heads up")).toBeTruthy();
  });
});

describe("notice helpers", () => {
  it("newest first, capped, read marking", () => {
    let list = addNotice([], { id: 1, at: 1, tone: "neutral", text: "a" });
    list = addNotice(list, { id: 2, at: 2, tone: "neutral", text: "b" });
    expect(list.map((n) => n.text)).toEqual(["b", "a"]);
    expect(unreadCount(markAllRead(list))).toBe(0);
    let many = list;
    for (let i = 0; i < NOTICE_LIMIT + 5; i++) many = addNotice(many, { id: 10 + i, at: i, tone: "info", text: String(i) });
    expect(many).toHaveLength(NOTICE_LIMIT);
  });
});
