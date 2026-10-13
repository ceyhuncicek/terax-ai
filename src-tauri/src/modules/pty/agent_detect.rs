const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const OSC_INTRO: u8 = b']';
const ST_FINAL: u8 = b'\\';

const OSC_MAX: usize = 2048;
const COMMAND_MAX: usize = 512;
// Launchers that run the next word as the program.
const WRAPPERS: &[&str] = &["npx", "bunx", "pnpx", "env", "command", "exec", "time", "nohup"];

const DEFAULT_AGENTS: &[&str] = &["claude", "codex", "gemini", "pi", "opencode", "grok"];

// OSC 777 marker our agent hooks emit. Legacy 3-field `notify;Terax;<event>`
// (Claude) or 4-field `notify;Terax;<agent>;<event>` (Codex/Gemini/Pi).
const TERAX_MARKER: &[u8] = b"notify;Terax;";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Status {
    Working,
    Waiting,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Transition {
    // `command` is the OSC 133;C command line, absent when a hook marker self-armed.
    Started { agent: String, command: Option<String> },
    Working,
    Attention,
    Finished,
    // `closed` when the PTY went away under the agent rather than the command ending.
    Exited { closed: bool },
}

#[derive(Clone, serde::Serialize)]
pub struct AgentSignal {
    pub id: u32,
    pub kind: &'static str,
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub closed: bool,
}

impl Transition {
    pub fn into_signal(self, id: u32) -> AgentSignal {
        let signal = |kind| AgentSignal {
            id,
            kind,
            agent: None,
            command: None,
            closed: false,
        };
        match self {
            Transition::Started { agent, command } => AgentSignal {
                agent: Some(agent),
                command,
                ..signal("started")
            },
            Transition::Working => signal("working"),
            Transition::Attention => signal("attention"),
            Transition::Finished => signal("finished"),
            Transition::Exited { closed } => AgentSignal { closed, ..signal("exited") },
        }
    }
}

pub struct AgentDetector {
    agents: Vec<String>,
    state: State,
    osc: Vec<u8>,
    armed: bool,
    status: Status,
}

impl AgentDetector {
    pub fn new() -> Self {
        Self::with_agents(DEFAULT_AGENTS.iter().map(|s| s.to_string()).collect())
    }

    pub fn with_agents(agents: Vec<String>) -> Self {
        Self {
            agents,
            state: State::Ground,
            osc: Vec::new(),
            armed: false,
            status: Status::Working,
        }
    }

    /// Feed a chunk of raw PTY output. Transitions come only from OSC sequences
    /// (`133` prompt boundaries, our `777` hook marker), never from raw output,
    /// so a TUI agent that repaints continuously never flaps working/waiting.
    pub fn process<F: FnMut(Transition)>(&mut self, input: &[u8], mut emit: F) {
        if self.state == State::Ground && !input.contains(&ESC) {
            return;
        }

        for &b in input {
            match self.state {
                State::Ground => {
                    if b == ESC {
                        self.state = State::Esc;
                    }
                }
                State::Esc => match b {
                    OSC_INTRO => {
                        self.state = State::Osc;
                        self.osc.clear();
                    }
                    ESC => {}
                    _ => self.state = State::Ground,
                },
                State::Osc => match b {
                    BEL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => self.state = State::OscEsc,
                    _ => {
                        if self.osc.len() < OSC_MAX {
                            self.osc.push(b);
                        } else {
                            self.osc.clear();
                            self.state = State::Ground;
                        }
                    }
                },
                State::OscEsc => match b {
                    ST_FINAL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => {}
                    _ => {
                        self.osc.clear();
                        self.state = State::Ground;
                    }
                },
            }
        }
    }

    /// Called when the underlying PTY closes. Reports the agent as exited so the
    /// UI doesn't leave a stale entry if the shell died mid-command. Flagged as
    /// closed: app quit, reload and tab close end here, and none of them mean the
    /// user finished with the agent.
    pub fn finish<F: FnMut(Transition)>(&mut self, mut emit: F) {
        if self.armed {
            self.disarm();
            emit(Transition::Exited { closed: true });
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
        self.status = Status::Working;
    }

    fn finish_osc<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        let body = std::mem::take(&mut self.osc);
        let (ps, pt) = match body.iter().position(|&c| c == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (&body[..], &body[0..0]),
        };
        match ps {
            b"133" => self.handle_osc133(pt, emit),
            // OSC 9;4 is taskbar progress, not a notification.
            b"9" if !pt.starts_with(b"4;") && pt != b"4" => self.generic_attention(emit),
            b"777" => self.handle_osc777(pt, emit),
            _ => {}
        }
    }

    fn handle_osc777<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        if let Some(tail) = pt.strip_prefix(TERAX_MARKER) {
            // PTY output is untrusted: only self-arm for known agents.
            let (agent, event) = match tail.iter().position(|&c| c == b';') {
                Some(i) => {
                    let Ok(name) = std::str::from_utf8(&tail[..i]) else {
                        return;
                    };
                    if !self.agents.iter().any(|a| a == name) {
                        return;
                    }
                    (name, &tail[i + 1..])
                }
                None => ("claude", tail),
            };
            // Self-arms when no shell preexec fired (bash, Windows, tmux).
            match event {
                b"working" => {
                    self.ensure_armed(agent, emit);
                    self.set_working(emit);
                }
                b"attention" => {
                    self.ensure_armed(agent, emit);
                    self.status = Status::Waiting;
                    emit(Transition::Attention);
                }
                b"finished" => {
                    self.ensure_armed(agent, emit);
                    self.status = Status::Waiting;
                    emit(Transition::Finished);
                }
                _ => {}
            }
            return;
        }
        self.generic_attention(emit);
    }

    fn handle_osc133<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        match pt.first() {
            Some(b'C') => {
                if self.armed {
                    return;
                }
                let cmd = pt.strip_prefix(b"C;").unwrap_or(b"");
                if let Some(agent) = self.match_agent(cmd) {
                    self.armed = true;
                    self.status = Status::Working;
                    emit(Transition::Started { agent, command: command_text(cmd) });
                }
            }
            Some(b'D') if self.armed => {
                self.disarm();
                emit(Transition::Exited { closed: false });
            }
            _ => {}
        }
    }

    fn ensure_armed<F: FnMut(Transition)>(&mut self, agent: &str, emit: &mut F) {
        if !self.armed {
            self.armed = true;
            self.status = Status::Working;
            emit(Transition::Started { agent: agent.to_string(), command: None });
        }
    }

    fn set_working<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.status != Status::Working {
            self.status = Status::Working;
            emit(Transition::Working);
        }
    }

    fn generic_attention<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.armed {
            self.status = Status::Waiting;
            emit(Transition::Attention);
        }
    }

    // Only the program token names the agent: `brew upgrade claude` or
    // `man codex` mention one without running it.
    fn match_agent(&self, cmd: &[u8]) -> Option<String> {
        let cmd = std::str::from_utf8(cmd).ok()?;
        let mut tokens = cmd.split_whitespace().peekable();
        while tokens
            .next_if(|t| t.contains('=') && !t.starts_with('-'))
            .is_some()
        {}
        if tokens.next_if(|t| WRAPPERS.contains(t)).is_some() {
            while tokens
                .next_if(|t| t.starts_with('-') || t.contains('='))
                .is_some()
            {}
        }
        let program = tokens.next()?;
        if program.contains('=') {
            return None;
        }
        let base = program.rsplit(['/', '\\']).next().unwrap_or(program);
        self.agents
            .iter()
            .find(|a| {
                base.strip_prefix(a.as_str())
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
            })
            .cloned()
    }
}

