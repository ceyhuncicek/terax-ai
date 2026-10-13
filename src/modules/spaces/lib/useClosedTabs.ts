import { native } from "@/modules/ai/lib/native";
import type { Tab } from "@/modules/tabs";
import { isLeaf, type PaneNode } from "@/modules/terminal/lib/panes";
import { type RefObject, useCallback, useMemo, useRef } from "react";
import {
  type ClosedTabStacks,
  closedTabEntry,
  popClosedTab,
  pushClosedTab,
} from "./closedTabs";
import { hydrateTab } from "./serialize";

type Params = {
  tabsRef: RefObject<Tab[]>;
  activeSpaceIdRef: RefObject<string | null>;
  allocId: () => number;
  restoreTab: (tab: Tab, spaceIndex: number) => void;
};

function leafCwds(node: PaneNode): string[] {
  if (isLeaf(node)) return node.cwd ? [node.cwd] : [];
  return node.children.flatMap(leafCwds);
}

/**
 * Per-space history of closed tabs, kept in memory only. A reopened tab comes
 * back the way a restored one does: cold, spawning in its saved cwd and
 * resuming any Claude session it had.
 */
export function useClosedTabs({
  tabsRef,
  activeSpaceIdRef,
  allocId,
  restoreTab,
}: Params) {
  const stacks = useRef<ClosedTabStacks>({});

  const remember = useCallback(
    (tabIds: number[]) => {
      for (const id of tabIds) {
        const closed = closedTabEntry(tabsRef.current ?? [], id);
        if (closed) {
          stacks.current = pushClosedTab(
            stacks.current,
            closed.spaceId,
            closed.entry,
          );
        }
      }
    },
    [tabsRef],
  );

  const reopen = useCallback(async () => {
    const spaceId = activeSpaceIdRef.current;
    if (!spaceId) return;
    const { stacks: next, entry } = popClosedTab(stacks.current, spaceId);
    stacks.current = next;
    if (!entry) return;
    const tab = hydrateTab(entry.tab, spaceId, allocId);
    if (!tab) return;
    if (tab.kind === "terminal") {
      await Promise.allSettled(
        [...new Set(leafCwds(tab.paneTree))].map((cwd) =>
          native.workspaceAuthorize(cwd),
        ),
      );
    }
    restoreTab(tab, entry.index);
  }, [activeSpaceIdRef, allocId, restoreTab]);

  return useMemo(() => ({ remember, reopen }), [remember, reopen]);
}
