import { describe, expect, it } from "vitest";
import { parseCdRequest, parseOpenRequest } from "./useControlBridge";

describe("parseOpenRequest", () => {
  it("defaults focus only when it is absent", () => {
    expect(parseOpenRequest({ path: "/repo/main.rs" }).focus).toBe(true);
    expect(
      parseOpenRequest({ path: "/repo/main.rs", focus: false }).focus,
    ).toBe(false);
  });

  it.each([0, "false", null, {}])(
    "rejects non-boolean focus value %o",
    (focus) => {
      expect(() => parseOpenRequest({ path: "/repo/main.rs", focus })).toThrow(
        "focus must be a boolean",
      );
    },
  );
});

describe("parseCdRequest", () => {
  it("requires a non-empty path", () => {
    expect(() => parseCdRequest({})).toThrow("cd path is required");
    expect(() => parseCdRequest({ path: "" })).toThrow("cd path is required");
  });

  it.each([0, "false", null, {}])(
    "rejects non-boolean focus value %o",
    (focus) => {
      expect(() => parseCdRequest({ path: "/repo", focus })).toThrow(
        "focus must be a boolean",
      );
    },
  );

  it("defaults focus only when it is absent", () => {
    expect(parseCdRequest({ path: "/repo" }).focus).toBe(true);
    expect(parseCdRequest({ path: "/repo", focus: false }).focus).toBe(false);
  });
});
