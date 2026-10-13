import { describe, expect, it } from "vitest";
import { parseAgentSessionRequest, parseOpenRequest } from "./useControlBridge";

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

describe("parseAgentSessionRequest", () => {
  it("reads a claude session and its source", () => {
    expect(
      parseAgentSessionRequest({
        agent: "claude",
        session_id: "abc-1",
        source: "clear",
      }),
    ).toEqual({ sessionId: "abc-1", source: "clear" });
    expect(
      parseAgentSessionRequest({ agent: "claude", session_id: "abc-1" }),
    ).toEqual({ sessionId: "abc-1" });
  });

  it("rejects other agents and ids a shell would interpret", () => {
    expect(() =>
      parseAgentSessionRequest({ agent: "codex", session_id: "abc" }),
    ).toThrow("only claude is supported");
    for (const session_id of ["", "a;b", "$(id)", 7]) {
      expect(() =>
        parseAgentSessionRequest({ agent: "claude", session_id }),
      ).toThrow("session id is invalid");
    }
  });
});
