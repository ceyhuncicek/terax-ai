import { describe, expect, it } from "vitest";
import { terminalLinkAction } from "./terminalLinkAction";

describe("terminalLinkAction", () => {
  it("reveals a directory instead of handing it to the editor", () => {
    expect(terminalLinkAction({ kind: "dir" })).toBe("reveal");
  });

  it("opens a regular file", () => {
    expect(terminalLinkAction({ kind: "file" })).toBe("open");
  });

  it("asks for a canonicalized re-stat on a symlink", () => {
    expect(terminalLinkAction({ kind: "symlink" })).toBe("resolve");
  });

  it("does nothing for a missing path", () => {
    expect(terminalLinkAction(null)).toBe("none");
  });

  it("does nothing when the stat call failed", () => {
    const stat = ((): { kind: string } | null => {
      try {
        throw new Error("ENOENT");
      } catch {
        return null;
      }
    })();
    expect(terminalLinkAction(stat)).toBe("none");
  });

  it("does not fall through to the editor on an unrecognized kind", () => {
    expect(terminalLinkAction({ kind: "socket" })).toBe("none");
    expect(terminalLinkAction({ kind: "" })).toBe("none");
  });
});
