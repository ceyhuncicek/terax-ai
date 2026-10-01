use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use terax_control_protocol::{
    CallerContext, CdParams, ControlDescriptor, ControlRequest, ControlResponse, OpenParams,
    MAX_MESSAGE_BYTES, METHOD_CAPABILITIES, METHOD_CD, METHOD_IDENTIFY, METHOD_OPEN, METHOD_PING,
    PROTOCOL_VERSION, SERVER_RESPONSE_ID,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IO_TIMEOUT: Duration = Duration::from_secs(7);
const EXIT_USAGE: u8 = 2;
const EXIT_UNAVAILABLE: u8 = 3;
const EXIT_PROTOCOL: u8 = 4;
const EXIT_REQUEST: u8 = 5;
// A hook payload is a few hundred bytes, so cap the read rather than let a wedged
// or hostile producer make the CLI buffer without end.
const HOOK_INPUT_LIMIT: u64 = 1024 * 1024;
const HOOK_FLAG: &str = "--terax-follow-hook";
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, PartialEq)]
enum Action {
    Help,
    Version,
    Noop,
    Request { method: &'static str, params: Value },
}

#[derive(Debug, PartialEq)]
struct Config {
    json: bool,
    action: Action,
}

#[derive(Debug)]
struct CliError {
    code: String,
    message: String,
    exit: u8,
}

impl CliError {
    fn new(code: impl Into<String>, message: impl Into<String>, exit: u8) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            exit,
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    // A hook result parser reads stdout, so a hook invocation stays silent and
    // succeeds whatever happened; a missing app is not the agent's problem.
    let silent = hook_mode(&args);
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) if silent => ExitCode::SUCCESS,
        Err(error) => {
            let mut display_args: Vec<OsString> = env::args_os().skip(1).collect();
            let json = extract_json_flag(&mut display_args);
            if json {
                eprintln!(
                    "{}",
                    json!({
                        "ok": false,
                        "error": { "code": error.code, "message": error.message }
                    })
                );
            } else {
                eprintln!("terax: {}", error.message);
            }
            ExitCode::from(error.exit)
        }
    }
}

