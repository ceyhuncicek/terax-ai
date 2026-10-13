import { describe, expect, it } from "vitest";
import type { PaneNode } from "@/modules/terminal/lib/panes";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { hydrateTabs, serializeTabs, type SerializedTab } from "./serialize";

function counter(start = 100): () => number {
  let n = start;
  return () => n++;
}

function leafIdsOf(node: PaneNode): number[] {
  return node.kind === "leaf" ? [node.id] : node.children.flatMap(leafIdsOf);
}

function term(over: Partial<Extract<Tab, { kind: "terminal" }>>): Tab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "s1",
    title: "shell",
    paneTree: { kind: "leaf", id: 2, cwd: "/a" },
    activeLeafId: 2,
    ...over,
  } as Tab;
}

describe("serializeTabs", () => {
  it("drops private terminals and transient kinds", () => {
    const tabs: Tab[] = [
      term({ id: 1 }),
      term({ id: 3, private: true }),
      {
        id: 5,
        kind: "git-diff",
        spaceId: "s1",
        title: "d",
        path: "/a/x",
        repoRoot: "/a",
        mode: "+",
        originalPath: null,
        preview: true,
      },
      {
        id: 7,
        kind: "editor",
        spaceId: "s1",
        title: "x",
        path: "/a/x.ts",
        dirty: false,
        preview: false,
      },
    ];
    const out = serializeTabs(tabs);
    expect(out.map((t) => t.kind)).toEqual(["terminal", "editor"]);
  });

  it("marks the active leaf in a split tree", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const [s] = serializeTabs([term({ paneTree: tree, activeLeafId: 12 })]);
    const node = s as Extract<SerializedTab, { kind: "terminal" }>;
    expect(node.tree.kind).toBe("split");
    if (node.tree.kind === "split") {
      expect(node.tree.children[1]).toMatchObject({ cwd: "/b", active: true });
      expect(node.tree.children[0]).not.toHaveProperty("active");
    }
  });
});

describe("hydrateTabs", () => {
  it("round-trips structure, cwd, blocks and active leaf", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "col",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const tabs: Tab[] = [
      term({
        paneTree: tree,
        activeLeafId: 12,
        blocks: true,
        customTitle: "x",
      }),
    ];
    const serialized = serializeTabs(tabs);
    const [restored] = hydrateTabs(serialized, "s2", counter());
    expect(restored.kind).toBe("terminal");
    if (restored.kind !== "terminal") return;

    expect(restored.spaceId).toBe("s2");
    expect(restored.cold).toBe(true);
    expect(restored.blocks).toBe(true);
    expect(restored.customTitle).toBe("x");
    expect(restored.paneTree.kind).toBe("split");

    const leaves = leafIdsOf(restored.paneTree);
    expect(new Set(leaves).size).toBe(2);
    expect(leaves).toContain(restored.activeLeafId);
    // active leaf was the second one, which carried /b
    expect(restored.cwd).toBe("/b");
  });

  it("allocates fresh, unique, monotonic ids across all tabs and leaves", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const serialized = serializeTabs([
      term({ id: 1, paneTree: tree, activeLeafId: 11 }),
      term({ id: 2 }),
    ]);
    const restored = hydrateTabs(serialized, "s1", counter(100));

    const ids: number[] = [];
    for (const t of restored) {
      ids.push(t.id);
      if (t.kind === "terminal") ids.push(...leafIdsOf(t.paneTree));
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(100);
  });

  it("returns empty for corrupted input without throwing", () => {
    expect(hydrateTabs([] as SerializedTab[], "s1", counter())).toEqual([]);
    expect(
      hydrateTabs(null as unknown as SerializedTab[], "s1", counter()),
    ).toEqual([]);
  });

  it("hydrates editor/preview/markdown as cold with derived titles", () => {
    const serialized: SerializedTab[] = [
      { kind: "editor", path: "/a/foo.ts" },
      { kind: "preview", url: "http://localhost:5173/x" },
      { kind: "markdown", path: "/a/README.md" },
    ];
    const out = hydrateTabs(serialized, "s1", counter());
    expect(out.every((t) => t.cold === true)).toBe(true);
    expect(out.map((t) => t.title)).toEqual([
      "foo.ts",
      "localhost:5173",
      "README.md",
    ]);
  });
});

describe("claude session links", () => {
  const SESSION = "2b1f9a4e-6c1d-4f7e-9a3b-0c5d8e7f1a2b";

  it("round-trips a link onto the new leaf id and marks it for resume", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        {
          kind: "leaf",
          id: 11,
          cwd: "/a",
          claude: { sessionId: SESSION, command: "claude --model opus" },
        },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const serialized = serializeTabs([
      term({ paneTree: tree, activeLeafId: 12 }),
    ]);
    const [restored] = hydrateTabs(serialized, "s1", counter());
    if (restored.kind !== "terminal" || restored.paneTree.kind !== "split") {
      throw new Error("expected a restored split");
    }
    const [first, second] = restored.paneTree.children;
    expect(first).toMatchObject({
      kind: "leaf",
      cwd: "/a",
      claude: { sessionId: SESSION, command: "claude --model opus" },
      resumeClaude: true,
    });
    expect(first.id).not.toBe(11);
    expect(second).not.toHaveProperty("claude");
    expect(second).not.toHaveProperty("resumeClaude");
  });

  it("never persists the transient resume flag", () => {
    const [out] = serializeTabs([
      term({
        paneTree: {
          kind: "leaf",
          id: 2,
          cwd: "/a",
          claude: { sessionId: SESSION },
          resumeClaude: true,
        },
      }),
    ]);
    expect(out).toEqual({
      kind: "terminal",
      tree: {
        kind: "leaf",
        cwd: "/a",
        active: true,
        claude: { sessionId: SESSION },
      },
    });
  });

  it("drops links whose id could carry shell syntax", () => {
    const leaf = (claude: unknown): SerializedTab => ({
      kind: "terminal",
      tree: { kind: "leaf", cwd: "/a", claude } as never,
    });
    for (const claude of [
      { sessionId: "abc; rm -rf ~" },
      { sessionId: "$(id)" },
      { sessionId: "" },
      { sessionId: 42 },
      "abc",
      null,
    ]) {
      const [tab] = hydrateTabs([leaf(claude)], "s1", counter());
      if (tab.kind !== "terminal") throw new Error("expected a terminal");
      expect(tab.paneTree).not.toHaveProperty("claude");
      expect(tab.paneTree).not.toHaveProperty("resumeClaude");
    }
  });

  it("keeps the id but drops a malformed command", () => {
    const [tab] = hydrateTabs(
      [
        {
          kind: "terminal",
          tree: {
            kind: "leaf",
            claude: { sessionId: SESSION, command: 7 as unknown as string },
          },
        },
      ],
      "s1",
      counter(),
    );
    if (tab.kind !== "terminal") throw new Error("expected a terminal");
    expect(tab.paneTree).toMatchObject({ claude: { sessionId: SESSION } });
    expect(tab.paneTree).not.toHaveProperty("claude.command");
  });
});
