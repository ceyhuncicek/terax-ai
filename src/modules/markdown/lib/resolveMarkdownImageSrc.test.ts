import { describe, expect, it } from "vitest";
import { resolveMarkdownImageSrc } from "./resolveMarkdownImageSrc";

const DIR = "/Users/me/repo/docs";
const HOME = "/Users/me";

describe("resolveMarkdownImageSrc", () => {
  it("leaves absolute http(s) urls alone", () => {
    expect(resolveMarkdownImageSrc("https://x.dev/a.png", DIR)).toBeNull();
    expect(resolveMarkdownImageSrc("http://x.dev/a.png", DIR)).toBeNull();
  });

  it("leaves data urls alone", () => {
    expect(
      resolveMarkdownImageSrc("data:image/png;base64,AAA", DIR),
    ).toBeNull();
  });

  it("leaves blob and protocol-relative urls alone", () => {
    expect(resolveMarkdownImageSrc("blob:abc123", DIR)).toBeNull();
    expect(resolveMarkdownImageSrc("//cdn.x.dev/a.png", DIR)).toBeNull();
  });

  it("resolves an explicitly relative src against the markdown directory", () => {
    expect(resolveMarkdownImageSrc("./shot.png", DIR)).toBe(
      "/Users/me/repo/docs/shot.png",
    );
  });

  it("walks up out of the markdown directory", () => {
    expect(resolveMarkdownImageSrc("../a/b.png", DIR)).toBe(
      "/Users/me/repo/a/b.png",
    );
  });

  it("resolves a bare filename against the markdown directory", () => {
    expect(resolveMarkdownImageSrc("shot.png", DIR)).toBe(
      "/Users/me/repo/docs/shot.png",
    );
  });

  it("keeps a leading slash as a filesystem path", () => {
    expect(resolveMarkdownImageSrc("/tmp/a.png", DIR)).toBe("/tmp/a.png");
  });

  it("expands a tilde against the home directory", () => {
    expect(resolveMarkdownImageSrc("~/pics/a.png", DIR, HOME)).toBe(
      "/Users/me/pics/a.png",
    );
  });

  it("gives up on a tilde when the home directory is unknown", () => {
    expect(resolveMarkdownImageSrc("~/pics/a.png", DIR)).toBeNull();
  });

  it("keeps dot-prefixed directories intact", () => {
    expect(resolveMarkdownImageSrc("../.github/logo.png", DIR)).toBe(
      "/Users/me/repo/.github/logo.png",
    );
  });

  it("resolves against the root for a markdown file at the filesystem root", () => {
    expect(resolveMarkdownImageSrc("./shot.png", "")).toBe("/shot.png");
    expect(resolveMarkdownImageSrc("shot.png", "")).toBe("/shot.png");
    expect(resolveMarkdownImageSrc("../shot.png", "")).toBe("/shot.png");
  });

  it("ignores an empty src", () => {
    expect(resolveMarkdownImageSrc("", DIR)).toBeNull();
    expect(resolveMarkdownImageSrc("   ", DIR)).toBeNull();
  });
});
