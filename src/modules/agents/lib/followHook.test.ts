import { describe, expect, it } from "vitest";
import { reconcileFollowHook } from "./followHook";

describe("reconcileFollowHook", () => {
  it("agrees with the preference when the file matches", () => {
    expect(reconcileFollowHook(true, true)).toEqual({
      checked: true,
      status: "ok",
    });
    expect(reconcileFollowHook(false, false)).toEqual({
      checked: false,
      status: "ok",
    });
  });

  it("falls back to the preference when the file cannot be read", () => {
    expect(reconcileFollowHook(true, null)).toEqual({
      checked: true,
      status: "ok",
    });
    expect(reconcileFollowHook(false, null)).toEqual({
      checked: false,
      status: "ok",
    });
  });

  it("reports a hook the user deleted by hand", () => {
    expect(reconcileFollowHook(true, false)).toEqual({
      checked: false,
      status: "missing",
    });
  });

  it("reports a hook left behind after turning the preference off", () => {
    expect(reconcileFollowHook(false, true)).toEqual({
      checked: true,
      status: "stale",
    });
  });
});
