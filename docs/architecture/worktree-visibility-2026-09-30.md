# Seeing a git worktree in Terax

Scope: why the explorer and source control panel keep showing the main checkout when an agent CLI creates and works inside a git worktree, and what the options are. Written 2026-09-30 against `72cbd26`. Everything here comes from reading the source, not from running the app.

Status, 2026-10-13: option B below was built (a `terax cd` control verb plus a `CwdChanged` hook) and then removed because it was not useful in practice. The view again does not follow an agent into a worktree, as this document describes. Hook installs prune the old `CwdChanged` hook.

## The short version

Terax has no project root. The explorer, the source control panel, the window title, and the in-app AI all read one derived value: the cwd of the terminal pane you currently have focused. That value arrives from the shell itself, as an OSC 7 escape sequence printed once per prompt.

So when Claude Code makes a worktree and starts editing files in it, nothing moves, because nothing told Terax anything moved. The agent changed directory inside its own process. Your shell never did.

Terax is not confused about worktrees. It handles them correctly everywhere it touches them. It just never hears about this one.

## Why it breaks, precisely

Two separate things block it, and fixing either one alone changes nothing.

### The shell's PWD never changes

`src-tauri/src/modules/pty/scripts/zshrc.zsh:46` prints the cwd from the shell's `precmd` hook:

```zsh
printf '\e]7;file://%s%s\e\\' "${HOST}" "$(_terax_urlencode "$PWD")"
```

Same shape in `bashrc.bash:54`, `init.fish:81`, `profile.ps1:93`. The value is `$PWD`, the shell's own working directory. A child process cannot change its parent's cwd, so after the agent exits, the next prompt re-emits the original path. There is no new value to report, ever.

### The gate is closed during the whole agent run

`src/modules/terminal/ghostty/core/GhosttySemanticEventRouter.ts:34`:

```ts
case "pwd": {
  if (this.inCommand) break;
  const cwd = parseOsc7(event.uri);
  if (cwd) this.callbacks.onCwd?.(cwd);
  break;
}
```

`inCommand` flips true at OSC 133;B, which fires when the prompt finishes drawing, and only clears at 133;D. During a `claude` session that never returns to a prompt, it stays true the entire time. Any OSC 7 emitted inside that window is dropped.

That is deliberate and the comment above it says so: command output is untrusted, and a directory hijack from `cat` on a hostile file would be a real problem. The gate is right. It is just also in the way.

## What already works today, with no code change

This was the surprise. Terax already enumerates worktrees and will jump to one.

`src-tauri/src/modules/git/operations.rs:1225` runs `git worktree list --porcelain` as part of `list_branches`, tags each entry `kind: "worktree"` with its path, and the branch picker renders them under a "Worktrees" heading (`BranchPicker.tsx:339-344`). Selecting one does not check out a branch. It calls `cdInNewTab` (`BranchPicker.tsx:186-194`, wired at `App.tsx:1506`), which opens a terminal tab already spawned at that path.

So the workflow that works right now:

1. Let the agent create the worktree.
2. Open the branch picker in the source control panel. The worktree is listed with its path underneath.
3. Click it. A new terminal tab opens there, and the explorer, git panel, and window title all follow.
4. Start a fresh agent in that tab.

The explorer context menu has the same escape hatch. Right click a directory, "Reveal in terminal" (`FileExplorer.tsx:827-830`), same `cdInNewTab` path.

None of this is documented. The word "worktree" does not appear in `TERAX.md`, `README.md`, or anywhere in `docs/`. If you did not know the branch picker did this, that is the bug, and it is a documentation bug.

The cost is that the agent session you already had running stays where it was. You get a second agent in the right place rather than the first one following along.

## Repo discovery is already worktree-correct

Worth stating because it is the thing you would normally expect to be broken.

A worktree's `.git` is a regular file containing a `gitdir:` pointer, not a directory. Code that checks `.is_dir()` silently fails there. Terax never does. All three places that touch a literal `.git` path use `.exists()`:

