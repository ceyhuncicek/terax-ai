import { describe, expect, it } from "vitest";
import {
  detectTerminalLinks,
  resolveFileLinkPath,
  type TerminalLinkMatch,
} from "./terminalLinks";

const urls = (text: string): string[] =>
  detectTerminalLinks(text)
    .filter((link) => link.target.kind === "url")
    .map((link) => (link.target.kind === "url" ? link.target.url : ""));

const files = (text: string) =>
  detectTerminalLinks(text)
    .filter((link) => link.target.kind === "file")
    .map((link) => link.target);

const sliced = (text: string): string[] =>
  detectTerminalLinks(text).map((link) => text.slice(link.start, link.end));

describe("url detection", () => {
  it("finds every supported scheme", () => {
    expect(
      urls("http://a.test/x https://b.test/y mailto:me@example.com"),
    ).toEqual(["http://a.test/x", "https://b.test/y", "mailto:me@example.com"]);
  });

  it("does not swallow trailing prose punctuation", () => {
    expect(urls("see https://example.com/a.")).toEqual([
      "https://example.com/a",
    ]);
    expect(urls("https://example.com/a, https://example.com/b;")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(urls("https://example.com/a! https://example.com/b?")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("drops unmatched closing wrappers but keeps balanced ones", () => {
    expect(urls("(https://example.com/a_(b))")).toEqual([
      "https://example.com/a_(b)",
    ]);
    expect(urls("https://example.com/x]")).toEqual(["https://example.com/x"]);
    expect(urls(`"https://example.com/y"`)).toEqual(["https://example.com/y"]);
    const uri = "https://example.com/a_(b)[c]{d}";
    expect(urls(`${uri}${")]}".repeat(1_000)}`)).toEqual([uri]);
  });

  it("ignores executable protocols and incomplete links", () => {
    expect(detectTerminalLinks("javascript:alert(1) https://")).toEqual([]);
  });

  it("keeps Unicode and query parameters with correct offsets", () => {
    const text = "日本 https://example.com/日本?q=one&x=2 end";
    expect(sliced(text)).toEqual(["https://example.com/日本?q=one&x=2"]);
  });
});

describe("file path detection", () => {
  it("finds absolute paths", () => {
    expect(files("built /Users/x/foo.ts now")).toEqual([
      { kind: "file", path: "/Users/x/foo.ts" },
    ]);
    expect(files("/usr/local/bin/")).toEqual([
      { kind: "file", path: "/usr/local/bin/" },
    ]);
  });

  it("finds home-relative paths", () => {
    expect(files("edit ~/projects/foo/bar.ts")).toEqual([
      { kind: "file", path: "~/projects/foo/bar.ts" },
    ]);
    expect(files("cd ~/")).toEqual([{ kind: "file", path: "~/" }]);
  });

  it("finds explicitly relative paths", () => {
    expect(files("./foo.ts and ../foo.ts and ../../a/b")).toEqual([
      { kind: "file", path: "./foo.ts" },
      { kind: "file", path: "../foo.ts" },
      { kind: "file", path: "../../a/b" },
    ]);
  });

  it("finds bare relative paths carrying a separator", () => {
    expect(files("src/modules/foo.ts")).toEqual([
      { kind: "file", path: "src/modules/foo.ts" },
    ]);
    expect(files("libs/core/src/repositories/message/")).toEqual([
      { kind: "file", path: "libs/core/src/repositories/message/" },
    ]);
    expect(files("dotfiles: src/.env")).toEqual([
      { kind: "file", path: "src/.env" },
    ]);
  });

  it("parses every position suffix form", () => {
    expect(files("foo.ts:42")).toEqual([
      { kind: "file", path: "foo.ts", line: 42 },
    ]);
    expect(files("foo.ts:42:7")).toEqual([
      { kind: "file", path: "foo.ts", line: 42, column: 7 },
    ]);
    expect(files("foo.ts(42)")).toEqual([
      { kind: "file", path: "foo.ts", line: 42 },
    ]);
    expect(files("foo.ts(42,7)")).toEqual([
      { kind: "file", path: "foo.ts", line: 42, column: 7 },
    ]);
    expect(files("src/a/foo.ts(42, 7)")).toEqual([
      { kind: "file", path: "src/a/foo.ts", line: 42, column: 7 },
    ]);
  });

  it("omits line and column when there is no suffix", () => {
    const [target] = files("src/modules/foo.ts");
    expect(Object.keys(target ?? {})).toEqual(["kind", "path"]);
  });

  it("reports offsets that cover the suffix", () => {
    const text = "at src/a.ts:12:3 done";
    expect(sliced(text)).toEqual(["src/a.ts:12:3"]);
  });

  it("does not swallow a trailing sentence dot", () => {
    const text = "check src/a.ts.";
    expect(sliced(text)).toEqual(["src/a.ts"]);
  });

  it("refuses ambiguous tokens", () => {
    expect(files("README")).toEqual([]);
    expect(files("see / for root")).toEqual([]);
    expect(files("version 1.2.3 shipped")).toEqual([]);
    expect(files("bumped to 1.2.3:4")).toEqual([]);
    expect(files("meeting at 12:30")).toEqual([]);
    expect(files("build finished at 12:30:45")).toEqual([]);
    expect(files("foo.ts")).toEqual([]);
    expect(files("read and/or write")).toEqual([]);
    expect(files("dated 2024/01/02")).toEqual([]);
    expect(files("mixed data:text/html,x")).toEqual([]);
  });

  it("handles realistic compiler and runtime output", () => {
    expect(files("error[E0382]: moved value at src/main.rs:10:5")).toEqual([
      { kind: "file", path: "src/main.rs", line: 10, column: 5 },
    ]);
    expect(files("  at Object.<anonymous> (/a/app/index.js:5:11)")).toEqual([
      { kind: "file", path: "/a/app/index.js", line: 5, column: 11 },
    ]);
    expect(files("PASS  src/modules/a/b.test.ts (3 tests)")).toEqual([
      { kind: "file", path: "src/modules/a/b.test.ts" },
    ]);
    expect(files("input w/e n/a 24/7 he/him TODO(2)")).toEqual([]);
    expect(files("cargo 1.79.0 (ffa9cf99a 2024-06-03)")).toEqual([]);
    expect(files("docker run ubuntu:22.04 bash")).toEqual([]);
  });

  it("leaves file:// urls alone", () => {
    expect(detectTerminalLinks("file:///Users/me/a.txt")).toEqual([]);
  });

  it("does not match Windows paths and does not crash on them", () => {
    expect(() => detectTerminalLinks(String.raw`C:\x\y.rs`)).not.toThrow();
    expect(files(String.raw`C:\x\y.rs`)).toEqual([]);
  });

  it("skips scheme tails of unsupported protocols", () => {
    expect(files("ftp://host.test/a/b.ts")).toEqual([]);
    expect(files("git+ssh://host.test/a/b.ts")).toEqual([]);
  });
});

describe("url versus file precedence", () => {
  it("lets the url win on an overlapping range", () => {
    expect(detectTerminalLinks("https://example.com/src/a.ts:12")).toEqual([
      {
        start: 0,
        end: 31,
        target: { kind: "url", url: "https://example.com/src/a.ts:12" },
      },
    ]);
  });

  it("keeps a file path that only follows a url", () => {
    const text = "https://example.com/docs src/a.ts";
    expect(sliced(text)).toEqual(["https://example.com/docs", "src/a.ts"]);
  });
});

describe("mixed lines", () => {
  it("returns non-overlapping matches sorted by start", () => {
    const text =
      "see https://example.com/docs then src/a.ts:12 and ../b/c.rs(3,4) done";
    const links = detectTerminalLinks(text);
    expect(links.map((link) => text.slice(link.start, link.end))).toEqual([
      "https://example.com/docs",
      "src/a.ts:12",
      "../b/c.rs(3,4)",
    ]);
    expect(links.map((link) => link.target)).toEqual([
      { kind: "url", url: "https://example.com/docs" },
      { kind: "file", path: "src/a.ts", line: 12 },
      { kind: "file", path: "../b/c.rs", line: 3, column: 4 },
    ]);
    let previous = -1;
    for (const link of links as readonly TerminalLinkMatch[]) {
      expect(link.start).toBeGreaterThan(previous);
      previous = link.end - 1;
    }
  });
});

describe("resolveFileLinkPath", () => {
  it("returns absolute paths normalized", () => {
    expect(resolveFileLinkPath("/Users/x/foo.ts", null, null)).toBe(
      "/Users/x/foo.ts",
    );
    expect(resolveFileLinkPath("//Users//x/./foo.ts", null, null)).toBe(
      "/Users/x/foo.ts",
    );
    expect(resolveFileLinkPath("/Users/x/../y/foo.ts", null, null)).toBe(
      "/Users/y/foo.ts",
    );
    expect(resolveFileLinkPath("/../..", null, null)).toBe("/");
  });

  it("joins home-relative paths with the home directory", () => {
    expect(resolveFileLinkPath("~/a/b.ts", null, "/home/me")).toBe(
      "/home/me/a/b.ts",
    );
    expect(resolveFileLinkPath("~", null, "/home/me")).toBe("/home/me");
    expect(resolveFileLinkPath("~/", null, "/home/me")).toBe("/home/me");
    expect(resolveFileLinkPath("~/a/b.ts", "/work", null)).toBeNull();
  });

  it("joins relative paths with the cwd", () => {
    expect(resolveFileLinkPath("src/a.ts", "/work/repo", null)).toBe(
      "/work/repo/src/a.ts",
    );
    expect(resolveFileLinkPath("./src/a.ts", "/work/repo", null)).toBe(
      "/work/repo/src/a.ts",
    );
    expect(resolveFileLinkPath("../a.ts", "/work/repo", null)).toBe(
      "/work/a.ts",
    );
    expect(resolveFileLinkPath("../../../a.ts", "/work/repo", null)).toBe(
      "/a.ts",
    );
    expect(resolveFileLinkPath("src/a.ts", "/", null)).toBe("/src/a.ts");
    expect(resolveFileLinkPath("src/a.ts", null, "/home/me")).toBeNull();
  });

  it("drops a trailing separator and empty input", () => {
    expect(resolveFileLinkPath("src/dir/", "/work", null)).toBe(
      "/work/src/dir",
    );
    expect(resolveFileLinkPath("", "/work", null)).toBeNull();
  });

  it("accepts backslash separated bases without touching the filesystem", () => {
    expect(resolveFileLinkPath("src/a.ts", String.raw`C:\work`, null)).toBe(
      "C:/work/src/a.ts",
    );
  });
});