fn run(args: Vec<OsString>) -> Result<(), CliError> {
    let silent = hook_mode(&args);
    let config = parse_args(args)?;
    match config.action {
        Action::Help => {
            print_help();
            Ok(())
        }
        Action::Version => {
            println!("terax {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Action::Noop => Ok(()),
        Action::Request { method, params } => {
            let endpoint = load_endpoint()?;
            let caller = env::var("TERAX_PANE_ID")
                .ok()
                .and_then(|value| value.parse::<u32>().ok());
            let request = ControlRequest {
                protocol: PROTOCOL_VERSION,
                id: request_id(),
                token: endpoint.token,
                method: method.to_string(),
                params,
                caller: CallerContext { pane_id: caller },
            };
            let response = send_request(&endpoint.address, &request)?;
            if !response.ok {
                let error = response.error.unwrap_or_else(|| {
                    terax_control_protocol::ControlError::new(
                        "request_failed",
                        "Terax rejected the request",
                    )
                });
                return Err(CliError::new(error.code, error.message, EXIT_REQUEST));
            }
            let result = response.result.unwrap_or(Value::Null);
            if !silent {
                print_result(method, result, config.json);
            }
            Ok(())
        }
    }
}

fn parse_args(mut args: Vec<OsString>) -> Result<Config, CliError> {
    let json = extract_json_flag(&mut args);
    if args.is_empty() {
        return Ok(Config {
            json,
            action: Action::Help,
        });
    }

    let command = args.remove(0);
    let command_text = command.to_str();
    let action = match command_text {
        Some("help" | "--help" | "-h") => no_extra_args(args, Action::Help)?,
        Some("--version" | "-V" | "version") => no_extra_args(args, Action::Version)?,
        Some("ping") => request_without_params(args, METHOD_PING)?,
        Some("capabilities") => request_without_params(args, METHOD_CAPABILITIES)?,
        Some("identify") => request_without_params(args, METHOD_IDENTIFY)?,
        Some("open") => parse_open(args)?,
        Some("cd") => parse_cd(args)?,
        Some("--") => {
            args.insert(0, command);
            parse_open(args)?
        }
        Some(value) if value.starts_with('-') => {
            return Err(usage_error(format!("unknown option '{value}'")));
        }
        _ => {
            args.insert(0, command);
            parse_open(args)?
        }
    };
    Ok(Config { json, action })
}

fn extract_json_flag(args: &mut Vec<OsString>) -> bool {
    let mut json = false;
    let mut after_separator = false;
    args.retain(|arg| {
        if after_separator {
            return true;
        }
        if arg == "--" {
            after_separator = true;
            return true;
        }
        if arg == "--json" {
            json = true;
            return false;
        }
        true
    });
    json
}

fn hook_mode(args: &[OsString]) -> bool {
    let mut arguments = args
        .iter()
        .take_while(|arg| *arg != "--")
        .filter(|arg| *arg != "--json");
    // Only cd answers to a hook, so the flag on any other verb stays a visible usage
    // error rather than a command that silently does nothing.
    match arguments.next() {
        Some(verb) if verb == "cd" => arguments.any(|arg| arg == HOOK_FLAG),
        _ => false,
    }
}

fn no_extra_args(args: Vec<OsString>, action: Action) -> Result<Action, CliError> {
    if args.is_empty() {
        Ok(action)
    } else {
        Err(usage_error("unexpected arguments"))
    }
}

fn request_without_params(args: Vec<OsString>, method: &'static str) -> Result<Action, CliError> {
    no_extra_args(
        args,
        Action::Request {
            method,
            params: json!({}),
        },
    )
}

fn parse_open(args: Vec<OsString>) -> Result<Action, CliError> {
    let mut path: Option<OsString> = None;
    let mut line = None;
    let mut focus = true;
    let mut options = true;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        match arg.to_str() {
            Some("--") if options => options = false,
            Some("--line" | "-l") if options => {
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| usage_error("--line requires a positive integer"))?;
                let parsed = value
                    .parse::<u32>()
                    .ok()
                    .filter(|line| *line > 0)
                    .ok_or_else(|| usage_error("--line requires a positive integer"))?;
                line = Some(parsed);
            }
            Some("--no-focus") if options => focus = false,
            Some(value) if options && value.starts_with('-') => {
                return Err(usage_error(format!("unknown open option '{value}'")));
            }
            _ if path.is_none() => path = Some(arg.clone()),
            _ => return Err(usage_error("open accepts exactly one file path")),
        }
        index += 1;
    }

    let path = path.ok_or_else(|| usage_error("open requires a file path"))?;
    let canonical = std::fs::canonicalize(PathBuf::from(path)).map_err(|error| {
        CliError::new(
            "path_not_found",
            format!("cannot resolve file path: {error}"),
            EXIT_USAGE,
        )
    })?;
    if !canonical.is_file() {
        return Err(CliError::new(
            "not_a_file",
            format!("path is not a regular file: {}", canonical.display()),
            EXIT_USAGE,
        ));
    }
    let path = canonical.into_os_string().into_string().map_err(|_| {
        CliError::new(
            "non_utf8_path",
            "Terax cannot open a path that is not valid UTF-8",
            EXIT_USAGE,
        )
    })?;
    let params = serde_json::to_value(OpenParams {
        path,
        line,
        column: None,
        focus,
    })
    .map_err(|error| {
        CliError::new(
            "serialization_error",
            format!("could not encode open request: {error}"),
            EXIT_PROTOCOL,
        )
    })?;
    Ok(Action::Request {
        method: METHOD_OPEN,
        params,
    })
}

