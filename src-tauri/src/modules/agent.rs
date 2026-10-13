use serde_json::{json, Value};

// How a given agent's hook delivers our OSC 777 marker into the terminal.
#[derive(Clone, Copy)]
enum Delivery {
    // Claude returns the sequence via a `terminalSequence` JSON field (it lost
    // /dev/tty access in v2.1.139) and emits it in-band. Cross-platform.
    TerminalSequence,
    // Codex/Gemini hooks can't write to the terminal, so the hook command emits
    // the marker itself: to /dev/tty on Unix, via a CONOUT$ helper on Windows.
    Osc,
}

// What a given hook does. Notify emits the OSC 777 status marker; Follow asks
// Terax to follow the agent into a new project root; Session tells Terax which
// session runs in the pane so a restored pane can resume it.
#[derive(Clone, Copy, PartialEq)]
enum HookKind {
    Notify,
    Follow,
    Session,
}

struct HookSpec {
    event: &'static str,
    // Status marker for Notify; unused otherwise.
    marker: &'static str,
    kind: HookKind,
}

struct AgentSpec {
    agent: &'static str,
    dir: &'static str,
    file: &'static str,
    events: &'static [HookSpec],
    matcher: bool,
    delivery: Delivery,
}

const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        agent: "claude",
        dir: ".claude",
        file: "settings.json",
        events: &[
            HookSpec {
                event: "UserPromptSubmit",
                marker: "working",
                kind: HookKind::Notify,
            },
            HookSpec {
                event: "Notification",
                marker: "attention",
                kind: HookKind::Notify,
            },
            HookSpec {
                event: "Stop",
                marker: "finished",
                kind: HookKind::Notify,
            },
            HookSpec {
                event: "CwdChanged",
                marker: "",
                kind: HookKind::Follow,
            },
            HookSpec {
                event: "SessionStart",
                marker: "",
                kind: HookKind::Session,
            },
        ],
        matcher: false,
        delivery: Delivery::TerminalSequence,
    },
    AgentSpec {
        agent: "codex",
        dir: ".codex",
        file: "hooks.json",
        events: &[
            HookSpec {
                event: "UserPromptSubmit",
                marker: "working",
                kind: HookKind::Notify,
            },
            HookSpec {
                event: "PermissionRequest",
                marker: "attention",
                kind: HookKind::Notify,
            },
            HookSpec {
                event: "Stop",
                marker: "finished",
                kind: HookKind::Notify,
            },
        ],
        matcher: false,
        delivery: Delivery::Osc,
    },
    AgentSpec {
        agent: "gemini",
        dir: ".gemini",
        file: "settings.json",
        events: &[
            HookSpec {
                event: "BeforeAgent",
                marker: "working",
                kind: HookKind::Notify,
            },
            HookSpec {
                event: "Notification",
                marker: "attention",
                kind: HookKind::Notify,
            },
            HookSpec {
                event: "AfterAgent",
                marker: "finished",
                kind: HookKind::Notify,
            },
        ],
        matcher: true,
        delivery: Delivery::Osc,
    },
];

const PI_EXTENSION_DIR: &str = ".pi/agent/extensions";
const PI_EXTENSION_FILE: &str = "terax-notifications.ts";
const PI_EXTENSION_MARKER: &str = "terax-pi-notifications-v1";
const PI_STATUS_NEEDLES: [&str; 6] = [
    PI_EXTENSION_MARKER,
    "agent_start",
    "agent_settled",
    "notify;Terax;pi;${event}",
    "emit(\"working\")",
    "emit(\"finished\")",
];
const PI_EXTENSION: &str = r#"// terax-pi-notifications-v1
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const emit = (event: "working" | "finished") => {
    if (process.env.TERAX_TERMINAL) {
      process.stdout.write(`\u001b]777;notify;Terax;pi;${event}\u0007`);
    }
  };

  pi.on("agent_start", () => emit("working"));
  pi.on("agent_settled", () => emit("finished"));
}
"#;

// Substrings identifying a hook command as ours, across every form we've ever
// emitted (legacy /dev/tty Claude, current TerminalSequence, Osc, Windows
// helper). Used to prune our own groups before reinserting so installs are
// idempotent and migrate older markers.
const OWNED_MARKERS: [&str; 5] = [
    "notify;Terax;",
    "terax;notify",
    "__terax_notify",
    FOLLOW_MARKER,
    SESSION_MARKER,
];

