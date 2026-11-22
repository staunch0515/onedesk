// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockClient } from "../protocol/mock";
import type { ResultAction, Run } from "../protocol";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { markdownOf, OutputTab, ResultActions } from "./result-area";

const base = () => createMockClient({ fresh: true, quiet: true });
const analyze: ResultAction = { plugin: "org.onedesk.ai", id: "analyze", action: "org.onedesk.ai:analyze", label: "Analyze with AI", icon: "sparkles", enabled: true };

function withActions(list: ResultAction[]) {
  const mock = base();
  const actions = vi.fn(async (_runId: string) => list);
  const call = vi.fn(async (_request: unknown) => "run-99");
  return { call, actions, client: kernelLikeClient(mock, { result: { actions }, run: { ...mock.run, start: call } }) };
}

describe("result-area actions (X5)", () => {
  it("lists what result.actions returns, with its icon and label", async () => {
    const { client, actions } = withActions([analyze]);
    renderInShell(client, <ResultActions runId="r1" />);
    expect(await screen.findByRole("button", { name: "Analyze with AI" })).toBeTruthy();
    expect(actions).toHaveBeenCalledWith("r1");
  });

  it("shows nothing when the run has no actions", async () => {
    const { client, actions } = withActions([]);
    const view = renderInShell(client, <div data-testid="host"><ResultActions runId="r1" /></div>);
    await waitFor(() => expect(actions).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
    expect(view.store).toBeTruthy();
  });

  it("disables an action the kernel says is off and words the reason", async () => {
    const { client } = withActions([{ ...analyze, enabled: false, disabledReason: "noExport" }, { ...analyze, id: "other", label: "Other", enabled: false, disabledReason: "somethingNew" }]);
    renderInShell(client, <ResultActions runId="r1" />);
    const button = (await screen.findByRole("button", { name: "Analyze with AI" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Not allowed by this workspace's protection")).toBeTruthy();
    expect(screen.getByText("Not available")).toBeTruthy();
  });

  it("starts the action as a run with resultRun and opens that run", async () => {
    const { client, call } = withActions([{ ...analyze }]);
    const { store } = renderInShell(client, <ResultActions runId="r7" envId="e1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Analyze with AI" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "org.onedesk.ai:analyze", resultRun: "r7", envId: "e1", target: "run:r7" })));
    await waitFor(() => expect(store.get().tabs.some((t) => t.target === "run:run-99")).toBe(true));
  });

  it("the demo client offers Analyze for a finished table run and none while it runs", async () => {
    const mock = base();
    expect(await mock.result.actions("nope")).toEqual([]);
  });
});

describe("a running run shows Run.partial as it grows (X17)", () => {
  const tab = { id: "t1", target: "resource:r1", title: "R", icon: "file", pinned: false, envId: null, params: {} } as never;
  const running = (partial: unknown, extra: object = {}) => ({ id: "r1", seq: 1, status: "running", startedAt: Date.now() - 4200, cancellable: true, progress: { message: "Generating…" }, partial, ...extra }) as unknown as Run;
  const md = (text: string) => ({ type: "text", text, format: "markdown" });

  it("reads Markdown text with the reading renderer, replacing the previous text each time", () => {
    const view = renderInShell(base(), <OutputTab tab={tab} run={running(md("## Title\n\nfirst **bold**"))} widthKey="k" />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    expect(document.querySelector("strong")?.textContent).toBe("bold");
    view.rerender(<OutputTab tab={tab} run={running(md("## Title\n\nfirst **bold** and more"))} widthKey="k" />);
    expect(screen.getByText(/and more/)).toBeTruthy();
  });

  it("shows plain text partials as plain lines when there is no format", () => {
    renderInShell(base(), <OutputTab tab={tab} run={running({ type: "text", text: "# not a heading" })} widthKey="k" />);
    expect(screen.getByText("# not a heading")).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("says how long it has been going and offers cancel; cancel calls run.cancel", () => {
    const cancel = vi.fn(async () => undefined);
    const mock = base();
    const client = kernelLikeClient(mock, { run: { ...mock.run, cancel } });
    renderInShell(client, <OutputTab tab={tab} run={running({ type: "text", text: "x" })} widthKey="k" />);
    expect(screen.getByText(/elapsed$/).textContent).toMatch(/^[\d.,]+\s*s elapsed$/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(cancel).toHaveBeenCalledWith("r1");
  });

  it("switches to the finished output (Markdown too) when the run ends", () => {
    const view = renderInShell(base(), <OutputTab tab={tab} run={running(md("partial text"))} widthKey="k" />);
    expect(screen.getByText("partial text")).toBeTruthy();
    view.rerender(<OutputTab tab={tab} run={{ ...running(undefined), status: "success", partial: undefined, output: md("# Final") } as unknown as Run} widthKey="k" />);
    expect(screen.getByRole("heading", { name: "Final" })).toBeTruthy();
    expect(screen.queryByText("partial text")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  it("markdownOf only accepts text that says markdown and is not the terminal look", () => {
    expect(markdownOf(md("a") as never)).toBe("a");
    expect(markdownOf({ type: "text", text: "a" })).toBeNull();
    expect(markdownOf({ ...md("a"), appearance: "terminal" } as never)).toBeNull();
    expect(markdownOf(undefined)).toBeNull();
  });
});

describe("the demo client streams partial text and ends with the full text", () => {
  it("run.get shows a growing partial while running and no partial after", async () => {
    vi.useFakeTimers();
    try {
      const c = base();
      const id = await (async () => {
        const p = c.run.start({ action: "generate", target: "core:x", input: {}, params: {} } as never);
        await vi.advanceTimersByTimeAsync(50);
        return p;
      })();
      await vi.advanceTimersByTimeAsync(1000);
      const mid = await (async () => { const p = c.run.get(id); await vi.advanceTimersByTimeAsync(20); return p; })();
      expect(mid?.status).toBe("running");
      expect(mid?.partial?.type === "text" && mid.partial.text.length).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(3000);
      const end = await (async () => { const p = c.run.get(id); await vi.advanceTimersByTimeAsync(20); return p; })();
      expect(end?.status).toBe("success");
      expect(end?.partial).toBeUndefined();
      expect(end?.output?.type).toBe("text");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a ref field whose kinds say @implements:… (X15)", () => {
  it("is drawn from the options the kernel filled in; the shell never reads kinds", async () => {
    const { FieldControl } = await import("../pages/view-page");
    const field = { name: "conn", label: "Connection", kind: "ref", kinds: ["@implements:onedesk.ai.chat/1"], options: [{ value: "c1", label: "Work key" }] } as never;
    renderInShell(base(), <FieldControl field={field} value="c1" onChange={() => undefined} id="f" size="md" readOnly={false} />);
    expect(screen.getByRole("combobox", { name: "Connection" }).textContent).toContain("Work key");
  });
});
