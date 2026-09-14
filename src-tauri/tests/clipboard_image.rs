mod common;

use std::path::Path;
use std::time::{Duration, SystemTime};

use common::FsFixture;
use terax_lib::modules::clipboard_image::{
    is_expired, is_paste_artifact, is_unquoted_shell_path, paste_file_name, prune,
    resolve_paste_dir, write_paste_png, MAX_AGE, PASTE_DIR_NAME,
};

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

#[test]
fn generated_paste_path_never_needs_shell_quoting() {
    let fixture = FsFixture::new();
    let dir = resolve_paste_dir(&fixture.root);
    let path = write_paste_png(&dir, PNG).expect("write paste png");

    assert!(
        is_unquoted_shell_path(&path),
        "paste path must survive quoteShellPath verbatim: {path}"
    );
    assert_eq!(std::fs::read(&path).expect("read back"), PNG);
    assert!(is_paste_artifact(
        Path::new(&path).file_name().unwrap().to_str().unwrap()
    ));
}

#[test]
fn concurrent_pastes_never_overwrite_each_other() {
    let fixture = FsFixture::new();
    let dir = resolve_paste_dir(&fixture.root);
    let paths: Vec<String> = (0..16)
        .map(|_| write_paste_png(&dir, PNG).expect("write paste png"))
        .collect();

    let mut unique = paths.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), paths.len());
}

#[test]
fn system_temp_dir_that_would_need_quoting_falls_back_to_tmp() {
    assert_eq!(
        resolve_paste_dir(Path::new("/var/folders/ab/T")),
        Path::new("/var/folders/ab/T").join(PASTE_DIR_NAME)
    );
    assert_eq!(
        resolve_paste_dir(Path::new("/Users/a b/T")),
        Path::new("/tmp").join(PASTE_DIR_NAME)
    );
    assert_eq!(
        resolve_paste_dir(Path::new("/tmp/$(whoami)")),
        Path::new("/tmp").join(PASTE_DIR_NAME)
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_paste_dir_is_refused_and_never_written_through() {
    let fixture = FsFixture::new();
    let elsewhere = fixture.root.join("attacker");
    std::fs::create_dir_all(&elsewhere).expect("mkdir");
    let dir = fixture.root.join(PASTE_DIR_NAME);
    std::os::unix::fs::symlink(&elsewhere, &dir).expect("symlink");

    let error = write_paste_png(&dir, PNG).expect_err("symlinked paste dir must be refused");
    assert!(error.contains("not a directory"), "{error}");
    assert_eq!(
        std::fs::read_dir(&elsewhere).expect("read_dir").count(),
        0,
        "nothing may be written through the symlink"
    );
    assert!(
        std::fs::symlink_metadata(&dir)
            .expect("symlink metadata")
            .is_symlink(),
        "the planted symlink is left untouched"
    );
}

#[test]
fn paste_file_name_is_stable_and_safe() {
    let name = paste_file_name(1_757_808_000_123_456_789, 7);
    assert_eq!(name, "terax-paste-1757808000123456789-7.png");
    assert!(is_unquoted_shell_path(&name));
    assert!(is_paste_artifact(&name));
}

#[test]
fn artifact_predicate_rejects_unrelated_files() {
    assert!(!is_paste_artifact("terax-paste-.png"));
    assert!(!is_paste_artifact("screenshot.png"));
    assert!(!is_paste_artifact("terax-paste-1.txt"));
    assert!(!is_paste_artifact(".png"));
}

#[test]
fn prune_drops_stale_pastes_and_keeps_everything_else() {
    let fixture = FsFixture::new();
    let dir = fixture.root.join(PASTE_DIR_NAME);
    std::fs::create_dir_all(&dir).expect("mkdir");
    let stale = dir.join(paste_file_name(1, 0));
    let fresh = dir.join(paste_file_name(2, 0));
    let foreign = dir.join("keep-me.png");
    for path in [&stale, &fresh, &foreign] {
        std::fs::write(path, PNG).expect("write");
    }

    let now = SystemTime::now();
    let stale_time = now - Duration::from_secs(25 * 60 * 60);
    filetime_set(&stale, stale_time);
    filetime_set(&foreign, stale_time);

    prune(&dir, now, MAX_AGE);

    assert!(!stale.exists(), "stale paste should be pruned");
    assert!(fresh.exists(), "fresh paste should survive");
    assert!(foreign.exists(), "unrelated files are never touched");
}

#[test]
fn prune_ignores_a_missing_directory() {
    let fixture = FsFixture::new();
    prune(
        &fixture.root.join("never-created"),
        SystemTime::now(),
        MAX_AGE,
    );
}

#[test]
fn expiry_is_exclusive_at_the_boundary_and_tolerates_clock_skew() {
    let now = SystemTime::now();
    let max_age = Duration::from_secs(60);
    assert!(!is_expired(now - max_age, now, max_age));
    assert!(is_expired(now - max_age - Duration::from_secs(1), now, max_age));
    assert!(!is_expired(now + Duration::from_secs(600), now, max_age));
}

#[test]
fn unquoted_shell_path_matches_the_frontend_character_class() {
    assert!(is_unquoted_shell_path("/private/tmp/terax-clipboard/a.png"));
    assert!(is_unquoted_shell_path("C:\\Users\\me\\a.png"));
    assert!(!is_unquoted_shell_path(""));
    for bad in ["/tmp/a b.png", "/tmp/a'b.png", "/tmp/$(x).png", "/tmp/a~b.png"] {
        assert!(!is_unquoted_shell_path(bad), "{bad} should require quoting");
    }
}

fn filetime_set(path: &Path, time: SystemTime) {
    let file = std::fs::File::options()
        .write(true)
        .open(path)
        .expect("open for times");
    file.set_times(std::fs::FileTimes::new().set_modified(time))
        .expect("set mtime");
}
