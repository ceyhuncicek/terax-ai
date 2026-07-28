import { describe, expect, it } from "vitest";
import {
  beginSourceControlRefresh,
  canReuseResolvedRepo,
  repositoryContainsContext,
} from "./useSourceControl";

describe("repositoryContainsContext", () => {
  it("matches a repository root and its descendants", () => {
    expect(repositoryContainsContext("/repo", "/repo")).toBe(true);
    expect(repositoryContainsContext("/repo", "/repo/packages/app")).toBe(
      true,
    );
  });

  it("rejects sibling paths that only share a string prefix", () => {
    expect(repositoryContainsContext("/repo", "/repo-other/app")).toBe(false);
    expect(repositoryContainsContext("/Repo", "/repo/app")).toBe(false);
  });

  it("normalizes Windows separators and drive-letter casing", () => {
    expect(
      repositoryContainsContext("C:\\Repo", "c:/repo/packages/app"),
    ).toBe(true);
  });

  it("normalizes UNC server and share casing", () => {
    expect(
      repositoryContainsContext(
        "\\\\SERVER\\Share\\Repo",
        "//server/share/repo/packages/app",
      ),
    ).toBe(true);
  });

  it("handles filesystem roots", () => {
    expect(repositoryContainsContext("/", "/workspace")).toBe(true);
    expect(repositoryContainsContext("C:/", "C:/workspace")).toBe(true);
  });
});

describe("beginSourceControlRefresh", () => {
  const loaded = {
    contextPath: "/old/repo",
    repo: {
      repoRoot: "/old/repo",
      branch: "main",
      upstream: null,
      isDetached: false,
    },
    status: {
      repoRoot: "/old/repo",
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      isDetached: false,
      truncated: false,
      changedFiles: [],
    },
    hasRepo: true,
    isLoading: false,
    localError: "old error",
    lastRemoteError: "old remote error",
    untouched: 42,
  };

  it("clears stale repository data when the context changes repositories", () => {
    expect(beginSourceControlRefresh(loaded, "/new/repo", false)).toEqual({
      contextPath: "/new/repo",
      repo: null,
      status: null,
      hasRepo: false,
      isLoading: true,
      localError: null,
      lastRemoteError: null,
      untouched: 42,
    });
  });

  it("preserves fresh repository data for a context inside the same repo", () => {
    expect(
      beginSourceControlRefresh(loaded, "/old/repo/packages/app", true),
    ).toEqual({
      ...loaded,
      contextPath: "/old/repo/packages/app",
      isLoading: true,
      localError: null,
    });
  });
});

describe("canReuseResolvedRepo", () => {
  it("reuses the loaded repo when the context path is unchanged", () => {
    expect(
      canReuseResolvedRepo({
        activeRoot: "/work/bonus-panel",
        contextPath: "/work/bonus-panel",
        lastResolvedPath: "/work/bonus-panel",
      }),
    ).toBe(true);
  });

  it("reuses the loaded repo for a subdirectory already resolved to it", () => {
    expect(
      canReuseResolvedRepo({
        activeRoot: "/work/bonus-panel",
        contextPath: "/work/bonus-panel/src",
        lastResolvedPath: "/work/bonus-panel/src",
      }),
    ).toBe(true);
  });

  it("rediscovers when moving into a subdirectory of the loaded repo", () => {
    // Nested repos: /work/bonus-panel/api may own its own .git, so the parent
    // repo must not be reused for a path we have not resolved yet.
    expect(
      canReuseResolvedRepo({
        activeRoot: "/work/bonus-panel",
        contextPath: "/work/bonus-panel/api",
        lastResolvedPath: "/work/bonus-panel",
      }),
    ).toBe(false);
  });

  it("rediscovers when moving back out to the parent of the loaded repo", () => {
    expect(
      canReuseResolvedRepo({
        activeRoot: "/work/bonus-panel/api",
        contextPath: "/work/bonus-panel",
        lastResolvedPath: "/work/bonus-panel/api",
      }),
    ).toBe(false);
  });

  it("rediscovers for a sibling path that only shares a name prefix", () => {
    expect(
      canReuseResolvedRepo({
        activeRoot: "/work/bonus-panel",
        contextPath: "/work/bonus-panel-legacy",
        lastResolvedPath: "/work/bonus-panel",
      }),
    ).toBe(false);
  });

  it("matches the resolved path across separator and casing differences", () => {
    expect(
      canReuseResolvedRepo({
        activeRoot: "C:/Repo",
        contextPath: "c:/repo/src",
        lastResolvedPath: "C:\\Repo\\src",
      }),
    ).toBe(true);
  });

  it("cannot reuse without a loaded repo", () => {
    expect(
      canReuseResolvedRepo({
        activeRoot: null,
        contextPath: "/work/bonus-panel",
        lastResolvedPath: "/work/bonus-panel",
      }),
    ).toBe(false);
  });

  it("cannot reuse without a context path", () => {
    expect(
      canReuseResolvedRepo({
        activeRoot: "/work/bonus-panel",
        contextPath: null,
        lastResolvedPath: null,
      }),
    ).toBe(false);
  });
});
