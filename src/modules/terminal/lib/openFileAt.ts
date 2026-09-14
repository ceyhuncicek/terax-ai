import type { TerminalLinkTarget } from "@/modules/terminal/ghostty/core/terminalLinks";

/** Carries a line hint, unlike `terax:open-file`, whose `string[]` payload is
 * shared with the Rust launch and "Open With" route. */
export const OPEN_FILE_AT_EVENT = "terax:open-file-at";

export type OpenFileAtPayload = {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
};

export function fileLinkOpenPayload(
  target: Extract<TerminalLinkTarget, { kind: "file" }>,
  resolvedPath: string,
): OpenFileAtPayload {
  return {
    path: resolvedPath,
    ...(target.line === undefined ? {} : { line: target.line }),
    ...(target.column === undefined ? {} : { column: target.column }),
  };
}
