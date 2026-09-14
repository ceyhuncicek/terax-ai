import type { TerminalLinkTarget } from "@/modules/terminal/ghostty/core/terminalLinks";
import { describe, expect, it } from "vitest";
import {
  LINK_ACTIVATION_MOVE_TOLERANCE_PX,
  type LinkActivationAttempt,
  linkModifierHeld,
  shouldActivateLink,
  terminalLinkTargetsEqual,
} from "./linkActivation";

const url: TerminalLinkTarget = { kind: "url", url: "https://terax.dev/docs" };
const other: TerminalLinkTarget = { kind: "url", url: "https://example.com" };
const file: TerminalLinkTarget = {
  kind: "file",
  path: "src/main.tsx",
  line: 12,
  column: 3,
};

function attempt(
  overrides: Partial<LinkActivationAttempt> = {},
): LinkActivationAttempt {
  return {
    button: 0,
    downModifier: true,
    upModifier: true,
    downTarget: url,
    upTarget: url,
    downPoint: { x: 100, y: 200 },
    upPoint: { x: 100, y: 200 },
    ...overrides,
  };
}

describe("linkModifierHeld", () => {
  it("uses Command on macOS and never Control", () => {
    expect(linkModifierHeld({ metaKey: true, ctrlKey: false }, true)).toBe(
      true,
    );
    expect(linkModifierHeld({ metaKey: false, ctrlKey: true }, true)).toBe(
      false,
    );
  });

  it("uses Control on Windows and Linux and never Command", () => {
    expect(linkModifierHeld({ metaKey: false, ctrlKey: true }, false)).toBe(
      true,
    );
    expect(linkModifierHeld({ metaKey: true, ctrlKey: false }, false)).toBe(
      false,
    );
  });
});

describe("terminalLinkTargetsEqual", () => {
  it("compares urls and file coordinates", () => {
    expect(terminalLinkTargetsEqual(url, { ...url })).toBe(true);
    expect(terminalLinkTargetsEqual(url, other)).toBe(false);
    expect(terminalLinkTargetsEqual(url, file)).toBe(false);
    expect(terminalLinkTargetsEqual(file, { ...file })).toBe(true);
    expect(terminalLinkTargetsEqual(file, { ...file, line: 13 })).toBe(false);
    expect(terminalLinkTargetsEqual(file, { ...file, column: undefined })).toBe(
      false,
    );
  });
});

describe("shouldActivateLink", () => {
  it("activates a stationary modifier click on one link", () => {
    expect(shouldActivateLink(attempt())).toBe(true);
    expect(
      shouldActivateLink(attempt({ downTarget: file, upTarget: file })),
    ).toBe(true);
  });

  it("does not activate a plain click", () => {
    expect(
      shouldActivateLink(attempt({ downModifier: false, upModifier: false })),
    ).toBe(false);
  });

  it("does not activate when the modifier is only held at one end", () => {
    expect(shouldActivateLink(attempt({ downModifier: false }))).toBe(false);
    expect(shouldActivateLink(attempt({ upModifier: false }))).toBe(false);
  });

  it("does not activate a drag past the movement tolerance", () => {
    expect(
      shouldActivateLink(
        attempt({
          upPoint: { x: 100 + LINK_ACTIVATION_MOVE_TOLERANCE_PX, y: 200 },
        }),
      ),
    ).toBe(false);
    expect(shouldActivateLink(attempt({ upPoint: { x: 100, y: 240 } }))).toBe(
      false,
    );
  });

  it("tolerates sub-threshold pointer jitter", () => {
    expect(shouldActivateLink(attempt({ upPoint: { x: 101, y: 201 } }))).toBe(
      true,
    );
  });

  it("does not activate when the target changed between down and up", () => {
    expect(shouldActivateLink(attempt({ upTarget: other }))).toBe(false);
    expect(shouldActivateLink(attempt({ upTarget: null }))).toBe(false);
    expect(shouldActivateLink(attempt({ downTarget: null }))).toBe(false);
  });

  it("does not activate a non-primary button", () => {
    expect(shouldActivateLink(attempt({ button: 1 }))).toBe(false);
    expect(shouldActivateLink(attempt({ button: 2 }))).toBe(false);
  });

  it("does not activate a macOS ctrl+click, which is the context menu", () => {
    const ctrlOnMac = linkModifierHeld({ metaKey: false, ctrlKey: true }, true);
    expect(
      shouldActivateLink(
        attempt({ downModifier: ctrlOnMac, upModifier: ctrlOnMac }),
      ),
    ).toBe(false);
  });
});