- `src-tauri/src/modules/fs/tree.rs:31-42`, the explorer's git decoration gate
- `src-tauri/src/modules/lsp/mod.rs:131`, LSP root markers
- `src-tauri/src/modules/fs/watch.rs:19-21`, the watch skip list

And repo resolution does not inspect `.git` at all. `src-tauri/src/modules/git/operations.rs:38-46` shells out to `git rev-parse --show-toplevel` with an explicit `Command::current_dir` (`process.rs:326-331`), never `git -C`, never process cwd. Git does the work, so git's own worktree semantics apply.

There is a passing test that actually runs `git worktree add`: `src-tauri/tests/git_operations.rs:534-566`.

## Options

Prior art first, because it narrows the field. See the section after this one for sources.

### A. Document the existing flow. Zero code.

Add the branch picker path to `TERAX.md` and tell the agent, in the project instructions, to print the worktree path when it makes one.

Cheapest thing on this list and it unblocks you today. It does not make a running agent's session follow, and it depends on you remembering to click.

### B. Claude Code's `CwdChanged` hook driving a new `terax cd` verb. Recommended.

This is the option the research turned up, and it is better than anything I had before it.

Claude Code has a documented `CwdChanged` hook event that fires whenever the working directory changes, including when Claude enters a worktree. The payload is exactly what Terax needs:

```json
{
  "session_id": "abc123",
  "cwd": "/Users/my-project/subdir",
  "hook_event_name": "CwdChanged",
  "previous_cwd": "/Users/my-project"
}
```

There are also `WorktreeCreate` and `WorktreeRemove` events, and `WorktreeCreate` can take over worktree creation entirely: the hook writes the path it chose to stdout and Claude uses it. Every hook event carries `cwd` in its common input.

Terax already installs Claude Code hooks. `src-tauri/src/modules/agent.rs` writes to `~/.claude/settings.json` for the notification integration, gated on `$TERAX_TERMINAL`, exposed as the `agent_enable_hooks` command and called from `App.tsx:617-625` when an agent group launches. So the installer exists and the file is already ours to extend.

Terax also already has the channel. The control server is a token-authenticated loopback listener (`control.rs:109`), every pane's shell gets `TERAX_CONTROL_ADDR`, `TERAX_CONTROL_TOKEN`, `TERAX_PANE_ID` and the `terax` launcher on PATH (`shell_init.rs:174-190`), and a hook process spawned by Claude inherits all of it from the shell. Verified in the 2.1.285 bundle: hook subprocess env is a denylist of 14 literal credential names, and the fast path returns `process.env` unchanged, so `TERAX_*` passes through.

The missing piece is one verb. `terax cd <dir>` needs:

1. A constant, a params struct, and a `METHODS` entry in `terax-control-protocol/src/lib.rs`. The slice is what `capabilities` returns, so leaving it out breaks discovery silently.
2. One match arm in `terax-cli/src/main.rs:129`.
3. One route arm in `control.rs:324`, with a directory check through `WorkspaceRegistry::is_authorized`, mirroring `require_authorized_open_target`.
4. One branch in `useControlBridge.ts`.
5. Callback wiring at `App.tsx:1378`.

The protocol version is compared for strict equality on both sides but does not need bumping, since `capabilities` is the discovery mechanism and unknown methods already fail cleanly.

Then the hook installer registers `CwdChanged` running `terax cd "$cwd"`, and the whole thing is automatic. No prompt discipline, no remembering to click, and nothing trusted that was not already trusted.

What I like: it is a structured, authenticated, out-of-band channel, which is the same shape Anthropic chose for Claude Code's own host-UI control (tmux commands and the iTerm2 Python API behind a user-installed CLI, never escape codes). It also generalizes, since any agent that can run a command can call `terax cd`.

What to watch: `CwdChanged` fires on every `cd`, not just worktree entry, so the explorer would follow the agent around inside the repo. That is either the feature or the annoyance depending on taste, and it argues for either debouncing or scoping the hook to worktree events only. Also, this only covers Claude Code. Other agents need the prompt-level fallback from option A.

Open design question I cannot settle from source alone: should `terax cd` spawn a terminal tab at the path (reusing `cdInNewTab`, which moves `explorerRoot` synchronously through `newTab`), or re-root the explorer and git panel without touching terminals? The second is less disruptive but has no plumbing, because nothing can currently set the root without a terminal.