// Terax-specific spellings so pruning our own groups can never match a hook the
// user wrote themselves.
const FOLLOW_MARKER: &str = "--terax-follow-hook";
const SESSION_MARKER: &str = "--terax-session-hook";

fn find(agent: &str) -> Result<&'static AgentSpec, String> {
    AGENTS
        .iter()
        .find(|s| s.agent == agent)
        .ok_or_else(|| format!("unknown agent {agent}"))
}

fn hook_command(spec: &AgentSpec, hook: &HookSpec) -> String {
    let event = hook.marker;
    match (hook.kind, spec.delivery) {
        (HookKind::Follow, _) => follow_command(),
        (HookKind::Session, _) => session_command(),
        (HookKind::Notify, Delivery::TerminalSequence) => format!(
            r#"[ -n "$TERAX_TERMINAL" ] && printf '{{"terminalSequence":"\\u001b]777;notify;Terax;{event}\\u0007"}}' || true"#
        ),
        (HookKind::Notify, Delivery::Osc) => osc_command(spec.agent, event),
    }
}

// Guarded on TERAX_CLI rather than TERAX_TERMINAL: WSL panes set
// TERAX_TERMINAL but get no CLI, and an unguarded call would print
// "command not found" on every directory change.
fn follow_command() -> String {
    r#"[ -n "$TERAX_CLI" ] && [ -n "$TERAX_CONTROL_TOKEN" ] && "$TERAX_CLI" cd --terax-follow-hook || true"#.to_string()
}

// SessionStart stdout becomes model context, so the CLI prints nothing in hook
// mode and the guard keeps WSL panes, which have no CLI, just as quiet.
fn session_command() -> String {
    r#"[ -n "$TERAX_CLI" ] && [ -n "$TERAX_CONTROL_TOKEN" ] && "$TERAX_CLI" agent-session --terax-session-hook || true"#.to_string()
}

// Marker to the tty, then `{}` on stdout: Codex/Gemini require a JSON no-op.
#[cfg(unix)]
fn osc_command(agent: &str, event: &str) -> String {
    format!(
        r#"[ -n "$TERAX_TERMINAL" ] && printf '\033]777;notify;Terax;{agent};{event}\007' > /dev/tty; printf '{{}}'"#
    )
}

#[cfg(windows)]
fn osc_command(agent: &str, event: &str) -> String {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "terax.exe".to_string());
    format!(r#""{exe}" __terax_notify {agent} {event}"#)
}

// The stable substring that proves a given (agent, event) hook is installed.
// Kept in sync with hook_command so status reflects what enable writes.
fn status_needle(spec: &AgentSpec, hook: &HookSpec) -> String {
    let event = hook.marker;
    match (hook.kind, spec.delivery) {
        (HookKind::Follow, _) => FOLLOW_MARKER.to_string(),
        (HookKind::Session, _) => SESSION_MARKER.to_string(),
        (HookKind::Notify, Delivery::TerminalSequence) => format!("notify;Terax;{event}"),
        (HookKind::Notify, Delivery::Osc) => {
            #[cfg(unix)]
            {
                format!("notify;Terax;{};{event}", spec.agent)
            }
            #[cfg(windows)]
            {
                format!("__terax_notify {} {event}", spec.agent)
            }
        }
    }
}

fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| OWNED_MARKERS.iter().any(|m| c.contains(m)))
            })
        })
}

// A group with no hooks is inert cruft (e.g. left behind when someone deletes
// our command but not its wrapper). Drop it so the file stays clean.
fn is_empty_group(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_none_or(|hs| hs.is_empty())
}

fn merge_hooks(mut root: Value, spec: &AgentSpec, follow: bool) -> Value {
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    for hook in spec.events {
        // A follow hook the user turned off has to be pruned on every enable,
        // not just skipped, or switching it off would leave the old one behind.
        let install = follow || hook.kind != HookKind::Follow;
        if !install && !hooks.contains_key(hook.event) {
            continue;
        }
        let arr = hooks.entry(hook.event).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        arr.retain(|group| !is_ours(group) && !is_empty_group(group));
        if install {
            let mut group = json!({
                "hooks": [ { "type": "command", "command": hook_command(spec, hook) } ]
            });
            if spec.matcher {
                group["matcher"] = json!("*");
            }
            arr.push(group);
        } else if arr.is_empty() {
            // Nothing but ours was here, so leave no empty key behind.
            // shift_remove, not remove: under preserve_order remove swaps the
            // last key into this slot and reorders the user's file.
            hooks.shift_remove(hook.event);
        }
    }
    root
}