fn parse_cd(args: Vec<OsString>) -> Result<Action, CliError> {
    let mut path: Option<OsString> = None;
    let mut focus = true;
    let mut from_hook = false;
    let mut options = true;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        match arg.to_str() {
            Some("--") if options => options = false,
            Some("--no-focus") if options => focus = false,
            Some(HOOK_FLAG) if options => from_hook = true,
            Some(value) if options && value.starts_with('-') => {
                return Err(usage_error(format!("unknown cd option '{value}'")));
            }
            _ if path.is_none() => path = Some(arg.clone()),
            _ => return Err(usage_error("cd accepts exactly one directory")),
        }
        index += 1;
    }
    if from_hook && path.is_some() {
        return Err(usage_error(
            "cd takes its directory from the hook payload or the command line, not both",
        ));
    }

    let canonical = if from_hook {
        // Anything the payload cannot be trusted to name is not ours to act on, and
        // a hook has no way to report that, so stay silent instead of erroring.
        let Some(target) = read_hook_cwd() else {
            return Ok(Action::Noop);
        };
        let Ok(canonical) = std::fs::canonicalize(PathBuf::from(target)) else {
            return Ok(Action::Noop);
        };
        // The agent walks around inside one checkout constantly; only a move to
        // another repo or worktree is worth moving the view for.
        if !is_project_root(&canonical) {
            return Ok(Action::Noop);
        }
        canonical
    } else {
        let path = path.ok_or_else(|| usage_error("cd requires a directory"))?;
        let canonical = std::fs::canonicalize(PathBuf::from(path)).map_err(|error| {
            CliError::new(
                "path_not_found",
                format!("cannot resolve directory: {error}"),
                EXIT_USAGE,
            )
        })?;
        if !canonical.is_dir() {
            return Err(CliError::new(
                "not_a_directory",
                format!("path is not a directory: {}", canonical.display()),
                EXIT_USAGE,
            ));
        }
        canonical
    };
    let path = canonical.into_os_string().into_string().map_err(|_| {
        CliError::new(
            "non_utf8_path",
            "Terax cannot follow a path that is not valid UTF-8",
            EXIT_USAGE,
        )
    })?;
    let params = serde_json::to_value(CdParams { path, focus }).map_err(|error| {
        CliError::new(
            "serialization_error",
            format!("could not encode cd request: {error}"),
            EXIT_PROTOCOL,
        )
    })?;
    Ok(Action::Request {
        method: METHOD_CD,
        params,
    })
}

fn read_hook_cwd() -> Option<String> {
    let stdin = std::io::stdin();
    // A hook writes the payload and closes the pipe, but a terminal never closes, so
    // reading one would hang the shell with no output and no prompt back.
    if stdin.is_terminal() {
        return None;
    }
    let mut input = String::new();
    stdin
        .lock()
        .take(HOOK_INPUT_LIMIT)
        .read_to_string(&mut input)
        .ok()?;
    hook_cwd_from_json(&input)
}

fn hook_cwd_from_json(input: &str) -> Option<String> {
    let payload: Value = serde_json::from_str(input).ok()?;
    if payload.get("hook_event_name").and_then(Value::as_str)? != "CwdChanged" {
        return None;
    }
    let new_cwd = payload.get("new_cwd").and_then(Value::as_str)?;
    if new_cwd.is_empty() {
        return None;
    }
    if payload.get("old_cwd").and_then(Value::as_str) == Some(new_cwd) {
        return None;
    }
    Some(new_cwd.to_string())
}

fn is_project_root(dir: &Path) -> bool {
    // A linked worktree's .git is a file, not a directory, so test for presence only.
    // metadata follows symlinks, which rejects a dangling .git link.
    std::fs::metadata(dir.join(".git")).is_ok()
}

fn usage_error(message: impl Into<String>) -> CliError {
    CliError::new("usage", message, EXIT_USAGE)
}

