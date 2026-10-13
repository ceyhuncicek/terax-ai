import { describe, expect, it } from "vitest";
import { insertTabInSpace, type Tab } from "./useTabs";

function term(id: number, spaceId: string): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
  } as Tab;
}

const ids = (tabs: Tab[]) => tabs.map((t) => t.id);

describe("insertTabInSpace", () => {
  const tabs = [term(1, "a"), term(2, "b"), term(3, "a"), term(4, "b")];

  it("puts the tab back at its index within its own space", () => {
    expect(ids(insertTabInSpace(tabs, term(9, "a"), 0))).toEqual([
      9, 1, 2, 3, 4,
    ]);
    expect(ids(insertTabInSpace(tabs, term(9, "a"), 1))).toEqual([
      1, 2, 9, 3, 4,
    ]);
    expect(ids(insertTabInSpace(tabs, term(9, "b"), 1))).toEqual([
      1, 2, 3, 9, 4,
    ]);
  });

  it("appends after the space's last tab when the index is past its end", () => {
    expect(ids(insertTabInSpace(tabs, term(9, "a"), 5))).toEqual([
      1, 2, 3, 9, 4,
    ]);
  });

  it("appends when the space has no tabs left", () => {
    expect(ids(insertTabInSpace(tabs, term(9, "c"), 2))).toEqual([
      1, 2, 3, 4, 9,
    ]);
  });
});
