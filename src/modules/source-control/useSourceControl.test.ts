import { describe, expect, it } from "vitest";
import { canReuseResolvedRepo } from "./useSourceControl";

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
