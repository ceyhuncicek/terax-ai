import type { Tab } from "@/modules/tabs/lib/useTabs";
import { describe, expect, it } from "vitest";
import { resolveControlContext } from "./context";

const tabs: Tab[] = [
  {
    id: 10,
    kind: "terminal",
    spaceId: "agent-space",
    title: "agent",
    paneTree: {
      kind: "split",
      id: 11,
      dir: "row",
      children: [
        { kind: "leaf", id: 12 },
        { kind: "leaf", id: 13 },
      ],
    },
    activeLeafId: 12,
  },
  {
    id: 20,
    kind: "editor",
    spaceId: "active-space",
    title: "main.rs",
    path: "/workspace/main.rs",
    dirty: false,
    preview: false,
  },
];

describe("resolveControlContext", () => {
  it("targets the calling pane instead of ambient UI focus", () => {
    expect(resolveControlContext(tabs, 20, "active-space", 13)).toEqual({
      window_id: "main",
      space_id: "agent-space",
      tab_id: 10,
      pane_id: 13,
      source: "caller",
      foreground: false,
    });
  });

  it("falls back to the active context for an external CLI", () => {
    expect(resolveControlContext(tabs, 20, "active-space")).toEqual({
      window_id: "main",
      space_id: "active-space",
      tab_id: 20,
      pane_id: null,
      source: "active",
      foreground: false,
    });
  });

  it("does not trust a stale caller pane id", () => {
    expect(resolveControlContext(tabs, 20, "active-space", 999).source).toBe(
      "active",
    );
  });

  it("marks the active leaf of the active tab as foreground", () => {
    expect(resolveControlContext(tabs, 10, "agent-space", 12).foreground).toBe(
      true,
    );
  });

  it("keeps a sibling pane of the active tab in the background", () => {
    expect(resolveControlContext(tabs, 10, "agent-space", 13).foreground).toBe(
      false,
    );
  });

  it("keeps a pane of a non-active tab in the background", () => {
    expect(resolveControlContext(tabs, 20, "active-space", 12).foreground).toBe(
      false,
    );
  });

  it("never treats the no-pane-id fallback as foreground", () => {
    expect(resolveControlContext(tabs, 10, "agent-space").foreground).toBe(
      false,
    );
  });
});
