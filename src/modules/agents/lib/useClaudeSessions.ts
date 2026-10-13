import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import type { Tab } from "@/modules/tabs";
import {
  type ClaudeSessionLink,
  findLeaf,
  hasLeaf,
  isLeaf,
  leafIdForPty,
  type PaneNode,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import {
  buildClaudeResumeCommand,
  type ClaudeLaunch,
  type ClaudeSessionEvent,
  claudeLaunch,
  nextClaudeLink,
} from "./claudeSession";
import type { AgentSignal } from "./types";

// A cold tab mounts its renderer before the shell spawns; a slow first paint
// must not cost the resume.
const RESUME_READY_TIMEOUT_MS = 15_000;

type Params = {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  setLeafClaude: (leafId: number, link: ClaudeSessionLink | undefined) => void;
  clearLeafResumeClaude: (leafId: number) => void;
  persistSoon: () => void;
};

function resumableLeaves(node: PaneNode): number[] {
  if (isLeaf(node)) return node.resumeClaude && node.claude ? [node.id] : [];
  return node.children.flatMap(resumableLeaves);
}

function linkOf(tabs: Tab[], leafId: number): ClaudeSessionLink | undefined {
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    const leaf = findLeaf(tab.paneTree, leafId);
    if (leaf) return leaf.claude;
  }
  return undefined;
}

/**
 * Keeps each pane's Claude Code session link current and types the resume
 * into a restored pane once its shell is up.
 */
export function useClaudeSessions({
  tabs,
  tabsRef,
  setLeafClaude,
  clearLeafResumeClaude,
  persistSoon,
}: Params) {
  const launches = useRef(new Map<number, ClaudeLaunch>());
  // Links this hook set, readable before React commits them: an exit can land
  // between a SessionStart and the render that stores its link.
  const written = useRef(new Map<number, ClaudeSessionLink | undefined>());
  // Leaf ids are never reused, so a resumed leaf stays here and can never be
  // typed into twice, whatever order the flag clear and re-renders land in.
  const resuming = useRef(new Set<number>());
  const actions = useRef({ setLeafClaude, persistSoon });
  actions.current = { setLeafClaude, persistSoon };

  const currentLink = useCallback(
    (leafId: number): ClaudeSessionLink | undefined =>
      written.current.has(leafId)
        ? written.current.get(leafId)
        : linkOf(tabsRef.current ?? [], leafId),
    [tabsRef],
  );

  // Installs that predate the SessionStart hook pick it up here; anyone who
  // never enabled agent hooks is left alone.
  useEffect(() => {
    invoke<boolean>("agent_upgrade_hooks", { agent: "claude" }).catch(
      (error) => {
        console.warn("[terax] could not upgrade claude hooks:", error);
      },
    );
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<AgentSignal>("terax:agent-signal", ({ payload }) => {
      if (payload.kind !== "started" && payload.kind !== "exited") return;
      const leafId = leafIdForPty(payload.id);
      if (leafId === null) return;
      if (payload.kind === "started") {
        if (payload.agent === "claude") {
          launches.current.set(leafId, claudeLaunch(payload.command));
        } else {
          launches.current.delete(leafId);
        }
        return;
      }
      launches.current.delete(leafId);
      // Quit, reload, tab close and a dead shell all end as a closed PTY, and
      // the link is exactly what lets those come back.
      if (payload.closed) return;
      if (!currentLink(leafId)) return;
      written.current.set(leafId, undefined);
      actions.current.setLeafClaude(leafId, undefined);
      actions.current.persistSoon();
    })
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch((error) => {
        console.error("[terax] claude session listener failed:", error);
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [currentLink]);

  const recordSession = useCallback(
    (leafId: number, event: ClaudeSessionEvent): boolean => {
      const current = tabsRef.current ?? [];
      if (
        !current.some(
          (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
        )
      ) {
        return false;
      }
      const launch = launches.current.get(leafId);
      const previous = currentLink(leafId);
      const link = nextClaudeLink(previous, launch, event);
      if (!link) return true;
      if (launch) launch.linked = true;
      if (
        previous?.sessionId === link.sessionId &&
        previous?.command === link.command
      ) {
        return true;
      }
      written.current.set(leafId, link);
      actions.current.setLeafClaude(leafId, link);
      actions.current.persistSoon();
      return true;
    },
    [tabsRef, currentLink],
  );

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.kind !== "terminal" || tab.cold) continue;
      for (const leafId of resumableLeaves(tab.paneTree)) {
        if (resuming.current.has(leafId)) continue;
        resuming.current.add(leafId);
        const link = findLeaf(tab.paneTree, leafId)?.claude;
        // WSL panes get no control credentials, so no link can come from them
        // and a resume typed there would run a different claude install.
        const wsl =
          useSpaces.getState().spaces.find((s) => s.id === tab.spaceId)?.env
            .kind === "wsl";
        const line =
          link && !wsl
            ? buildClaudeResumeCommand(link.command, link.sessionId)
            : null;
        void (async () => {
          try {
            if (!line) return;
            await whenSessionReady(leafId, RESUME_READY_TIMEOUT_MS);
            if (!writeToSession(leafId, `${line}\r`)) {
              console.warn(`[terax] could not resume claude in pane ${leafId}`);
            }
          } finally {
            clearLeafResumeClaude(leafId);
          }
        })();
      }
    }
  }, [tabs, clearLeafResumeClaude]);

  return recordSession;
}
