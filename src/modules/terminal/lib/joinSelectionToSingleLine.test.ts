import { describe, expect, it } from "vitest";
import { joinSelectionToSingleLine } from "./joinSelectionToSingleLine";

describe("joinSelectionToSingleLine", () => {
  it("joins TUI-wrapped lines with two-space indented continuations", () => {
    const copied = [
      "  git log --oneline --graph --decorate --all",
      "  --since=2.weeks --author=someone",
      "  -- src/modules/terminal",
    ].join("\n");
    expect(joinSelectionToSingleLine(copied)).toBe(
      "git log --oneline --graph --decorate --all --since=2.weeks --author=someone -- src/modules/terminal",
    );
  });

  it("drops shell backslash continuations", () => {
    expect(
      joinSelectionToSingleLine("docker run \\\n  --rm \\\n  -it image\\\n"),
    ).toBe("docker run --rm -it image");
  });

  it("keeps an escaped trailing backslash", () => {
    expect(joinSelectionToSingleLine("echo a\\\\\nnext")).toBe(
      "echo a\\\\ next",
    );
  });

  it("drops blank and whitespace-only lines", () => {
    expect(joinSelectionToSingleLine("\n  first\n\n   \n\tsecond  \n\n")).toBe(
      "first second",
    );
  });

  it("handles CRLF and lone CR line endings", () => {
    expect(joinSelectionToSingleLine("one\r\ntwo\rthree")).toBe(
      "one two three",
    );
  });

  it("leaves a single line unchanged apart from surrounding whitespace", () => {
    expect(joinSelectionToSingleLine("ls -la  /tmp")).toBe("ls -la  /tmp");
    expect(joinSelectionToSingleLine("  ls -la /tmp  ")).toBe("ls -la /tmp");
  });

  it("returns an empty string for empty or blank input", () => {
    expect(joinSelectionToSingleLine("")).toBe("");
    expect(joinSelectionToSingleLine(" \n\r\n\t")).toBe("");
    expect(joinSelectionToSingleLine("\\")).toBe("");
  });
});
