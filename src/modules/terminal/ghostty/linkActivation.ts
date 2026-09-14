import type { TerminalLinkTarget } from "@/modules/terminal/ghostty/core/terminalLinks";

/** CSS pixels the pointer may travel between down and up and still count as a
 * click rather than a drag-select. */
export const LINK_ACTIVATION_MOVE_TOLERANCE_PX = 3;

export type LinkActivationAttempt = {
  readonly button: number;
  readonly downModifier: boolean;
  readonly upModifier: boolean;
  readonly downTarget: TerminalLinkTarget | null;
  readonly upTarget: TerminalLinkTarget | null;
  readonly downPoint: { readonly x: number; readonly y: number };
  readonly upPoint: { readonly x: number; readonly y: number };
};

/** Cmd on macOS, Ctrl elsewhere. macOS ctrl+click is the context-menu gesture
 * owned by TerminalNativeSelection, so it must never open a link. */
export function linkModifierHeld(
  event: { readonly metaKey: boolean; readonly ctrlKey: boolean },
  isMac: boolean,
): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

export function terminalLinkTargetsEqual(
  left: TerminalLinkTarget,
  right: TerminalLinkTarget,
): boolean {
  if (left === right) return true;
  if (left.kind === "url") {
    return right.kind === "url" && left.url === right.url;
  }
  return (
    right.kind === "file" &&
    left.path === right.path &&
    left.line === right.line &&
    left.column === right.column
  );
}

export function shouldActivateLink(attempt: LinkActivationAttempt): boolean {
  if (attempt.button !== 0) return false;
  if (!attempt.downModifier || !attempt.upModifier) return false;
  const { downTarget, upTarget } = attempt;
  if (!downTarget || !upTarget) return false;
  if (!terminalLinkTargetsEqual(downTarget, upTarget)) return false;
  return (
    Math.hypot(
      attempt.upPoint.x - attempt.downPoint.x,
      attempt.upPoint.y - attempt.downPoint.y,
    ) < LINK_ACTIVATION_MOVE_TOLERANCE_PX
  );
}