fn existing_config(contents: Option<&str>, path: &std::path::Path) -> Result<Value, String> {
    match contents {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(s).map_err(|e| {
            format!("{} is not valid JSON ({e}); refusing to overwrite", path.display())
        }),
        _ => Ok(json!({})),
    }
}

fn home_path(dir: &str, file: &str) -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(dir)
        .join(file))
}

fn settings_path(spec: &AgentSpec) -> Result<std::path::PathBuf, String> {
    home_path(spec.dir, spec.file)
}

fn pi_extension_path() -> Result<std::path::PathBuf, String> {
    home_path(PI_EXTENSION_DIR, PI_EXTENSION_FILE)
}

fn pi_extension_contents(
    existing: Option<&str>,
    path: &std::path::Path,
) -> Result<&'static str, String> {
    if existing.is_some_and(|s| !s.trim().is_empty() && !s.contains(PI_EXTENSION_MARKER)) {
        return Err(format!(
            "{} is not managed by Terax; refusing to overwrite",
            path.display()
        ));
    }
    Ok(PI_EXTENSION)
}

// Writes through a symlink to its target, so a dotfiles-managed config stays a
// link, and creates the replacement with the old file's permissions so a
// private file is never readable by others, not even for the rename window.
fn write_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::io::Write;

    let target = write_target(path)?;
    let tmp = target.with_extension("terax-tmp");
    let permissions = std::fs::metadata(&target).ok().map(|m| m.permissions());
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(permissions.as_ref().map_or(0o644, |p| p.mode() & 0o7777));
    }
    let written = options
        .open(&tmp)
        .and_then(|mut file| file.write_all(contents.as_bytes()));
    // The umask can narrow the mode given to open; widen it back to the original.
    let result = written.and_then(|()| match &permissions {
        Some(permissions) => std::fs::set_permissions(&tmp, permissions.clone()),
        None => Ok(()),
    });
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", tmp.display()));
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", target.display())
    })
}

fn write_target(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            std::fs::canonicalize(path).map_err(|e| format!("resolve {}: {e}", path.display()))
        }
        Ok(_) => Ok(path.to_path_buf()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(e) => Err(format!("inspect {}: {e}", path.display())),
    }
}

fn enable_pi_extension_at(path: &std::path::Path) -> Result<(), String> {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let existing = match std::fs::read_to_string(path) {
        Ok(s) if s == PI_EXTENSION => return Ok(()),
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let contents = pi_extension_contents(existing.as_deref(), path)?;
    write_atomic(path, contents)
}

fn enable_pi_extension() -> Result<(), String> {
    enable_pi_extension_at(&pi_extension_path()?)
}

#[tauri::command]
pub fn agent_enable_hooks(agent: String, follow: bool) -> Result<(), String> {
    if agent == "pi" {
        return enable_pi_extension();
    }
    let spec = find(&agent)?;
    let path = settings_path(spec)?;
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => existing_config(Some(&s), &path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };

    let merged = merge_hooks(existing, spec, follow);
    let out = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    write_atomic(&path, &out)
}

/// Brings an existing install up to the current hook set without installing
/// anything for someone who never opted in. Returns whether the file changed.
#[tauri::command]
pub fn agent_upgrade_hooks(agent: String) -> Result<bool, String> {
    let Ok(spec) = find(&agent) else {
        return Ok(false);
    };
    let path = settings_path(spec)?;
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let Some(follow) = upgrade_follow_choice(spec, &content) else {
        return Ok(false);
    };
    let merged = merge_hooks(existing_config(Some(&content), &path)?, spec, follow);
    let out = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    write_atomic(&path, &out)?;
    Ok(true)
}

// Some(follow) when an opted-in install is missing a hook. The follow choice is
// read back from the file so an upgrade never flips it either way.
fn upgrade_follow_choice(spec: &AgentSpec, content: &str) -> Option<bool> {
    if !notify_hooks_installed(spec, content) || session_hooks_installed(spec, content) {
        return None;
    }
    Some(follow_hook_installed(spec, content))
}

fn session_hooks_installed(spec: &AgentSpec, content: &str) -> bool {
    spec.events
        .iter()
        .filter(|h| h.kind == HookKind::Session)
        .all(|h| content.contains(&status_needle(spec, h)))
}

// The raw OSC 777 bytes the detector parses. Kept in one place so the Windows
// CONOUT$ path can't drift from what the Unix /dev/tty hook emits.
#[cfg(any(windows, test))]
fn conout_marker(agent: &str, event: &str) -> String {
    format!("\x1b]777;notify;Terax;{agent};{event}\x07")
}

// Windows has no /dev/tty: the hook calls `terax.exe __terax_notify ...` and we
// write the marker into the ConPTY console. GUI-subsystem release inherits no
// console, so attach to the hook runner's first.
#[cfg(windows)]
pub fn emit_conout_marker(agent: &str, event: &str) {
    use std::io::Write;
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};

    if std::env::var_os("TERAX_TERMINAL").is_none() {
        return;
    }
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("CONOUT$")
    {
        let _ = f.write_all(conout_marker(agent, event).as_bytes());
    }
}

