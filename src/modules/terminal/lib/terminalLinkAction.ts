/** Shape of the `fs_stat` reply the routing decision depends on. `kind` crosses
 * the IPC boundary as a plain string, so unknown values are treated as unusable
 * rather than assumed to be files. */
export type TerminalLinkStat = { readonly kind: string };

/** `resolve` means the path is a symlink whose target kind decides the route:
 * `fs_stat` reports the link itself, so a link to a directory looks like
 * neither `dir` nor `file` until it is canonicalized and re-stat'd. */
export type TerminalLinkAction = "open" | "reveal" | "resolve" | "none";

export function terminalLinkAction(
  stat: TerminalLinkStat | null,
): TerminalLinkAction {
  switch (stat?.kind) {
    case "dir":
      return "reveal";
    case "file":
      return "open";
    case "symlink":
      return "resolve";
    default:
      return "none";
  }
}