// Untrimmed: shells cap the line at 256 characters, and the UI can only tell a
// cut-off command by its exact length.
fn command_text(cmd: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(cmd).ok()?;
    (!text.trim().is_empty() && text.len() <= COMMAND_MAX).then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(d: &mut AgentDetector, input: &[u8]) -> Vec<Transition> {
        let mut out = Vec::new();
        d.process(input, |t| out.push(t));
        out
    }

    fn osc(body: &str) -> Vec<u8> {
        let mut v = vec![ESC, OSC_INTRO];
        v.extend_from_slice(body.as_bytes());
        v.extend_from_slice(&[ESC, ST_FINAL]);
        v
    }

    fn started(agent: &str) -> Transition {
        Transition::Started { agent: agent.into(), command: None }
    }

    fn launched(agent: &str, command: &str) -> Transition {
        Transition::Started { agent: agent.into(), command: Some(command.into()) }
    }

    #[test]
    fn arms_on_agent_command() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;claude -p hello")),
            vec![launched("claude", "claude -p hello")]
        );
    }

    #[test]
    fn arms_on_pi_command() {
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("133;C;pi")), vec![launched("pi", "pi")]);
    }

    #[test]
    fn arms_on_opencode_and_grok_commands() {
        for agent in ["opencode", "grok"] {
            let mut d = AgentDetector::new();
            assert_eq!(
                run(&mut d, &osc(&format!("133;C;{agent}"))),
                vec![launched(agent, agent)]
            );
        }
    }

    #[test]
    fn arms_on_pathed_and_wrapped_command() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;/usr/local/bin/codex exec")),
            vec![launched("codex", "/usr/local/bin/codex exec")]
        );
        let mut d2 = AgentDetector::new();
        assert_eq!(
            run(&mut d2, &osc("133;C;npx claude")),
            vec![launched("claude", "npx claude")]
        );
    }

    #[test]
    fn arms_on_dash_suffixed_alias() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;claude-enigma")),
            vec![launched("claude", "claude-enigma")]
        );
    }

    #[test]
    fn does_not_arm_on_other_commands() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("133;C;vim src/main.rs")).is_empty());
        assert!(run(&mut d, &osc("133;C;cat claude.txt")).is_empty());
        assert!(run(&mut d, &osc("133;C;claudexyz")).is_empty());
    }

    #[test]
    fn mentions_of_an_agent_outside_the_program_slot_do_not_arm() {
        for cmd in [
            "brew upgrade claude",
            "which claude",
            "man codex",
            "ls pi",
            "git log -- claude",
            "npx -y prettier claude.md",
        ] {
            let mut d = AgentDetector::new();
            assert!(run(&mut d, &osc(&format!("133;C;{cmd}"))).is_empty(), "{cmd}");
        }
    }

    #[test]
    fn wrappers_and_assignments_before_the_program_still_arm() {
        for (cmd, agent) in [
            ("env FOO=1 claude", "claude"),
            ("env -i PATH=/bin codex exec", "codex"),
            ("command claude --resume x", "claude"),
            ("exec gemini", "gemini"),
            ("time claude", "claude"),
            ("nohup opencode", "opencode"),
            ("bunx claude", "claude"),
            ("A=1 B=2 /opt/bin/claude", "claude"),
        ] {
            let mut d = AgentDetector::new();
            assert_eq!(
                run(&mut d, &osc(&format!("133;C;{cmd}"))),
                vec![launched(agent, cmd)],
                "{cmd}"
            );
        }
    }

    #[test]
    fn env_assignments_are_not_the_agent() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("133;C;PATH=/tmp/evil/claude make")).is_empty());
        assert_eq!(
            run(&mut d, &osc("133;C;ANTHROPIC_MODEL=opus claude")),
            vec![launched("claude", "ANTHROPIC_MODEL=opus claude")]
        );
    }

    #[test]
    fn ignores_bell_and_plain_output() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert!(run(&mut d, &[BEL]).is_empty());
        assert!(run(&mut d, b"thinking...\x07more").is_empty());
    }

    #[test]
    fn terax_marker_drives_status() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(run(&mut d, &osc("777;notify;Terax;attention")), vec![Transition::Attention]);
        assert_eq!(run(&mut d, &osc("777;notify;Terax;working")), vec![Transition::Working]);
        assert!(run(&mut d, &osc("777;notify;Terax;working")).is_empty());
        assert_eq!(run(&mut d, &osc("777;notify;Terax;finished")), vec![Transition::Finished]);
    }

    #[test]
    fn terax_marker_auto_arms_without_preexec() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("777;notify;Terax;attention")),
            vec![started("claude"), Transition::Attention]
        );
    }

    #[test]
    fn four_field_marker_self_arms_named_agent() {
        // Fresh arm already implies Working, so `working` emits only Started.
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("777;notify;Terax;codex;working")), vec![started("codex")]);
        let mut g = AgentDetector::new();
        assert_eq!(
            run(&mut g, &osc("777;notify;Terax;gemini;finished")),
            vec![started("gemini"), Transition::Finished]
        );
    }

    #[test]
    fn pi_marker_self_arms_and_drives_status() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("777;notify;Terax;pi;working")),
            vec![started("pi")]
        );
        assert_eq!(
            run(&mut d, &osc("777;notify;Terax;pi;finished")),
            vec![Transition::Finished]
        );
    }

    #[test]
    fn four_field_marker_ignores_unknown_agent() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("777;notify;Terax;evil;attention")).is_empty());
        // A known agent in the same chunk still works.
        assert_eq!(
            run(&mut d, &osc("777;notify;Terax;codex;attention")),
            vec![started("codex"), Transition::Attention]
        );
    }

    #[test]
    fn four_field_marker_drives_status_after_preexec() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;gemini"));
        assert_eq!(run(&mut d, &osc("777;notify;Terax;gemini;attention")), vec![Transition::Attention]);
        assert_eq!(run(&mut d, &osc("777;notify;Terax;gemini;working")), vec![Transition::Working]);
        assert_eq!(run(&mut d, &osc("777;notify;Terax;gemini;finished")), vec![Transition::Finished]);
    }

    #[test]
    fn generic_osc777_and_osc9_attention_only_when_armed() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("777;notify;Other;ready")).is_empty());
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(run(&mut d, &osc("777;notify;Codex;ready")), vec![Transition::Attention]);
        assert_eq!(run(&mut d, &osc("9;needs you")), vec![Transition::Attention]);
        assert!(run(&mut d, &osc("9;4;1;50")).is_empty());
    }

    #[test]
    fn exits_on_133d() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(
            run(&mut d, &osc("133;D;0")),
            vec![Transition::Exited { closed: false }]
        );
        assert!(run(&mut d, &osc("133;D;0")).is_empty());
    }

    #[test]
    fn bel_terminator_inside_osc_is_not_attention() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend_from_slice(b"0;set title");
        seq.push(BEL);
        assert!(run(&mut d, &seq).is_empty());
    }

    #[test]
    fn started_split_across_chunks() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &[ESC, OSC_INTRO]).is_empty());
        assert!(run(&mut d, b"133;C;cla").is_empty());
        let mut out = run(&mut d, b"ude");
        out.extend(run(&mut d, &[ESC, ST_FINAL]));
        assert_eq!(out, vec![launched("claude", "claude")]);
    }

    #[test]
    fn finish_reports_exited_when_armed() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut out = Vec::new();
        d.finish(|t| out.push(t));
        assert_eq!(out, vec![Transition::Exited { closed: true }]);
        let mut out2 = Vec::new();
        d.finish(|t| out2.push(t));
        assert!(out2.is_empty());
    }

    #[test]
    fn started_signal_carries_the_command_and_exit_says_how_it_ended() {
        let signal = launched("claude", "claude --model opus").into_signal(7);
        let value = serde_json::to_value(&signal).unwrap();
        assert_eq!(value["command"], "claude --model opus");
        assert!(value.get("closed").is_none());

        let closed =
            serde_json::to_value(Transition::Exited { closed: true }.into_signal(7)).unwrap();
        assert_eq!(closed["kind"], "exited");
        assert_eq!(closed["closed"], true);
        let ended =
            serde_json::to_value(Transition::Exited { closed: false }.into_signal(7)).unwrap();
        assert!(ended.get("closed").is_none());
        assert!(ended.get("command").is_none());
    }

    #[test]
    fn command_text_rejects_blank_and_oversized_commands() {
        assert_eq!(command_text(b"claude "), Some("claude ".into()));
        assert_eq!(command_text(b"   "), None);
        assert_eq!(command_text(&vec![b'a'; COMMAND_MAX + 1]), None);
        assert_eq!(command_text(&[0xff, 0xfe]), None);
    }

    #[test]
    fn oversized_osc_does_not_panic() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend(std::iter::repeat_n(b'x', OSC_MAX + 100));
        seq.extend_from_slice(&[ESC, ST_FINAL]);
        assert!(run(&mut d, &seq).is_empty());
        assert_eq!(run(&mut d, &osc("777;notify;Terax;attention")), vec![Transition::Attention]);
    }
}
