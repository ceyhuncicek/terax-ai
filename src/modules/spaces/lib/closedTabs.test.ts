import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import {
  type ClosedTab,
  type ClosedTabStacks,
  closedTabEntry,
  popClosedTab,
  pushClosedTab,
} from "./closedTabs";

const SESSION = "2b1f9a4e-6c1d-4f7e-9a3b-0c5d8e7f1a2b";

function terminal(id: number, spaceId: string, over: object = {}): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    paneTree: { kind: "leaf", id: id + 100, cwd: "/a" },
    activeLeafId: id + 100,
    ...over,
  } as Tab;
}

function entry(path: string, index = 0): ClosedTab {
  return { tab: { kind: "editor", path }, index };
}

describe("closedTabEntry", () => {
  it("captures the serialized tab, its claude link and its place in the space", () => {
    const tabs: Tab[] = [
      terminal(1, "a"),
      terminal(2, "b"),
      terminal(3, "a", {
        paneTree: {
          kind: "leaf",
          id: 103,
          cwd: "/w",
          claude: { sessionId: SESSION, command: "claude" },
        },
        activeLeafId: 103,
      }),
    ];
    expect(closedTabEntry(tabs, 3)).toEqual({
      spaceId: "a",
      entry: {
        index: 1,
        tab: {
          kind: "terminal",
          tree: {
            kind: "leaf",
            cwd: "/w",
            active: true,
            claude: { sessionId: SESSION, command: "claude" },
          },
        },
      },
    });
  });

  it("skips private terminals, transient kinds and unknown ids", () => {
    const tabs: Tab[] = [
      terminal(1, "a", { private: true }),
      {
        id: 2,
        kind: "git-history",
        spaceId: "a",
        title: "History",
        repoRoot: "/r",
      },
    ];
    expect(closedTabEntry(tabs, 1)).toBeNull();
    expect(closedTabEntry(tabs, 2)).toBeNull();
    expect(closedTabEntry(tabs, 9)).toBeNull();
  });
});

describe("closed tab stacks", () => {
  it("reopens the most recently closed tab of a space first", () => {
    let stacks: ClosedTabStacks = {};
    stacks = pushClosedTab(stacks, "a", entry("/1"));
    stacks = pushClosedTab(stacks, "b", entry("/b"));
    stacks = pushClosedTab(stacks, "a", entry("/2", 3));

    const first = popClosedTab(stacks, "a");
    expect(first.entry).toEqual(entry("/2", 3));
    const second = popClosedTab(first.stacks, "a");
    expect(second.entry).toEqual(entry("/1"));
    const empty = popClosedTab(second.stacks, "a");
    expect(empty.entry).toBeNull();
    expect(popClosedTab(empty.stacks, "b").entry).toEqual(entry("/b"));
  });

  it("forgets the oldest entry past the limit", () => {
    let stacks: ClosedTabStacks = {};
    for (let i = 0; i < 12; i++) {
      stacks = pushClosedTab(stacks, "a", entry(`/${i}`), 10);
    }
    expect(stacks.a).toHaveLength(10);
    expect(stacks.a[0]).toEqual(entry("/2"));
    expect(stacks.a[9]).toEqual(entry("/11"));
  });

  it("does not mutate the previous stacks", () => {
    const before = pushClosedTab({}, "a", entry("/1"));
    const after = pushClosedTab(before, "a", entry("/2"));
    expect(before.a).toHaveLength(1);
    popClosedTab(after, "a");
    expect(after.a).toHaveLength(2);
  });
});
