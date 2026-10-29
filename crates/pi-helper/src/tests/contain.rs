//! Containment tests: every refusal happens before the filesystem is written.

use std::fs;

use crate::contain::Scope;
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
    for scope in [env.scope(), Scope::Helper] {
        for relative in REFUSED {
            let read = roots.resolve_read(scope, relative);
            assert!(
                matches!(
                    read,
                    Err(HelperError::PathEscape
                        | HelperError::PathForbidden
                        | HelperError::InvalidArgument)
                ),
                "read {relative:?} in {scope:?} => {read:?}"
            );
            let write = roots.resolve_write(scope, relative);
            assert!(
                matches!(
                    write,
                    Err(HelperError::PathEscape
                        | HelperError::PathForbidden
                        | HelperError::InvalidArgument)
                ),
                "write {relative:?} in {scope:?} => {write:?}"
            );
        }
    }
}

#[test]
fn containment_accepts_nested_project_paths_and_the_helper_adapter_tree() {
    let env = test_env();
    let roots = env.state.roots.as_ref();

    let nested = env.project.join("src/nested/main.rs");
    fs::create_dir_all(nested.parent().unwrap()).unwrap();
    fs::write(&nested, b"fn main() {}\n").unwrap();
    assert_eq!(
        roots
            .resolve_read(env.scope(), "src/nested/main.rs")
            .unwrap(),
        fs::canonicalize(&nested).unwrap()
    );

    // The helper scope reaches its own adapter tree and nothing else.
    let installed = env.helper.join("adapters").join("python-debugpy");
    fs::create_dir_all(&installed).unwrap();
    assert_eq!(
        roots
            .resolve_read(Scope::Helper, "adapters/python-debugpy")
            .unwrap(),
        fs::canonicalize(&installed).unwrap()
    );

    // A put target that does not exist yet resolves under the same root.
    let target = env.project.join("src/nested/new.rs");
    assert_eq!(
        roots
            .resolve_write(env.scope(), "src/nested/new.rs")
            .unwrap(),
        target
    );
}

#[test]
fn helper_private_files_are_not_reachable() {
    let env = test_env();
    let roots = env.state.roots.as_ref();
    assert!(env.helper.join("token").is_file());
    fs::write(env.helper.join("logs/helper.log"), b"line\n").unwrap();

    // Through a project root the helper directory simply does not exist.
    for relative in ["token", "logs/helper.log", "bin", "env.json"] {
        assert!(
            matches!(
                roots.resolve_read(env.scope(), relative),
                Err(HelperError::PathNotFound)
            ),
            "{relative} must not resolve into the helper directory"
        );
    }

    // The helper scope admits only the adapter tree.
    for relative in ["token", "logs/helper.log", "bin/pi-helper", "env.json"] {
        assert!(
            matches!(
                roots.resolve_read(Scope::Helper, relative),
                Err(HelperError::PathForbidden)
            ),
            "{relative} must stay private"
        );
        assert!(
            matches!(
                roots.resolve_write(Scope::Helper, relative),
                Err(HelperError::PathForbidden)
            ),
            "{relative} must not be writable"
        );
    }
    assert!(matches!(
        roots.resolve_read(Scope::Helper, "adapters/../token"),
        Err(HelperError::PathEscape)
    ));
    assert!(matches!(
        roots.resolve_read(Scope::Helper, "adapters/./token"),
        Err(HelperError::InvalidArgument)
    ));
}

#[cfg(windows)]
#[test]
fn windows_drive_prefixes_are_refused() {
    let env = test_env();
    assert!(matches!(
        env.state
            .roots
            .resolve_read(env.scope(), "C:/Windows/system32"),
        Err(HelperError::PathEscape)
    ));
}

#[cfg(unix)]
#[test]
fn symlink_escapes_are_refused_in_both_directions() {
    let env = test_env();
    let roots = env.state.roots.as_ref();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
    std::os::unix::fs::symlink(outside.path(), env.project.join("linked")).unwrap();
    assert!(matches!(
        roots.resolve_read(env.scope(), "linked/secret.txt"),
        Err(HelperError::PathEscape)
    ));
    assert!(matches!(
        roots.resolve_write(env.scope(), "linked/new.txt"),
        Err(HelperError::PathEscape)
    ));

    // An existing symlink target is never replaced through the link.
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        env.project.join("target-link"),
    )
    .unwrap();
    assert!(matches!(
        roots.resolve_write(env.scope(), "target-link"),
        Err(HelperError::PathEscape)
    ));

    // A symlink that stays inside its root is readable.
    fs::create_dir_all(env.project.join("inside")).unwrap();
    fs::write(env.project.join("inside/file.txt"), b"x").unwrap();
    std::os::unix::fs::symlink(env.project.join("inside"), env.project.join("alias")).unwrap();
    assert!(roots.resolve_read(env.scope(), "alias/file.txt").is_ok());
}