fn load_endpoint() -> Result<ControlDescriptor, CliError> {
    let env_address = env::var("TERAX_CONTROL_ADDR").ok();
    let env_token = env::var("TERAX_CONTROL_TOKEN").ok();
    let (descriptor, require_live_process) = match (env_address, env_token) {
        (Some(address), Some(token)) => (
            ControlDescriptor {
                protocol: PROTOCOL_VERSION,
                address,
                token,
                pid: 0,
                app_version: String::new(),
            },
            false,
        ),
        (None, None) => {
            let path = dirs::cache_dir()
                .map(|dir| dir.join("terax").join("control.json"))
                .ok_or_else(|| {
                    CliError::new(
                        "app_unavailable",
                        "could not locate the user cache directory",
                        EXIT_UNAVAILABLE,
                    )
                })?;
            let bytes = std::fs::read(&path).map_err(|_| {
                CliError::new(
                    "app_unavailable",
                    "Terax is not running; start the app and try again",
                    EXIT_UNAVAILABLE,
                )
            })?;
            let descriptor = serde_json::from_slice(&bytes).map_err(|error| {
                CliError::new(
                    "invalid_descriptor",
                    format!("invalid Terax control descriptor: {error}"),
                    EXIT_PROTOCOL,
                )
            })?;
            (descriptor, true)
        }
        _ => {
            return Err(CliError::new(
                "invalid_environment",
                "TERAX_CONTROL_ADDR and TERAX_CONTROL_TOKEN must be set together",
                EXIT_PROTOCOL,
            ));
        }
    };
    validate_endpoint(descriptor, require_live_process)
}

fn validate_endpoint(
    descriptor: ControlDescriptor,
    require_live_process: bool,
) -> Result<ControlDescriptor, CliError> {
    if descriptor.protocol != PROTOCOL_VERSION {
        return Err(CliError::new(
            "unsupported_protocol",
            format!(
                "Terax uses control protocol {}, but this CLI supports {PROTOCOL_VERSION}",
                descriptor.protocol
            ),
            EXIT_PROTOCOL,
        ));
    }
    if descriptor.token.len() != 64
        || !descriptor
            .token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(CliError::new(
            "invalid_endpoint",
            "Terax control token is invalid",
            EXIT_PROTOCOL,
        ));
    }
    parse_loopback_address(&descriptor.address)?;
    if require_live_process && !process_is_alive(descriptor.pid) {
        return Err(CliError::new(
            "invalid_endpoint",
            "Terax control process is not running",
            EXIT_PROTOCOL,
        ));
    }
    Ok(descriptor)
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if !handle.is_null() {
            CloseHandle(handle);
            true
        } else {
            GetLastError() == ERROR_ACCESS_DENIED
        }
    }
}

fn send_request(address: &str, request: &ControlRequest) -> Result<ControlResponse, CliError> {
    let address = parse_loopback_address(address)?;
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(|error| {
        CliError::new(
            "app_unavailable",
            format!("could not connect to Terax: {error}"),
            EXIT_UNAVAILABLE,
        )
    })?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok();
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok();
    write_request(&mut stream, request)?;

    let mut reader = BufReader::new(stream);
    read_response(&mut reader, request)
}

fn parse_loopback_address(address: &str) -> Result<SocketAddr, CliError> {
    let address: SocketAddr = address.parse().map_err(|error| {
        CliError::new(
            "invalid_endpoint",
            format!("invalid Terax control address: {error}"),
            EXIT_PROTOCOL,
        )
    })?;
    if !address.ip().is_loopback() {
        return Err(CliError::new(
            "invalid_endpoint",
            "Terax control address must be loopback-only",
            EXIT_PROTOCOL,
        ));
    }
    Ok(address)
}

fn write_request(writer: &mut impl Write, request: &ControlRequest) -> Result<(), CliError> {
    serde_json::to_writer(&mut *writer, request).map_err(|error| {
        CliError::new(
            "serialization_error",
            format!("could not encode request: {error}"),
            EXIT_PROTOCOL,
        )
    })?;
    writer.write_all(b"\n").map_err(io_error)?;
    writer.flush().map_err(io_error)
}

