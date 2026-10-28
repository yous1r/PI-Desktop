//! Containment tests: every refusal happens before the filesystem is written.

use std::fs;

use crate::contain::Roots;
use crate::HelperError;

use super::test_env;

const REFUSED: &[&str] = &[
    "../escape",
    "src/../../escape",
    "/etc/passwd",
    "a\\b",
    "src\\main.rs",
    "a\0b",
    ".env",
    "src/.env.local",
    ".ssh/config",
    "certs/server.pem",
    "keys/id.key",
    "keys/ID.KEY",
    ".",
    "",
];

#[test]
fn containment_refuses_escapes_and_credential_shaped_components() {
    let env = test_env();
    let roots = env.state.roots.as_ref();
    for relative in REFUSED {
        let read = roots.resolve_read(relative);
        assert!(
            matches!(
                read,
                Err(HelperError::PathEscape
                    | HelperError::PathForbidden
                    | HelperError::InvalidArgument)
            ),
            "read {relative:?} => {read:?}"
        );
        let write = roots.resolve_write(relative);
        assert!(
            matches!(
                write,
                Err(HelperError::PathEscape
                    | HelperError::PathForbidden
                    | HelperError::InvalidArgument)
            ),
            "write {relative:?} => {write:?}"
        );
    }
}

#[test]
fn containment_accepts_nested_project_and_helper_paths() {
    let env = test_env();
    let roots = env.state.roots.as_ref();

    let nested = env.project.join("src/nested/main.rs");
    fs::create_dir_all(nested.parent().unwrap()).unwrap();
    fs::write(&nested, b"fn main() {}\n").unwrap();
    assert_eq!(
        roots.resolve_read("src/nested/main.rs").unwrap(),
        fs::canonicalize(&nested).unwrap()
    );

    let log = env.helper.join("logs/helper.log");
    fs::write(&log, b"line\n").unwrap();
    assert_eq!(
        roots.resolve_read("logs/helper.log").unwrap(),
        fs::canonicalize(&log).unwrap()
    );

    // A put target that does not exist yet resolves under the same root.
    let target = env.project.join("src/nested/new.rs");
    assert_eq!(roots.resolve_write("src/nested/new.rs").unwrap(), target);
}

#[test]
fn helper_private_files_are_not_reachable() {
    let env = test_env();
    assert!(env.helper.join("token").is_file());
    assert!(matches!(
        env.state.roots.resolve_read("token"),
        Err(HelperError::PathNotFound)
    ));

    let helper_only = Roots::new(env.helper.clone(), Vec::new());
    assert!(matches!(
        helper_only.resolve_read("token"),
        Err(HelperError::PathNotFound)
    ));
    assert!(matches!(
        helper_only.resolve_write("token"),
        Err(HelperError::PathNotFound)
    ));
    assert!(matches!(
        helper_only.resolve_read("bin/../token"),
        Err(HelperError::PathEscape)
    ));
    assert!(matches!(
        helper_only.resolve_read("bin/./token"),
        Err(HelperError::InvalidArgument)
    ));
}

#[cfg(windows)]
#[test]
fn windows_drive_prefixes_are_refused() {
    let env = test_env();
    assert!(matches!(
        env.state.roots.resolve_read("C:/Windows/system32"),
        Err(HelperError::PathEscape)
    ));
}

#[cfg(unix)]
#[test]
fn symlink_escapes_are_refused_in_both_directions() {
    let env = test_env();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
    std::os::unix::fs::symlink(outside.path(), env.project.join("linked")).unwrap();
    assert!(matches!(
        env.state.roots.resolve_read("linked/secret.txt"),
        Err(HelperError::PathEscape)
    ));
    assert!(matches!(
        env.state.roots.resolve_write("linked/new.txt"),
        Err(HelperError::PathEscape)
    ));

    // An existing symlink target is never replaced through the link.
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        env.project.join("target-link"),
    )
    .unwrap();
    assert!(matches!(
        env.state.roots.resolve_write("target-link"),
        Err(HelperError::PathEscape)
    ));

    // A symlink that stays inside its root is readable.
    fs::create_dir_all(env.project.join("inside")).unwrap();
    fs::write(env.project.join("inside/file.txt"), b"x").unwrap();
    std::os::unix::fs::symlink(env.project.join("inside"), env.project.join("alias")).unwrap();
    assert!(env.state.roots.resolve_read("alias/file.txt").is_ok());
}
