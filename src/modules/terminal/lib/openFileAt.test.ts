import type { TerminalLinkTarget } from "@/modules/terminal/ghostty/core/terminalLinks";
import { describe, expect, it } from "vitest";
import { fileLinkOpenPayload, OPEN_FILE_AT_EVENT } from "./openFileAt";

type FileLinkTarget = Extract<TerminalLinkTarget, { kind: "file" }>;

const base: FileLinkTarget = { kind: "file", path: "src/foo.ts" };

describe("fileLinkOpenPayload", () => {
  it("carries the resolved path with the parsed line and column", () => {
    expect(
      fileLinkOpenPayload(
        { ...base, line: 42, column: 7 },
        "/Users/dev/app/src/foo.ts",
      ),
    ).toEqual({ path: "/Users/dev/app/src/foo.ts", line: 42, column: 7 });
  });

  it("omits line and column when the link carries no position", () => {
    const payload = fileLinkOpenPayload(base, "/Users/dev/app/src/foo.ts");
    expect(payload).toEqual({ path: "/Users/dev/app/src/foo.ts" });
    expect("line" in payload).toBe(false);
    expect("column" in payload).toBe(false);
  });

  it("keeps a line without a column", () => {
    const payload = fileLinkOpenPayload({ ...base, line: 42 }, "/app/foo.ts");
    expect(payload).toEqual({ path: "/app/foo.ts", line: 42 });
    expect("column" in payload).toBe(false);
  });

  it("uses the resolved path, never the raw link text", () => {
    expect(
      fileLinkOpenPayload({ ...base, path: "./foo.ts", line: 3 }, "/app/foo.ts")
        .path,
    ).toBe("/app/foo.ts");
  });

  it("names the frontend-only open-at route", () => {
    expect(OPEN_FILE_AT_EVENT).toBe("terax:open-file-at");
    expect(OPEN_FILE_AT_EVENT).not.toBe("terax:open-file");
  });
});
