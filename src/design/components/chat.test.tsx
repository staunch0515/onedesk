// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat, ChatInput, ChatTurn } from "./chat";

describe("Chat (D479)", () => {
  it("shows who said each turn, its caption and buttons", () => {
    render(
      <Chat label="Conversation" turns={1}>
        <ChatTurn role="assistant" who="AI" note="m · 1 / 2" actions={<button>Apply</button>}>
          Hello
        </ChatTurn>
      </Chat>,
    );
    const turn = screen.getByRole("article", { name: "AI" });
    expect(turn.textContent).toContain("Hello");
    expect(turn.textContent).toContain("m · 1 / 2");
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  });
  it("Enter sends, Shift+Enter and an input method composing do not; a disabled box does not send", () => {
    const onSend = vi.fn();
    const { rerender } = render(<ChatInput label="Message" value="hi" onChange={() => undefined} onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    rerender(<ChatInput label="Message" value="hi" disabled onChange={() => undefined} onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