fn read_response(
    reader: &mut impl BufRead,
    request: &ControlRequest,
) -> Result<ControlResponse, CliError> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((MAX_MESSAGE_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(io_error)?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(CliError::new(
            "message_too_large",
            "Terax response exceeded the protocol limit",
            EXIT_PROTOCOL,
        ));
    }
    if bytes.last() != Some(&b'\n') {
        return Err(CliError::new(
            "invalid_response",
            "Terax returned an incomplete response",
            EXIT_PROTOCOL,
        ));
    }
    let response: ControlResponse = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::new(
            "invalid_response",
            format!("Terax returned invalid JSON: {error}"),
            EXIT_PROTOCOL,
        )
    })?;
    let matched_id =
        response.id == request.id || (!response.ok && response.id == SERVER_RESPONSE_ID);
    if response.protocol != PROTOCOL_VERSION || !matched_id {
        return Err(CliError::new(
            "invalid_response",
            "Terax returned a mismatched protocol version or request id",
            EXIT_PROTOCOL,
        ));
    }
    Ok(response)
}

fn io_error(error: std::io::Error) -> CliError {
    CliError::new(
        "io_error",
        format!("control connection failed: {error}"),
        EXIT_UNAVAILABLE,
    )
}

fn request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{nanos}-{sequence}", std::process::id())
}

fn print_result(method: &str, result: Value, as_json: bool) {
    if as_json {
        println!("{}", json!({ "ok": true, "result": result }));
        return;
    }
    match method {
        METHOD_PING => {
            let version = result
                .get("app_version")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            println!("Terax {version} is running");
        }
        METHOD_CAPABILITIES => {
            if let Some(methods) = result.get("methods").and_then(Value::as_array) {
                for method in methods.iter().filter_map(Value::as_str) {
                    println!("{method}");
                }
            }
        }
        METHOD_IDENTIFY => {
            let space = result
                .get("space_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let tab = result
                .get("tab_id")
                .and_then(Value::as_u64)
                .map_or_else(|| "none".to_string(), |id| id.to_string());
            let pane = result
                .get("pane_id")
                .and_then(Value::as_u64)
                .map_or_else(|| "none".to_string(), |id| id.to_string());
            println!("space={space} tab={tab} pane={pane}");
        }
        METHOD_OPEN => {
            let path = result.get("path").and_then(Value::as_str).unwrap_or("");
            let line = result.get("line").and_then(Value::as_u64);
            if let Some(line) = line {
                println!("Opened {path}:{line} in Terax");
            } else {
                println!("Opened {path} in Terax");
            }
        }
        METHOD_CD => {
            let path = result.get("path").and_then(Value::as_str).unwrap_or("");
            // A background pane gets a tab but no view switch, so say so rather
            // than claiming Terax is following the directory.
            if result
                .get("activated")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                println!("Now following {path} in Terax");
            } else {
                println!("Terax opened {path} in a background tab");
            }
        }
        _ => println!("{result}"),
    }
}

