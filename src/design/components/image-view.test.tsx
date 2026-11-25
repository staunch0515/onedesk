// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageDrop, ImageView } from "./image-view";

describe("ImageView and ImageDrop (D484 §16)", () => {
  it("shows the image at its width and large on click; a placeholder while it is read or when it cannot be", () => {
    const { container, unmount } = render(<ImageView src="blob:x" alt="Circuit" width="small" openLabel="Show large" closeLabel="Close" />);
    expect(container.querySelector(".od-image--small img")?.getAttribute("alt")).toBe("Circuit");
    fireEvent.click(screen.getByRole("button", { name: "Show large: Circuit" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    unmount();
    render(<ImageView alt="Circuit" failed="Cannot show it" openLabel="Show large" closeLabel="Close" />);
    expect(screen.getByRole("img", { name: "Circuit" }).textContent).toBe("Cannot show it");
  });
  it("takes dropped and pasted images only; offers choose and remove", () => {
    const onFiles = vi.fn();
    const onRemove = vi.fn();
    render(<ImageDrop label="Image" hint="Drop here" chooseLabel="Choose" removeLabel="Remove" onFiles={onFiles} onChoose={() => undefined} onRemove={onRemove} />);
    const area = screen.getByRole("group", { name: "Image" });
    const png = new File(["x"], "a.png", { type: "image/png" });
    const txt = new File(["x"], "a.txt", { type: "text/plain" });
    fireEvent.drop(area, { dataTransfer: { files: [txt, png] } });
    expect(onFiles).toHaveBeenCalledWith([png]);
    fireEvent.paste(area, { clipboardData: { files: [txt] } });
    expect(onFiles).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalled();
    expect(screen.getByText("Drop here")).toBeTruthy();
  });
});