#[tauri::command]
pub fn agent_hooks_status(agent: String) -> bool {
    if agent == "pi" {
        return pi_extension_path()
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .is_some_and(|content| {
                PI_STATUS_NEEDLES
                    .iter()
                    .all(|needle| content.contains(needle))
            });
    }
    let Ok(spec) = find(&agent) else {
        return false;
    };
    let Some(content) = settings_path(spec)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    notify_hooks_installed(spec, &content)
}

// Notify hooks only, for two reasons: the bell has to keep meaning
// "notifications are installed", and counting the follow hook would report
// "off" for everyone installed before it existed. The follow hook is not
// invisible as a result; agent_follow_hook_status reports it separately.
fn notify_hooks_installed(spec: &AgentSpec, content: &str) -> bool {
    spec.events
        .iter()
        .filter(|h| h.kind == HookKind::Notify)
        .all(|h| content.contains(&status_needle(spec, h)))
}

#[tauri::command]
pub fn agent_follow_hook_status(agent: String) -> bool {
    let Ok(spec) = find(&agent) else {
        return false;
    };
    let Some(content) = settings_path(spec)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    follow_hook_installed(spec, &content)
}

// `any` rather than `all` so agents without a follow hook answer false instead
// of a vacuous true, and the frontend can query every agent the same way.
fn follow_hook_installed(spec: &AgentSpec, content: &str) -> bool {
    spec.events
        .iter()
        .filter(|h| h.kind == HookKind::Follow)
        .any(|h| content.contains(&status_needle(spec, h)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(agent: &str) -> &'static AgentSpec {
        find(agent).unwrap()
    }

    fn hook(agent: &str, event: &str) -> &'static HookSpec {
        spec(agent)
            .events
            .iter()
            .find(|h| h.event == event)
            .unwrap()
    }

    fn hook_count(root: &Value, event: &str) -> usize {
        root["hooks"][event].as_array().map_or(0, Vec::len)
    }

    fn command(root: &Value, event: &str, idx: usize) -> String {
        root["hooks"][event][idx]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn claude_adds_all_event_hooks_to_empty_config() {
        let out = merge_hooks(json!({}), spec("claude"), true);
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        assert!(command(&out, "Notification", 0).contains("notify;Terax;attention"));
        assert!(command(&out, "Stop", 0).contains("notify;Terax;finished"));
        assert!(command(&out, "UserPromptSubmit", 0).contains("notify;Terax;working"));
        assert!(command(&out, "Stop", 0).contains("terminalSequence"));
        assert!(!command(&out, "Stop", 0).contains("/dev/tty"));
    }

    #[test]
    fn claude_installs_a_cwd_changed_follow_hook() {
        let out = merge_hooks(json!({}), spec("claude"), true);
        assert_eq!(hook_count(&out, "CwdChanged"), 1);
        let cmd = command(&out, "CwdChanged", 0);
        assert!(cmd.contains("cd --terax-follow-hook"));
        assert!(cmd.contains("$TERAX_CLI"));
        // WSL panes set TERAX_TERMINAL but have no CLI, so guarding on it would
        // make every directory change print "command not found".
        assert!(!cmd.contains("TERAX_TERMINAL"));
    }

    #[test]
    fn claude_installs_a_silent_session_start_hook() {
        let out = merge_hooks(json!({}), spec("claude"), false);
        assert_eq!(hook_count(&out, "SessionStart"), 1);
        let cmd = command(&out, "SessionStart", 0);
        assert!(cmd.contains("agent-session --terax-session-hook"));
        assert!(cmd.contains("$TERAX_CLI"));
        assert!(cmd.ends_with("|| true"));
        assert!(!cmd.contains("printf"));
        assert!(!cmd.contains("echo"));
    }

    #[test]
    fn upgrade_adds_the_session_hook_to_an_opted_in_install_only() {
        let s = spec("claude");
        let legacy = |follow: bool| {
            let mut root = merge_hooks(json!({}), s, follow);
            root["hooks"].as_object_mut().unwrap().shift_remove("SessionStart");
            serde_json::to_string(&root).unwrap()
        };
        assert_eq!(upgrade_follow_choice(s, &legacy(true)), Some(true));
        assert_eq!(upgrade_follow_choice(s, &legacy(false)), Some(false));

        let current = serde_json::to_string(&merge_hooks(json!({}), s, true)).unwrap();
        assert_eq!(upgrade_follow_choice(s, &current), None);
        assert_eq!(upgrade_follow_choice(s, "{}"), None);
        assert_eq!(upgrade_follow_choice(s, r#"{"permissions":{}}"#), None);
        // Codex has no session hook, so an install there never needs upgrading.
        let codex = serde_json::to_string(&merge_hooks(json!({}), spec("codex"), true)).unwrap();
        assert_eq!(upgrade_follow_choice(spec("codex"), &codex), None);
    }

    #[test]
    fn upgrade_keeps_the_follow_choice_found_in_the_file() {
        let s = spec("claude");
        let mut root = merge_hooks(json!({}), s, false);
        root["hooks"].as_object_mut().unwrap().shift_remove("SessionStart");
        let follow = upgrade_follow_choice(s, &root.to_string()).unwrap();
        let upgraded = merge_hooks(root, s, follow);
        assert_eq!(hook_count(&upgraded, "SessionStart"), 1);
        assert_eq!(hook_count(&upgraded, "CwdChanged"), 0);
        assert!(notify_hooks_installed(s, &upgraded.to_string()));
    }

    #[test]
    fn hooks_status_ignores_the_follow_hook() {
        let s = spec("claude");
        let notify_only: String = s
            .events
            .iter()
            .filter(|h| h.kind == HookKind::Notify)
            .map(|h| hook_command(s, h))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(notify_hooks_installed(s, &notify_only));
    }

    #[test]
    fn foreign_hooks_on_a_terax_event_survive() {
        let input = json!({
            "hooks": {
                "Stop": [
                    { "hooks": [ { "type": "command", "command": "my-typecheck.sh" } ] }
                ]
            }
        });
        let out = merge_hooks(input, spec("claude"), true);
        assert_eq!(hook_count(&out, "Stop"), 2);
        assert_eq!(command(&out, "Stop", 0), "my-typecheck.sh");
        assert!(command(&out, "Stop", 1).contains("notify;Terax;finished"));
    }

    #[test]
    fn disabling_follow_removes_an_installed_follow_hook() {
        let s = spec("claude");
        let installed = merge_hooks(json!({}), s, true);
        assert_eq!(hook_count(&installed, "CwdChanged"), 1);

        let out = merge_hooks(installed, s, false);
        assert_eq!(hook_count(&out, "CwdChanged"), 0);
        assert!(out["hooks"].get("CwdChanged").is_none());
        for event in ["UserPromptSubmit", "Notification", "Stop"] {
            assert_eq!(hook_count(&out, event), 1, "{event}");
        }
        assert!(command(&out, "Stop", 0).contains("notify;Terax;finished"));
    }

    #[test]
    fn disabling_follow_on_a_clean_config_installs_only_notify_hooks() {
        let out = merge_hooks(json!({}), spec("claude"), false);
        assert!(out["hooks"].get("CwdChanged").is_none());
        for event in ["UserPromptSubmit", "Notification", "Stop"] {
            assert_eq!(hook_count(&out, event), 1, "{event}");
        }
    }

    #[test]
    fn toggling_follow_converges_each_time() {
        let s = spec("claude");
        let on = merge_hooks(json!({}), s, true);
        let off = merge_hooks(on.clone(), s, false);
        let on_again = merge_hooks(off.clone(), s, true);

        assert_eq!(on, on_again);
        assert_eq!(off, merge_hooks(on_again.clone(), s, false));
        for h in s.events {
            assert_eq!(hook_count(&on_again, h.event), 1, "{}", h.event);
        }
    }

    #[test]
    fn disabling_follow_keeps_a_users_own_cwd_changed_hook() {
        let input = json!({
            "hooks": {
                "CwdChanged": [
                    { "hooks": [ { "type": "command", "command": "my-cd-notify.sh" } ] }
                ]
            }
        });
        let out = merge_hooks(input, spec("claude"), false);
        assert_eq!(hook_count(&out, "CwdChanged"), 1);
        assert_eq!(command(&out, "CwdChanged", 0), "my-cd-notify.sh");
    }

    #[test]
    fn follow_hook_status_tracks_the_follow_command_only() {
        let s = spec("claude");
        let notify_only: String = s
            .events
            .iter()
            .filter(|h| h.kind == HookKind::Notify)
            .map(|h| hook_command(s, h))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!follow_hook_installed(s, &notify_only));
        assert!(follow_hook_installed(
            s,
            &format!("{notify_only}\n{}", follow_command())
        ));
        // Codex has no follow hook, so it answers false instead of a vacuous true.
        assert!(!follow_hook_installed(spec("codex"), &follow_command()));
    }

    #[test]
    fn is_idempotent_per_agent() {
        for agent in ["claude", "codex", "gemini"] {
            let s = spec(agent);
            let once = merge_hooks(json!({}), s, true);
            let twice = merge_hooks(once.clone(), s, true);
            assert_eq!(once, twice, "{agent} not idempotent");
            for h in s.events {
                assert_eq!(hook_count(&twice, h.event), 1, "{agent} {}", h.event);
            }
        }
    }

    #[test]
    fn conout_marker_matches_detector_format() {
        // Exactly the bytes pty/agent_detect parses (ESC ] 777 ; ... BEL).
        assert_eq!(
            conout_marker("gemini", "attention"),
            "\u{1b}]777;notify;Terax;gemini;attention\u{7}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_emits_four_field_dev_tty_marker() {
        let out = merge_hooks(json!({}), spec("codex"), true);
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "PermissionRequest"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        let stop = command(&out, "Stop", 0);
        assert!(stop.contains("notify;Terax;codex;finished"));
        assert!(stop.contains("> /dev/tty"));
        // Codex Stop rejects empty/non-JSON stdout; the hook must emit a no-op.
        assert!(stop.contains("printf '{}'"));
        assert!(!stop.contains("terminalSequence"));
    }

    #[cfg(unix)]
    #[test]
    fn gemini_uses_matcher_and_named_marker() {
        let out = merge_hooks(json!({}), spec("gemini"), true);
        assert_eq!(out["hooks"]["BeforeAgent"][0]["matcher"], "*");
        assert!(command(&out, "AfterAgent", 0).contains("notify;Terax;gemini;finished"));
        assert!(command(&out, "Notification", 0).contains("notify;Terax;gemini;attention"));
    }

    #[test]
    fn pi_extension_emits_named_working_and_finished_markers() {
        let path = std::path::Path::new("/x/terax-notifications.ts");
        let extension = pi_extension_contents(None, path).unwrap();
        for needle in PI_STATUS_NEEDLES {
            assert!(extension.contains(needle), "missing {needle}");
        }
        assert!(extension.contains("process.env.TERAX_TERMINAL"));
        assert!(extension.contains("process.stdout.write"));
    }

    #[test]
    fn pi_extension_only_replaces_terax_owned_file() {
        let path = std::path::Path::new("/x/terax-notifications.ts");
        assert!(pi_extension_contents(Some("export const mine = true;"), path).is_err());
        assert!(pi_extension_contents(Some(PI_EXTENSION), path).is_ok());
        assert!(pi_extension_contents(Some("  \n"), path).is_ok());
    }

    #[test]
    fn pi_extension_install_is_atomic_idempotent_and_preserves_foreign_files() {
        let dir = std::env::temp_dir().join(format!("terax-pi-extension-{}", std::process::id()));
        let path = dir.join(PI_EXTENSION_FILE);
        let _ = std::fs::remove_dir_all(&dir);

        enable_pi_extension_at(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), PI_EXTENSION);
        enable_pi_extension_at(&path).unwrap();

        std::fs::write(&path, "export const mine = true;").unwrap();
        assert!(enable_pi_extension_at(&path).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "export const mine = true;"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pi_extension_install_preserves_symlink() {
        use std::os::unix::fs::symlink;

        let dir =
            std::env::temp_dir().join(format!("terax-pi-extension-symlink-{}", std::process::id()));
        let target = dir.join("managed.ts");
        let path = dir.join(PI_EXTENSION_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&target, format!("// {PI_EXTENSION_MARKER}\n")).unwrap();
        symlink(&target, &path).unwrap();

        enable_pi_extension_at(&path).unwrap();

        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(target).unwrap(), PI_EXTENSION);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn settings_writes_follow_a_symlink_and_keep_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("dotfiles-settings.json");
        let link = dir.path().join("settings.json");
        std::fs::write(&target, "{}").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&target, &link).unwrap();

        write_atomic(&link, r#"{"hooks":{}}"#).unwrap();

        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), r#"{"hooks":{}}"#);
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(!dir.path().join("dotfiles-settings.terax-tmp").exists());
    }

    #[test]
    fn removing_the_follow_hook_keeps_the_other_events_in_place() {
        let s = spec("claude");
        let input = json!({
            "hooks": {
                "PreToolUse": [ { "hooks": [ { "type": "command", "command": "a.sh" } ] } ],
                "CwdChanged": [ { "hooks": [ { "type": "command", "command": follow_command() } ] } ],
                "Mine": [ { "hooks": [ { "type": "command", "command": "b.sh" } ] } ],
                "Last": [ { "hooks": [ { "type": "command", "command": "c.sh" } ] } ]
            }
        });
        let out = merge_hooks(input, s, false);
        let keys: Vec<&String> = out["hooks"].as_object().unwrap().keys().collect();
        assert_eq!(keys[..3], ["PreToolUse", "Mine", "Last"]);
        assert!(out["hooks"].get("CwdChanged").is_none());
    }

    #[test]
    fn rewriting_settings_keeps_the_users_key_order() {
        let input: Value = serde_json::from_str(
            r#"{"model":"opus","permissions":{"allow":[]},"env":{"Z":"1","A":"2"}}"#,
        )
        .unwrap();
        let out = merge_hooks(input, spec("claude"), false);
        let keys: Vec<&String> = out.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["model", "permissions", "env", "hooks"]);
        let env: Vec<&String> = out["env"].as_object().unwrap().keys().collect();
        assert_eq!(env, ["Z", "A"]);
    }

    #[test]
    fn migrates_legacy_dev_tty_hook() {
        let legacy = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [ {
                        "type": "command",
                        "command": "[ -n \"$TERAX_TERMINAL\" ] && printf '\\033]777;terax;notify\\033\\\\' > /dev/tty || true"
                    } ] }
                ]
            }
        });
        let out = merge_hooks(legacy, spec("claude"), true);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("terminalSequence"));
        assert!(!command(&out, "Notification", 0).contains("/dev/tty"));
    }

    #[test]
    fn preserves_unrelated_settings_and_foreign_hooks() {
        let input = json!({
            "permissions": { "allow": ["Bash"] },
            "hooks": {
                "Notification": [
                    { "hooks": [ { "type": "command", "command": "say hi" } ] }
                ]
            }
        });
        let out = merge_hooks(input, spec("claude"), true);
        assert_eq!(out["permissions"]["allow"][0], "Bash");
        assert_eq!(hook_count(&out, "Notification"), 2);
        assert_eq!(command(&out, "Notification", 0), "say hi");
    }

    #[test]
    fn replaces_non_object_root() {
        let out = merge_hooks(json!("garbage"), spec("codex"), true);
        assert_eq!(hook_count(&out, "Stop"), 1);
    }

    #[test]
    fn prunes_empty_groups_and_collapses_duplicates() {
        let input = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [] },
                    { "hooks": [ { "type": "command", "command": hook_command(spec("claude"), hook("claude", "Notification")) } ] }
                ]
            }
        });
        let out = merge_hooks(input, spec("claude"), true);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("notify;Terax;attention"));
    }

    #[test]
    fn existing_config_absent_or_empty_starts_fresh() {
        let p = std::path::Path::new("/x/settings.json");
        assert_eq!(existing_config(None, p).unwrap(), json!({}));
        assert_eq!(existing_config(Some("   \n"), p).unwrap(), json!({}));
    }

    #[test]
    fn existing_config_refuses_to_clobber_invalid_json() {
        let p = std::path::Path::new("/x/settings.json");
        assert!(existing_config(Some("{ not json,"), p).is_err());
        assert_eq!(
            existing_config(Some(r#"{"permissions":{}}"#), p).unwrap(),
            json!({ "permissions": {} })
        );
    }
}
