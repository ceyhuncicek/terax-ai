import type { GitBranchEntry } from "@/modules/ai/lib/native";
import { describe, expect, it } from "vitest";
import { filterBranches, groupBranches } from "./branchPicker";

function branch(
  name: string,
  overrides: Partial<GitBranchEntry> = {},
): GitBranchEntry {
  return {
    name,
    kind: "local",
    worktreePath: null,
    isHead: false,
    isDetached: false,
    committerDate: null,
    ...overrides,
  };
}

describe("filterBranches", () => {
  it("keeps the backend order when the query is empty", () => {
    const entries = [branch("newest"), branch("older"), branch("main")];
    expect(filterBranches(entries, "  ").map((b) => b.name)).toEqual([
      "newest",
      "older",
      "main",
    ]);
  });

  it("caps each group at the limit so remotes stay reachable", () => {
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => branch(`b${i}`)),
      ...Array.from({ length: 10 }, (_, i) =>
        branch(`origin/b${i}`, { kind: "remote" as const }),
      ),
    ];
    const empty = filterBranches(entries, "", 3);
    expect(empty.filter((b) => b.kind === "local")).toHaveLength(3);
    expect(empty.filter((b) => b.kind === "remote")).toHaveLength(3);

    const matched = filterBranches(entries, "b", 4);
    expect(matched.filter((b) => b.kind === "local")).toHaveLength(4);
    expect(matched.filter((b) => b.kind === "remote")).toHaveLength(4);
  });

  it("matches on a subsequence, not just a prefix", () => {
    const entries = [branch("feat/login-form"), branch("chore/deps")];
    expect(filterBranches(entries, "lgn").map((b) => b.name)).toEqual([
      "feat/login-form",
    ]);
  });

  it("ranks the closer match first regardless of input order", () => {
    const entries = [branch("staging-login-fix"), branch("login")];
    expect(filterBranches(entries, "login").map((b) => b.name)).toEqual([
      "login",
      "staging-login-fix",
    ]);
  });

  it("breaks score ties by most recent commit", () => {
    const entries = [
      branch("feature-a", { committerDate: 100 }),
      branch("feature-b", { committerDate: 300 }),
      branch("feature-c", { committerDate: 200 }),
    ];
    expect(filterBranches(entries, "feature-").map((b) => b.name)).toEqual([
      "feature-b",
      "feature-c",
      "feature-a",
    ]);
  });

  it("matches a remote branch on its name without the remote prefix", () => {
    const entries = [
      branch("origin/payments", { kind: "remote" }),
      branch("origin/docs", { kind: "remote" }),
    ];
    expect(filterBranches(entries, "payments").map((b) => b.name)).toEqual([
      "origin/payments",
    ]);
  });

  it("drops branches that do not match", () => {
    const entries = [branch("main"), branch("develop")];
    expect(filterBranches(entries, "zzz")).toEqual([]);
  });
});

describe("groupBranches", () => {
  it("splits entries by kind and keeps their order", () => {
    const entries = [
      branch("main"),
      branch("origin/main", { kind: "remote" }),
      branch("wt", { kind: "worktree", worktreePath: "/tmp/wt" }),
      branch("feature"),
    ];
    const groups = groupBranches(entries);
    expect(groups.local.map((b) => b.name)).toEqual(["main", "feature"]);
    expect(groups.worktree.map((b) => b.name)).toEqual(["wt"]);
    expect(groups.remote.map((b) => b.name)).toEqual(["origin/main"]);
  });
});