### C. Give Space a real root, plus an open folder action.

`SpaceMeta.root` already exists (`spaces/lib/store.ts:6-15`) and is close to dead. It is written on space creation and read in exactly three places, all of them "what cwd should a replacement tab get" (`App.tsx:415`, `:1180`, `:1209`). It never reaches the explorer, git, editor, AI, or LSP.

Making it authoritative, with the explorer honoring a pinned root and falling back to terminal cwd when unpinned, fixes the general problem rather than the worktree case. There is precedent: the source control panel already supports pinning to a fixed repo per space (`repositoryTarget.ts:32-40`).

The prior art argues for this more strongly than I expected. Every agent-worktree tool surveyed binds a session object to a path and has every panel read from that object. Nobody derives panel state from a terminal pane. That is either a strong signal or a gap nobody has tried to fill.

It is still a change to what Terax is. Terminal-first is the design, not an accident, and this touches `useWorkspaceCwd`, `useSpaces`, persistence, and boot. It needs a design pass before code.

### D. Relax the OSC 7 gate. Do not do this.

Warp does accept OSC 7 from a running process, and cites `worktrunk`'s `wt switch` as the motivating case. So this is not a theoretical option; a shipping competitor made this exact call.

Terax should not follow, and the research is one-sided on why.

Kitty implements the same gate Terax has, in `kitty/window.py`:

```python
if reported_cwd and not window.child_is_remote and (self.request_type is CwdRequestType.last_reported or window.at_prompt):
    return reported_cwd
```

`at_prompt` comes from OSC 133 marks. Kitty stores OSC 7 unconditionally and gates at use time, which is the same decision Terax makes at accept time.

The concrete precedent for the threat is CVE-2022-44702 in Windows Terminal: a spoofed working directory, delivered in band, consumed by a host UI action, reaching code execution when a tab was duplicated. That is the exact shape of the risk here.

OSC 7 has no specification. terminal-wg issue 20, "Specify OSC 7 behavior", has been open since 2019. There is no standard to point at that says a child process may not emit it, and no standard that says a terminal must honor it. Every terminal picks, and the careful ones gate.

The prompt-only convention is also not free of injection risk even at the prompt: see the nnn OSC 7 injection issue, where an unescaped directory name containing BEL closes the sequence early and hands the attacker a top-level OSC.

### E. Poll the pty child's working directory. Does not work.

Read the foreground process's cwd through `proc_pidinfo` or `/proc/<pid>/cwd`. Terax does none of this today.

It reads the wrong thing. Claude Code's process cwd is wherever it launched; its file operations use per-call paths rather than `chdir`. The poll returns the main checkout, correctly and uselessly. It is also platform specific and awkward under WSL.

### F. Offer the worktree when it appears.

Watch for new entries under `.git/worktrees` and surface "New worktree `foo`. Open it?" as a toast.

Warp has no equivalent, so this would be ahead of them. It is polish on top of A or B rather than an alternative.

## What I would do

Option A now, because the capability is already shipped and only undocumented. Option B next, because both halves already exist in the codebase and the hook makes it automatic rather than dependent on the agent remembering a rule. Option C only if, after living with B, the thing still bothering you is the explorer following your terminal around.

## Prior art

### Warp

Warp does not create worktrees for agents. Creation is manual `git worktree add`, and automatic per-agent worktrees is an open feature request (warpdotdev/warp issue 7929, filed October 2025).

What Warp has that Terax does not:

- Automatic detection, described in their docs as recognizing "the `.git` file that points back to the main repository". Terax does this too, it just is not written down.
- A "New worktree config" item in the `+` menu that generates a Tab Config. The generated TOML runs `git worktree add -b {{branch_name}} ../{{branch_name}} {{base_branch}}` then `cd`, with a reserved `{{autogenerated_branch_name}}` variable so the branch is named for you.
- Vertical tabs showing per-pane working directory, git branch, agent status, diff stats, PR badges, and the active worktree path.
- A URI scheme: `warp://action/new_tab?path=<path>`, `warp://tab_config/<name>`.

