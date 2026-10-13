import type { Tab } from "@/modules/tabs/lib/useTabs";
import { type SerializedTab, serializeTab } from "./serialize";

const CLOSED_TAB_LIMIT = 10;

/** A closed tab and where it sat in its space's strip. */
export type ClosedTab = { tab: SerializedTab; index: number };

export type ClosedTabStacks = Readonly<Record<string, readonly ClosedTab[]>>;

/** Captures `tabId` before it closes; null for tabs that cannot be restored. */
export function closedTabEntry(
  tabs: Tab[],
  tabId: number,
): { spaceId: string; entry: ClosedTab } | null {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  const serialized = serializeTab(tab);
  if (!serialized) return null;
  const index = tabs
    .filter((t) => t.spaceId === tab.spaceId)
    .findIndex((t) => t.id === tabId);
  return { spaceId: tab.spaceId, entry: { tab: serialized, index } };
}

export function pushClosedTab(
  stacks: ClosedTabStacks,
  spaceId: string,
  entry: ClosedTab,
  limit = CLOSED_TAB_LIMIT,
): ClosedTabStacks {
  const stack = [...(stacks[spaceId] ?? []), entry];
  return { ...stacks, [spaceId]: stack.slice(-limit) };
}

export function popClosedTab(
  stacks: ClosedTabStacks,
  spaceId: string,
): { stacks: ClosedTabStacks; entry: ClosedTab | null } {
  const stack = stacks[spaceId];
  if (!stack?.length) return { stacks, entry: null };
  return {
    stacks: { ...stacks, [spaceId]: stack.slice(0, -1) },
    entry: stack[stack.length - 1],
  };
}
