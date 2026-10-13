import type { ClaudeSessionLink } from "@/modules/terminal/lib/panes";

/**
 * What the shell reported when `claude` started in a pane. `command` is the
 * normalized launch line, never the raw one, so env assignments such as API
 * keys never reach the leaf or the store.
 */
export type ClaudeLaunch = {
  command?: string;
  print: boolean;
  linked: boolean;
};

export type ClaudeSessionEvent = { sessionId: string; source?: string };

const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
// Every kept token is typed back into a shell, so nothing the shell would
// expand, quote, chain or redirect survives.
const SAFE_TOKEN = /^[A-Za-z0-9_./:=@%+,~-]+$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["npx", "bunx", "pnpx"]);
const PROGRAM = /^claude(-[A-Za-z0-9_.-]+)?$/;
const DROP_FLAGS = new Set([
  "-c",
  "--continue",
  "-p",
  "--print",
  "--fork-session",
]);
const DROP_WITH_VALUE = new Set(["--session-id"]);
const RESUME_FLAGS = new Set(["-r", "--resume"]);
const BOOLEAN_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--verbose",
  "--ide",
  "--strict-mcp-config",
  "--chrome",
  "--no-chrome",
]);

export function isValidClaudeSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

function tokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

export function isClaudePrintMode(command: string): boolean {
  return tokens(command).some((t) => t === "-p" || t === "--print");
}

/**
 * Splits a launch command into an optional wrapper, the claude program and its
 * arguments, or null when it is not a plain claude launch. Leading env
 * assignments are skipped and never returned: they can carry secrets.
 */
function parseLaunch(
  command: string,
): { wrapper?: string; program: string; args: string[] } | null {
  const parts = tokens(command);
  if (parts.length === 0 || !parts.every((t) => SAFE_TOKEN.test(t))) {
    return null;
  }
  let i = 0;
  while (i < parts.length && ENV_ASSIGNMENT.test(parts[i])) i++;
  const wrapper = WRAPPERS.has(parts[i]) ? parts[i++] : undefined;
  const program = parts[i];
  if (
    !program ||
    program.includes("=") ||
    !PROGRAM.test(program.split("/").pop() ?? "")
  ) {
    return null;
  }
  return { wrapper, program, args: parts.slice(i + 1) };
}

// Keeps flags and their values; drops session selection, print mode and any
// positional prompt, which would otherwise be sent again on every resume.
function keptArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    const nextIsValue = next !== undefined && !next.startsWith("-");
    if (RESUME_FLAGS.has(arg) || DROP_WITH_VALUE.has(arg)) {
      if (nextIsValue) i++;
      continue;
    }
    if (DROP_FLAGS.has(arg)) continue;
    if (/^(--resume|--session-id|-r)=/.test(arg)) continue;
    if (!arg.startsWith("-")) continue;
    out.push(arg);
    if (arg.includes("=") || BOOLEAN_FLAGS.has(arg) || !nextIsValue) continue;
    out.push(next);
    i++;
  }
  return out;
}

/**
 * The launch line worth keeping: wrapper, program and flags, without env
 * assignments, session selection, print mode or a prompt. Undefined when the
 * command is not a plain claude launch.
 */
export function normalizeClaudeCommand(
  command: string | undefined,
): string | undefined {
  const launch = command ? parseLaunch(command) : null;
  if (!launch) return undefined;
  return [
    ...(launch.wrapper ? [launch.wrapper] : []),
    launch.program,
    ...keptArgs(launch.args),
  ].join(" ");
}

// Every shell integration cuts the OSC 133;C line at this many characters.
const SHELL_COMMAND_CAP = 256;

export function claudeLaunch(command: string | undefined): ClaudeLaunch {
  // A line at the cap may have lost flags, so it is not kept as the launch.
  const complete =
    command !== undefined && [...command].length < SHELL_COMMAND_CAP;
  return {
    command: complete ? normalizeClaudeCommand(command) : undefined,
    print: command ? isClaudePrintMode(command) : false,
    linked: false,
  };
}

/**
 * The line to type into a restored pane to pick its Claude session back up,
 * or null when the id is not safe to type.
 */
export function buildClaudeResumeCommand(
  command: string | undefined,
  sessionId: string,
): string | null {
  if (!isValidClaudeSessionId(sessionId)) return null;
  return `${normalizeClaudeCommand(command) ?? "claude"} --resume ${sessionId}`;
}

/**
 * The link a pane should carry after a SessionStart report, or null to leave
 * it alone. A second `startup` inside one run is a nested `claude -p` from the
 * agent's own tools sharing the pane's environment, not a new session.
 */
export function nextClaudeLink(
  current: ClaudeSessionLink | undefined,
  launch: ClaudeLaunch | undefined,
  event: ClaudeSessionEvent,
): ClaudeSessionLink | null {
  if (!isValidClaudeSessionId(event.sessionId)) return null;
  if (launch?.print) return null;
  // Without the launch line (no shell preexec), a startup cannot be told apart
  // from a nested `claude -p`, so it never displaces an existing link.
  if (launch && !launch.linked && (launch.command || !current)) {
    return withCommand(event.sessionId, launch.command);
  }
  if (event.source === "startup" && current) return null;
  return withCommand(event.sessionId, launch?.command ?? current?.command);
}

function withCommand(
  sessionId: string,
  command: string | undefined,
): ClaudeSessionLink {
  return command ? { sessionId, command } : { sessionId };
}