What Warp has that Terax should not copy: it honors OSC 7 from any process. See option D.

What Warp does not have: any documented IPC for "change this pane's directory" or "open this file". Its `warp` binary is an agent runtime, not an app remote. Requests for `warp .` are still open (issue 6641).

### Claude Code

The worktree story is much further along than "run `git worktree add` yourself". There is a `--worktree` / `-w` flag that creates a worktree under `.claude/worktrees/<name>/` on a branch named `worktree-<name>`, generating a name if you omit one. `EnterWorktree` and `ExitWorktree` are real tools. Subagents take `isolation: worktree` in frontmatter.

The hooks are the integration surface, covered in option B.

Anthropic's own answer to driving a host terminal UI is out-of-band RPC: tmux commands and the iTerm2 Python API, requiring a user-installed `it2` CLI and an explicit preference toggle. Never in-band escape codes.

### Agent-worktree managers

Sculptor (imbue) is the closest to what Terax could become: a workspace is a git worktree, and it has both a worktree-scoped file tree with Browse, Changes, and Commits tabs, and a terminal that "runs in the context of the current workspace". One tab per workspace.

Conductor, Crystal, Vibe Kanban, Claude Squad, uzi, and container-use all use one worktree per session or workspace. Most show changed files only rather than a full tree, because the diff is what gets reviewed. Merge is PR-centric in Conductor and Sculptor, local rebase in Crystal, and manual in Claude Squad.

Crystal and Vibe Kanban have both been sunset.

### Editors

No mainstream editor has a "file tree follows the terminal's cwd" mode. VS Code closed that request as-designed (issue 71641). They all bind a window to a worktree instead: VS Code opens a new window, JetBrains opens a new window, Zed has a worktree picker, Cursor scopes worktrees to its Agents Window.

VS Code shipped worktree support in 1.103 (July 2025), JetBrains in 2026.1. The `.git`-as-a-file case was a real bug in VS Code (issue 254977) and in Zed (issue 4670). Terax never had it.

Zed issue 55869, "Git panel does not reflect the worktree an agent is operating in", is the same problem this document is about. It was closed needs-info.

### Terminal protocols

| Terminal | OSC 7 validation | Child can move the UI |
|---|---|---|
| Kitty | Prompt-gated at use time | Yes, with `allow_remote_control` |
| Ghostty | Local hostname only | No remote control found |
| WezTerm | None | Yes, `wezterm cli`, `WEZTERM_PANE` |
| iTerm2 | None documented | Yes, OSC 1337 or the Python API |
| VS Code | Nonce-verified OSC 633 | n/a |

WezTerm's user vars are worth stealing if a terminal-side channel is ever wanted instead of the control socket. A program writes a namespaced key with `OSC 1337 ; SetUserVar=`, the terminal itself does nothing, and a `user-var-changed` event lets the host decide what it means. Applications in the pane can write but not read them.

Kitty's `allow_cloning = ask` is the best UX precedent for gating: the program asks, the user confirms once.

## Things found along the way

`cdInNewTab` (`App.tsx:653-667`) spawns the tab at the right path and then, 80ms later on a `setTimeout` with no retry, types `cd <path>` into the shell. The typed `cd` is redundant, since `newTab(path)` already sets the spawn cwd. If the pane has not mounted in 80ms the write is dropped silently. Worst case is a stray or missing `cd` line in the scrollback, not a wrong directory, but the race is real and untested.

The control server has no per-method authorization: anything holding the token gets the whole surface. The descriptor at `~/Library/Caches/terax/control.json` is `0600` inside a `0700` directory (`control.rs:578`, `:594`), so the threat model is a process running as the same user, not any local process. That is fine for `open`, which can only reach regular files under an authorized root. It deserves a second look before a verb that can spawn a shell.

`terax` is only on PATH inside Terax-spawned panes. There is no global install, no symlink, no "install shell command" action. `cli-control.md:64` says so.

## See also

- `docs/architecture/cli-control.md`
- `docs/architecture/pty-shell-integration.md`
- `docs/architecture/security-model.md`