fn print_help() {
    println!(
        "Terax command line interface\n\n\
Usage:\n  terax <file> [--line <n>] [--no-focus] [--json]\n  terax open <file> [--line <n>] [--no-focus] [--json]\n  terax cd <dir> [--no-focus] [--json]\n  terax ping [--json]\n  terax capabilities [--json]\n  terax identify [--json]\n  terax --version\n\n\
The app must be running. Commands launched in a Terax pane target that pane's space."
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_transport_commands() {
        let config = parse_args(args(&["ping", "--json"])).expect("parse ping");
        assert!(config.json);
        assert_eq!(
            config.action,
            Action::Request {
                method: METHOD_PING,
                params: json!({}),
            }
        );
    }

    #[test]
    fn rejects_unknown_options() {
        let error = parse_args(args(&["ping", "--wat"])).expect_err("reject option");
        assert_eq!(error.exit, EXIT_USAGE);
    }

    #[test]
    fn json_flag_parsing_respects_the_option_separator() {
        let mut values = args(&["open", "--json", "--", "--json"]);
        assert!(extract_json_flag(&mut values));
        assert_eq!(values, args(&["open", "--", "--json"]));
    }

    #[test]
    fn rejects_zero_line_before_reading_path() {
        let error =
            parse_args(args(&["open", "--line", "0", "missing.rs"])).expect_err("reject zero line");
        assert_eq!(error.code, "usage");
    }

    #[test]
    fn parses_file_shorthand_with_line_and_focus_policy() {
        let file = tempfile::NamedTempFile::new().expect("temp file");
        let config = parse_args(vec![
            file.path().as_os_str().to_owned(),
            "--line".into(),
            "7".into(),
            "--no-focus".into(),
        ])
        .expect("parse open shorthand");
        let Action::Request { method, params } = config.action else {
            panic!("expected request action");
        };
        assert_eq!(method, METHOD_OPEN);
        assert_eq!(params["line"], 7);
        assert_eq!(params["focus"], false);
        assert_eq!(
            params["path"],
            std::fs::canonicalize(file.path())
                .expect("canonical temp path")
                .to_string_lossy()
                .as_ref()
        );
    }

    #[test]
    fn parses_cd_with_a_directory() {
        let dir = tempfile::tempdir().expect("temp directory");
        let config =
            parse_args(vec!["cd".into(), dir.path().as_os_str().to_owned()]).expect("parse cd");
        let Action::Request { method, params } = config.action else {
            panic!("expected request action");
        };
        assert_eq!(method, METHOD_CD);
        assert_eq!(params["focus"], true);
        assert_eq!(
            params["path"],
            std::fs::canonicalize(dir.path())
                .expect("canonical temp dir")
                .to_string_lossy()
                .as_ref()
        );
    }

    #[test]
    fn cd_rejects_a_file_path() {
        let file = tempfile::NamedTempFile::new().expect("temp file");
        let error = parse_args(vec!["cd".into(), file.path().as_os_str().to_owned()])
            .expect_err("reject file");
        assert_eq!(error.code, "not_a_directory");
        assert_eq!(error.exit, EXIT_USAGE);
    }

    #[test]
    fn cd_honours_no_focus() {
        let dir = tempfile::tempdir().expect("temp directory");
        let config = parse_args(vec![
            "cd".into(),
            dir.path().as_os_str().to_owned(),
            "--no-focus".into(),
        ])
        .expect("parse cd");
        let Action::Request { params, .. } = config.action else {
            panic!("expected request action");
        };
        assert_eq!(params["focus"], false);
    }

    #[test]
    fn cd_without_a_path_is_a_usage_error() {
        let error = parse_args(args(&["cd"])).expect_err("reject missing directory");
        assert_eq!(error.code, "usage");
        assert_eq!(error.message, "cd requires a directory");
    }

    #[test]
    fn cd_rejects_from_hook_with_a_path() {
        let dir = tempfile::tempdir().expect("temp directory");
        let error = parse_args(vec![
            "cd".into(),
            "--terax-follow-hook".into(),
            dir.path().as_os_str().to_owned(),
        ])
        .expect_err("reject a path alongside the hook flag");
        assert_eq!(error.code, "usage");
        assert_eq!(error.exit, EXIT_USAGE);
    }

    #[test]
    fn hook_mode_belongs_to_the_cd_verb_alone() {
        assert!(hook_mode(&args(&["cd", "--terax-follow-hook"])));
        assert!(hook_mode(&args(&["cd", "--json", "--terax-follow-hook"])));
        assert!(!hook_mode(&args(&["cd"])));
        assert!(!hook_mode(&args(&["cd", "--", "--terax-follow-hook"])));
        assert!(!hook_mode(&args(&["--terax-follow-hook"])));
    }

    #[test]
    fn the_hook_flag_outside_cd_stays_a_visible_usage_error() {
        let values = args(&["open", "--terax-follow-hook", "/etc/hosts"]);
        assert!(!hook_mode(&values));
        let error = parse_args(values).expect_err("reject the hook flag on open");
        assert_eq!(error.code, "usage");
        assert_eq!(error.exit, EXIT_USAGE);
    }

    #[test]
    fn hook_payload_reports_the_new_directory() {
        let payload = r#"{"session_id":"s1","transcript_path":"/t","cwd":"/b",
            "hook_event_name":"CwdChanged","old_cwd":"/a","new_cwd":"/b"}"#;
        assert_eq!(hook_cwd_from_json(payload), Some("/b".to_string()));
    }

    #[test]
    fn hook_payload_ignores_a_directory_that_did_not_change() {
        let payload = r#"{"hook_event_name":"CwdChanged","old_cwd":"/a","new_cwd":"/a"}"#;
        assert_eq!(hook_cwd_from_json(payload), None);
    }

    #[test]
    fn hook_payload_ignores_other_events() {
        let payload = r#"{"hook_event_name":"Stop","old_cwd":"/a","new_cwd":"/b"}"#;
        assert_eq!(hook_cwd_from_json(payload), None);
    }

    #[test]
    fn hook_payload_ignores_anything_unusable() {
        assert_eq!(hook_cwd_from_json("{"), None);
        assert_eq!(
            hook_cwd_from_json(r#"{"hook_event_name":"CwdChanged","old_cwd":"/a"}"#),
            None
        );
        assert_eq!(
            hook_cwd_from_json(r#"{"hook_event_name":"CwdChanged","new_cwd":""}"#),
            None
        );
        assert_eq!(
            hook_cwd_from_json(r#"{"hook_event_name":"CwdChanged","new_cwd":42}"#),
            None
        );
    }

    #[test]
    fn project_root_detection_needs_a_git_entry() {
        let dir = tempfile::tempdir().expect("temp directory");
        assert!(!is_project_root(dir.path()));
        std::fs::create_dir(dir.path().join(".git")).expect("git directory");
        assert!(is_project_root(dir.path()));
    }

    #[test]
    fn project_root_detection_accepts_a_linked_worktree() {
        let dir = tempfile::tempdir().expect("temp directory");
        let main = dir.path().join("main");
        std::fs::create_dir(&main).expect("main checkout");
        if !git(&main, &["init", "-q"]) {
            // No usable git here, so there is no worktree to look at.
            return;
        }
        std::fs::write(main.join("README"), "terax").expect("seed file");
        assert!(git(&main, &["add", "README"]), "stage the seed file");
        assert!(git(&main, &["commit", "-qm", "seed"]), "commit the seed file");
        let linked = dir.path().join("linked");
        let linked_arg = linked.to_str().expect("utf8 worktree path");
        assert!(
            git(&main, &["worktree", "add", "-q", linked_arg, "-b", "side"]),
            "add the linked worktree"
        );
        assert!(std::fs::symlink_metadata(linked.join(".git"))
            .expect("worktree git entry")
            .is_file());
        assert!(is_project_root(&linked));
    }

    fn git(dir: &Path, arguments: &[&str]) -> bool {
        // Keep the repo out of the developer's own git config and identity.
        std::process::Command::new("git")
            .current_dir(dir)
            .args(arguments)
            .env("GIT_CONFIG_GLOBAL", dir.join("absent-gitconfig"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "terax")
            .env("GIT_AUTHOR_EMAIL", "terax@example.invalid")
            .env("GIT_COMMITTER_NAME", "terax")
            .env("GIT_COMMITTER_EMAIL", "terax@example.invalid")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[test]
    fn help_is_the_default() {
        assert_eq!(
            parse_args(Vec::new()).expect("parse default").action,
            Action::Help
        );
    }

    #[test]
    fn request_ids_are_safe_ascii() {
        let id = request_id();
        assert!(id.bytes().all(|byte| byte.is_ascii_digit() || byte == b'-'));
    }

    #[test]
    fn endpoint_validation_rejects_non_loopback_addresses() {
        assert!(parse_loopback_address("127.0.0.1:4312").is_ok());
        assert!(parse_loopback_address("[::1]:4312").is_ok());
        let error = parse_loopback_address("192.0.2.1:4312").expect_err("reject remote endpoint");
        assert_eq!(error.code, "invalid_endpoint");
    }

    #[test]
    fn endpoint_validation_requires_a_full_random_token() {
        let descriptor = ControlDescriptor {
            protocol: PROTOCOL_VERSION,
            address: "127.0.0.1:4312".into(),
            token: "short".into(),
            pid: 1,
            app_version: "test".into(),
        };
        let Err(error) = validate_endpoint(descriptor, false) else {
            panic!("accepted invalid token");
        };
        assert_eq!(error.code, "invalid_endpoint");
    }

    #[test]
    fn endpoint_validation_rejects_a_stale_descriptor_process() {
        let descriptor = ControlDescriptor {
            protocol: PROTOCOL_VERSION,
            address: "127.0.0.1:4312".into(),
            token: "a".repeat(64),
            pid: u32::MAX,
            app_version: "test".into(),
        };
        let Err(error) = validate_endpoint(descriptor, true) else {
            panic!("accepted stale process");
        };
        assert_eq!(error.code, "invalid_endpoint");
        assert!(process_is_alive(std::process::id()));
    }

    #[test]
    fn endpoint_validation_rejects_a_protocol_mismatch() {
        let descriptor = ControlDescriptor {
            protocol: PROTOCOL_VERSION + 1,
            address: "127.0.0.1:4312".into(),
            token: "a".repeat(64),
            pid: 1,
            app_version: "test".into(),
        };
        let Err(error) = validate_endpoint(descriptor, false) else {
            panic!("accepted foreign protocol");
        };
        assert_eq!(error.code, "unsupported_protocol");
    }

    #[test]
    fn loopback_parsing_rejects_hostnames_and_remote_hosts() {
        let error = parse_loopback_address("localhost:4312").expect_err("reject hostname");
        assert_eq!(error.code, "invalid_endpoint");
        let error = parse_loopback_address("127.0.0.1").expect_err("reject missing port");
        assert_eq!(error.code, "invalid_endpoint");
    }

    #[test]
    fn protocol_framing_round_trips_one_bounded_json_message() {
        let request = ControlRequest {
            protocol: PROTOCOL_VERSION,
            id: "transport-test".into(),
            token: "test-token".into(),
            method: METHOD_PING.into(),
            params: json!({}),
            caller: CallerContext::default(),
        };
        let response = ControlResponse::success(request.id.clone(), json!({ "pong": true }));
        let mut bytes = serde_json::to_vec(&response).expect("encode response");
        bytes.push(b'\n');
        let response = read_response(&mut Cursor::new(bytes), &request).expect("read response");
        assert_eq!(response.result, Some(json!({ "pong": true })));
    }

    #[test]
    fn protocol_framing_rejects_oversized_responses() {
        let request = ControlRequest {
            protocol: PROTOCOL_VERSION,
            id: "size-test".into(),
            token: "test-token".into(),
            method: METHOD_PING.into(),
            params: json!({}),
            caller: CallerContext::default(),
        };
        let bytes = vec![b'x'; MAX_MESSAGE_BYTES + 1];
        let error = read_response(&mut Cursor::new(bytes), &request).expect_err("reject response");
        assert_eq!(error.code, "message_too_large");
    }

    #[test]
    fn protocol_framing_accepts_server_errors_without_a_parsed_request_id() {
        let request = ControlRequest {
            protocol: PROTOCOL_VERSION,
            id: "busy-test".into(),
            token: "test-token".into(),
            method: METHOD_PING.into(),
            params: json!({}),
            caller: CallerContext::default(),
        };
        let response = ControlResponse::failure(SERVER_RESPONSE_ID, "server_busy", "busy");
        let mut bytes = serde_json::to_vec(&response).expect("encode response");
        bytes.push(b'\n');
        let response = read_response(&mut Cursor::new(bytes), &request).expect("read response");
        assert!(!response.ok);
    }
}
