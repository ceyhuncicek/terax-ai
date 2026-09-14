import { describe, expect, it } from "vitest";
import {
  authorInitials,
  authorTint,
  githubAvatarUrl,
  gravatarUrl,
  normalizeAuthorEmail,
} from "./authorAvatar";

describe("authorInitials", () => {
  it("falls back to a question mark when the name is blank", () => {
    expect(authorInitials("")).toBe("?");
    expect(authorInitials("   ")).toBe("?");
  });

  it("uses one letter for a single word name", () => {
    expect(authorInitials("linus")).toBe("L");
  });

  it("uses first and last word for multi word names", () => {
    expect(authorInitials("Ada Lovelace")).toBe("AL");
    expect(authorInitials("  jean  luc   picard ")).toBe("JP");
  });
});

describe("authorTint", () => {
  it("returns the same tint for the same key", () => {
    expect(authorTint("ada@example.com")).toBe(authorTint("ada@example.com"));
  });

  it("returns a hex color from the palette", () => {
    expect(authorTint("ada@example.com")).toMatch(/^#[0-9a-f]{6}$/);
    expect(authorTint("")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("spreads distinct keys across more than one tint", () => {
    const keys = Array.from({ length: 40 }, (_, i) => `author${i}@example.com`);
    const tints = new Set(keys.map(authorTint));
    expect(tints.size).toBeGreaterThan(1);
  });
});

describe("normalizeAuthorEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeAuthorEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("handles empty input", () => {
    expect(normalizeAuthorEmail("")).toBe("");
  });
});

describe("githubAvatarUrl", () => {
  it("maps the numeric id form to the avatars host", () => {
    expect(githubAvatarUrl("1234+octocat@users.noreply.github.com", 64)).toBe(
      "https://avatars.githubusercontent.com/u/1234?s=64",
    );
  });

  it("maps the legacy login form to the profile picture", () => {
    expect(githubAvatarUrl("octocat@users.noreply.github.com", 32)).toBe(
      "https://github.com/octocat.png?size=32",
    );
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(githubAvatarUrl("  OctoCat@Users.NoReply.GitHub.com  ", 16)).toBe(
      "https://github.com/octocat.png?size=16",
    );
  });

  it("returns null for a non github address", () => {
    expect(githubAvatarUrl("ada@example.com", 64)).toBeNull();
    expect(githubAvatarUrl("", 64)).toBeNull();
    expect(githubAvatarUrl("users.noreply.github.com", 64)).toBeNull();
  });

  it("rejects an empty local part", () => {
    expect(githubAvatarUrl("@users.noreply.github.com", 64)).toBeNull();
  });

  it("rejects a non numeric id in the plus form", () => {
    expect(
      githubAvatarUrl("x12+octocat@users.noreply.github.com", 64),
    ).toBeNull();
    expect(githubAvatarUrl("+octocat@users.noreply.github.com", 64)).toBeNull();
  });

  it("rejects logins carrying url control characters", () => {
    expect(githubAvatarUrl("oct/cat@users.noreply.github.com", 64)).toBeNull();
    expect(githubAvatarUrl("oct?cat@users.noreply.github.com", 64)).toBeNull();
    expect(githubAvatarUrl("oct#cat@users.noreply.github.com", 64)).toBeNull();
    expect(githubAvatarUrl("oct cat@users.noreply.github.com", 64)).toBeNull();
    expect(
      githubAvatarUrl("1+oct/cat@users.noreply.github.com", 64),
    ).toBeNull();
    expect(githubAvatarUrl("1+@users.noreply.github.com", 64)).toBeNull();
  });

  it("clamps a bogus size to a usable pixel value", () => {
    expect(githubAvatarUrl("octocat@users.noreply.github.com", 0)).toBe(
      "https://github.com/octocat.png?size=1",
    );
    expect(
      githubAvatarUrl("octocat@users.noreply.github.com", Number.NaN),
    ).toBe("https://github.com/octocat.png?size=1");
  });
});

describe("gravatarUrl", () => {
  it("builds a d=404 url so a missing avatar is detectable", () => {
    expect(gravatarUrl("abc123", 64)).toBe(
      "https://www.gravatar.com/avatar/abc123?s=64&d=404",
    );
  });

  it("rounds the requested size", () => {
    expect(gravatarUrl("abc123", 20.6)).toBe(
      "https://www.gravatar.com/avatar/abc123?s=21&d=404",
    );
  });
});
