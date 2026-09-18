import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigateTestPage, reloadTestPage } from "./browser-navigation";

class Page {
  loaders = ["old", "new"];
  evaluations: (boolean | Error | { exceptionDetails: { text: string } })[] = [true];
  navigationError = "";
  calls: { method: string; params: unknown }[] = [];

  async send<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "Page.getFrameTree") {
      const loaderId = this.loaders.length > 1 ? this.loaders.shift()! : this.loaders[0]!;
      return { frameTree: { frame: { id: "main", loaderId } } } as T;
    }
    if (method === "Runtime.evaluate") {
      const value = this.evaluations.length > 1 ? this.evaluations.shift()! : this.evaluations[0]!;
      if (value instanceof Error) throw value;
      return (typeof value === "boolean" ? { result: { value } } : value) as T;
    }
    return (method === "Page.navigate" ? { errorText: this.navigationError } : {}) as T;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("document-aware browser navigation", () => {
  it("does not query the old document and waits for the new game's readiness", async () => {
    const page = new Page();
    page.loaders = ["old", "old", "new"];
    page.evaluations = [false, true];
    const pending = reloadTestPage(page);
    await vi.runAllTimersAsync();
    await pending;
    expect(page.calls[1]).toEqual({ method: "Page.reload", params: { loaderId: "old" } });
    expect(page.calls.slice(0, 4).map((call) => call.method)).toEqual([
      "Page.getFrameTree", "Page.reload", "Page.getFrameTree", "Page.getFrameTree",
    ]);
    expect(page.calls.filter((call) => call.method === "Runtime.evaluate")).toHaveLength(2);
  });

  it.each([
    "Inspected target navigated or closed", "Cannot find context with specified id", "Execution context was destroyed.",
  ])("recovers a replaced context during an explicit navigation: %s", async (message) => {
    const page = new Page();
    page.evaluations = [new Error(message), false, true];
    const pending = navigateTestPage(page, "https://game.test/", "window.korovany");
    await vi.runAllTimersAsync();
    await pending;
    expect(console.warn).toHaveBeenCalledOnce();
    expect(page.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(1);
  });

  it("does not turn renderer, application or refused-navigation errors into retries", async () => {
    const crashed = new Page();
    crashed.evaluations = [new Error("Target crashed")];
    await expect(reloadTestPage(crashed)).rejects.toThrow("Target crashed");
    const application = new Page();
    application.evaluations = [{ exceptionDetails: { text: "Application failed" } }];
    await expect(reloadTestPage(application)).rejects.toThrow("Application failed");
    const refused = new Page();
    refused.navigationError = "net::ERR_CONNECTION_REFUSED";
    await expect(navigateTestPage(refused, "https://game.test/", "true")).rejects.toThrow("ERR_CONNECTION_REFUSED");
    expect(refused.calls.some((call) => call.method === "Runtime.evaluate")).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(["uncommitted", "replaced", "unready"])("keeps a single bounded deadline when navigation is %s", async (state) => {
    const page = new Page();
    if (state === "uncommitted") page.loaders = ["old"];
    else page.evaluations = [state === "replaced" ? new Error("Inspected target navigated or closed") : false];
    const pending = expect(reloadTestPage(page, "window.korovany", 80)).rejects.toThrow("within 80ms");
    await vi.runAllTimersAsync();
    await pending;
  });
});
