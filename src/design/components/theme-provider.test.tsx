// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme, type ThemeState } from "./theme-provider";

let api: ThemeState | null = null;
function Probe() {
  api = useTheme();
  return <span data-testid="resolved">{api.resolvedTheme}</span>;
}

const html = document.documentElement;

afterEach(() => {
  html.removeAttribute("data-theme");
  html.removeAttribute("data-density");
  api = null;
});

describe("ThemeProvider", () => {
  it("writes data-theme and data-density on <html>", () => {
    render(
      <ThemeProvider defaultTheme="dark" defaultDensity="compact">
        <Probe />
      </ThemeProvider>,
    );
    expect(html).toHaveAttribute("data-theme", "dark");
    expect(html).toHaveAttribute("data-density", "compact");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("removes data-theme for system so CSS follows prefers-color-scheme", () => {
    html.setAttribute("data-theme", "light");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(html).not.toHaveAttribute("data-theme");
    expect(html).toHaveAttribute("data-density", "comfortable");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("updates attributes on change and reports to the persistence callbacks", () => {
    const onThemeChange = vi.fn();
    const onDensityChange = vi.fn();
    render(
      <ThemeProvider onThemeChange={onThemeChange} onDensityChange={onDensityChange}>
        <Probe />
      </ThemeProvider>,
    );
    act(() => api!.setTheme("dark"));
    expect(html).toHaveAttribute("data-theme", "dark");
    expect(onThemeChange).toHaveBeenCalledWith("dark");
    act(() => api!.setDensity("compact"));
    expect(html).toHaveAttribute("data-density", "compact");
    expect(onDensityChange).toHaveBeenCalledWith("compact");
    act(() => api!.setTheme("system"));
    expect(html).not.toHaveAttribute("data-theme");
  });

  it("follows props in controlled mode", () => {
    const { rerender } = render(
      <ThemeProvider theme="light" density="comfortable">
        <Probe />
      </ThemeProvider>,
    );
    expect(html).toHaveAttribute("data-theme", "light");
    rerender(
      <ThemeProvider theme="dark" density="compact">
        <Probe />
      </ThemeProvider>,
    );
    expect(html).toHaveAttribute("data-theme", "dark");
    expect(html).toHaveAttribute("data-density", "compact");
  });

  it("never touches localStorage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => api!.setTheme("dark"));
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
