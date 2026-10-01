import { describe, expect, it } from "vitest";
import { planDirectoryTabOpen, type Tab, type TerminalTab } from "./useTabs";

function terminal(id: number, spaceId: string, cwd?: string): TerminalTab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    cwd,
    paneTree: { kind: "leaf", id: id + 1000, cwd },
    activeLeafId: id + 1000,
  };
}

describe("planDirectoryTabOpen", () => {
  it("creates a cold terminal tab in the requested space", () => {
    let next = 7;
    const tabs: Tab[] = [terminal(1, "one", "/repo/other")];

    const plan = planDirectoryTabOpen(tabs, "/repo/api", "two", () => next++);

    expect(plan.created).toBe(true);
    expect(plan.tabId).toBe(7);
    expect(plan.tabs[plan.tabs.length - 1]).toMatchObject({
      id: 7,
      kind: "terminal",
      spaceId: "two",
      cold: true,
      cwd: "/repo/api",
      title: "api",
    });
  });

  // Both orderings, so neither first-match-wins nor last-match-wins passes.
  it("reuses the lowest-id terminal tab already parked at the cwd", () => {
    const refuseToAllocate = () => {
      throw new Error("should not allocate");
    };
    const ascending: Tab[] = [
      terminal(1, "one", "/repo/other"),
      terminal(3, "one", "/repo/api"),
      terminal(5, "one", "/repo/api"),
    ];
    const descending: Tab[] = [
      terminal(1, "one", "/repo/other"),
      terminal(5, "one", "/repo/api"),
      terminal(3, "one", "/repo/api"),
    ];

    const fromAscending = planDirectoryTabOpen(
      ascending,
      "/repo/api",
      "one",
      refuseToAllocate,
    );
    const fromDescending = planDirectoryTabOpen(
      descending,
      "/repo/api",
      "one",
      refuseToAllocate,
    );

    expect(fromAscending).toEqual({
      tabs: ascending,
      tabId: 3,
      created: false,
    });
    expect(fromAscending.tabs).toBe(ascending);
    expect(fromDescending).toEqual({
      tabs: descending,
      tabId: 3,
      created: false,
    });
    expect(fromDescending.tabs).toBe(descending);
  });

  it("does not reuse a private tab at the same cwd", () => {
    const tabs: Tab[] = [{ ...terminal(1, "one", "/repo/api"), private: true }];

    const plan = planDirectoryTabOpen(tabs, "/repo/api", "one", () => 9);

    expect(plan.created).toBe(true);
    expect(plan.tabId).toBe(9);
    expect(plan.tabs[plan.tabs.length - 1]).toMatchObject({
      id: 9,
      kind: "terminal",
      cwd: "/repo/api",
    });
  });

  it("does not reuse a tab at the same cwd in another space", () => {
    const tabs: Tab[] = [terminal(1, "one", "/repo/api")];

    const plan = planDirectoryTabOpen(tabs, "/repo/api", "two", () => 9);

    expect(plan.created).toBe(true);
    expect(plan.tabId).toBe(9);
  });

  it("does not reuse an editor tab whose path equals the cwd", () => {
    const tabs: Tab[] = [
      {
        id: 1,
        kind: "editor",
        spaceId: "one",
        title: "api",
        path: "/repo/api",
        dirty: false,
        preview: false,
      },
    ];

    const plan = planDirectoryTabOpen(tabs, "/repo/api", "one", () => 9);

    expect(plan.created).toBe(true);
    expect(plan.tabs[plan.tabs.length - 1]).toMatchObject({
      id: 9,
      kind: "terminal",
      cwd: "/repo/api",
    });
  });
});
