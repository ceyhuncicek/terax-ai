use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const PASTE_DIR_NAME: &str = "terax-clipboard";
pub const PASTE_PREFIX: &str = "terax-paste-";
pub const PASTE_SUFFIX: &str = ".png";
pub const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

static NEXT_PASTE: AtomicU64 = AtomicU64::new(0);

/// Mirrors SAFE_PATH in src/modules/terminal/lib/quoteShellPath.ts: a path that
/// needs shell quoting never resolves to an image attachment in the agent CLI.
pub fn is_unquoted_shell_path(path: &str) -> bool {
    !path.is_empty()
        && path.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '_' | '@' | '%' | '+' | '=' | ':' | ',' | '.' | '/' | '\\' | '-'
                )
        })
}

pub fn paste_file_name(nanos: u128, counter: u64) -> String {
    format!("{PASTE_PREFIX}{nanos}-{counter}{PASTE_SUFFIX}")
}

pub fn is_paste_artifact(name: &str) -> bool {
    name.len() > PASTE_PREFIX.len() + PASTE_SUFFIX.len()
        && name.starts_with(PASTE_PREFIX)
        && name.ends_with(PASTE_SUFFIX)
}

pub fn is_expired(modified: SystemTime, now: SystemTime, max_age: Duration) -> bool {
    now.duration_since(modified)
        .map(|age| age > max_age)
        .unwrap_or(false)
}

/// Falls back to /tmp when the system temp dir carries characters that would
/// force shell quoting, so the emitted path always pastes verbatim.
pub fn resolve_paste_dir(system_temp: &Path) -> PathBuf {
    let candidate = system_temp.join(PASTE_DIR_NAME);
    match candidate.to_str() {
        Some(path) if is_unquoted_shell_path(path) => candidate,
        _ => PathBuf::from("/tmp").join(PASTE_DIR_NAME),
    }
}

pub fn prune(dir: &Path, now: SystemTime, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_paste_artifact(name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if is_expired(modified, now, max_age) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Creates the paste dir itself instead of accepting whatever sits at that path:
/// the /tmp fallback is world-writable, so a pre-planted symlink would otherwise
/// redirect both the 0700 chmod and every pasted image.
pub fn ensure_paste_dir(dir: &Path) -> Result<(), String> {
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create clipboard temp dir: {error}"))?;
    }
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = std::fs::symlink_metadata(dir)
                .map_err(|error| format!("inspect clipboard temp dir: {error}"))?;
            if meta.is_dir() {
                Ok(())
            } else {
                Err(format!(
                    "refusing clipboard temp dir, not a directory: {}",
                    dir.display()
                ))
            }
        }
        Err(error) => Err(format!("create clipboard temp dir: {error}")),
    }
}

pub fn write_paste_png(dir: &Path, bytes: &[u8]) -> Result<String, String> {
    ensure_paste_dir(dir)?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for _ in 0..8 {
        let counter = NEXT_PASTE.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(paste_file_name(nanos, counter));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => {
                file.write_all(bytes)
                    .map_err(|error| format!("write clipboard image: {error}"))?;
                return path
                    .to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "clipboard image path is not valid UTF-8".to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create clipboard image: {error}")),
        }
    }
    Err("could not allocate a clipboard image path".to_string())
}

#[tauri::command]
pub fn clipboard_read_image_to_temp() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let Some(png) = macos::pasteboard_png() else {
            return Ok(None);
        };
        let dir = resolve_paste_dir(&std::env::temp_dir());
        ensure_paste_dir(&dir)?;
        prune(&dir, SystemTime::now(), MAX_AGE);
        write_paste_png(&dir, &png).map(Some)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSPasteboard,
    };
    use objc2_foundation::{NSDictionary, NSString};

    const PNG: &str = "public.png";
    const TRANSCODABLE: [&str; 8] = [
        "public.tiff",
        "public.jpeg",
        "public.heic",
        "public.heif",
        "com.compuserve.gif",
        "com.microsoft.bmp",
        "org.webmproject.webp",
        "public.avif",
    ];

    fn data_for(pasteboard: &NSPasteboard, uti: &str) -> Option<Vec<u8>> {
        let ty = NSString::from_str(uti);
        pasteboard.dataForType(&ty).map(|data| data.to_vec())
    }

    fn transcode_png(bytes: &[u8]) -> Option<Vec<u8>> {
        let data = objc2_foundation::NSData::with_bytes(bytes);
        let rep = NSBitmapImageRep::imageRepWithData(&data)?;
        let properties: objc2::rc::Retained<
            NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>,
        > = NSDictionary::new();
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }?;
        let png = png.to_vec();
        (!png.is_empty()).then_some(png)
    }

    pub fn pasteboard_png() -> Option<Vec<u8>> {
        let pasteboard = NSPasteboard::generalPasteboard();
        if let Some(png) = data_for(&pasteboard, PNG) {
            if !png.is_empty() {
                return Some(png);
            }
        }
        TRANSCODABLE
            .iter()
            .filter_map(|uti| data_for(&pasteboard, uti))
            .filter(|bytes| !bytes.is_empty())
            .find_map(|bytes| transcode_png(&bytes))
    }
}
