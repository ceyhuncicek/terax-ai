import type { GitBranchEntry } from "@/modules/ai/lib/native";
import { fuzzyScore } from "@/modules/command-palette/lib/fuzzy";

// A popover list is not virtualized; repos with thousands of remote refs would
// otherwise mount thousands of rows. The cap is per group so a long list of
// local branches never hides the remote ones entirely.
export const BRANCH_PICKER_LIMIT = 200;

export type BranchGroups = {
  local: GitBranchEntry[];
  worktree: GitBranchEntry[];
  remote: GitBranchEntry[];
};

function shortName(entry: GitBranchEntry): string | null {
  if (entry.kind !== "remote") return null;
  const slash = entry.name.indexOf("/");
  if (slash < 0 || slash === entry.name.length - 1) return null;
  return entry.name.slice(slash + 1);
}

function scoreEntry(query: string, entry: GitBranchEntry): number | null {
  const direct = fuzzyScore(query, entry.name);
  const short = shortName(entry);
  const alias = short ? fuzzyScore(query, short) : null;
  if (direct === null) return alias;
  if (alias === null) return direct;
  return Math.max(direct, alias);
}

function byRecency(a: GitBranchEntry, b: GitBranchEntry): number {
  const ad = a.committerDate ?? Number.NEGATIVE_INFINITY;
  const bd = b.committerDate ?? Number.NEGATIVE_INFINITY;
  if (ad !== bd) return bd - ad;
  return a.name.localeCompare(b.name);
}

function takePerKind(
  entries: GitBranchEntry[],
  limit: number,
): GitBranchEntry[] {
  const taken = { local: 0, worktree: 0, remote: 0 };
  const out: GitBranchEntry[] = [];
  for (const entry of entries) {
    const kind = entry.kind === "local" ? "local" : entry.kind;
    if (taken[kind] >= limit) continue;
    taken[kind]++;
    out.push(entry);
  }
  return out;
}

/**
 * Filter to the branches matching `query`, best match first. An empty query
 * keeps the order the backend produced (most recent commit first per group).
 */
export function filterBranches(
  entries: GitBranchEntry[],
  query: string,
  limit: number = BRANCH_PICKER_LIMIT,
): GitBranchEntry[] {
  const term = query.trim();
  if (!term) return takePerKind(entries, limit);

  const scored: { entry: GitBranchEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = scoreEntry(term, entry);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort((a, b) =>
    a.score !== b.score ? b.score - a.score : byRecency(a.entry, b.entry),
  );
  return takePerKind(
    scored.map((s) => s.entry),
    limit,
  );
}

export function groupBranches(entries: GitBranchEntry[]): BranchGroups {
  const groups: BranchGroups = { local: [], worktree: [], remote: [] };
  for (const entry of entries) {
    if (entry.kind === "worktree") groups.worktree.push(entry);
    else if (entry.kind === "remote") groups.remote.push(entry);
    else groups.local.push(entry);
  }
  return groups;
}
