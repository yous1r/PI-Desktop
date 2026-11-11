//! Process-entry refusals: the restricted target mode must decide before any
//! AppState, migration or recovery work, and must fail closed instead of falling
//! through to ordinary Host startup.
use super::*;

fn scratch() -> tempfile::TempDir {
    // Managed Windows hosts deny OS-temp directory creation to test processes;
    // keep mutable state under the repository target directory like the other
    // owner-handoff fixtures.
    let scratch = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
    std::fs::create_dir_all(&scratch).expect("repo target directory");
    tempfile::tempdir_in(&scratch).expect("scratch profile")
}

fn entries(directory: &std::path::Path) -> usize {
    std::fs::read_dir(directory)
        .expect("read scratch profile")
        .count()
}

#[cfg(windows)]
#[tokio::test]
async fn missing_profile_refuses_before_creating_state_or_opening_appstate() {
    let profile = scratch();
    let error = run(profile.path()).await.unwrap_err().to_string();
    assert!(error.contains("HANDOFF_DATABASE_MISSING"), "{error}");
    // No data directory, lock file, log directory, database or migration ran.
    assert_eq!(entries(profile.path()), 0);
    assert!(!profile.path().join("pi.sqlite").exists());
    assert!(!profile.path().join("host-core.lock").exists());
    assert!(!profile.path().join("logs").exists());
}

#[tokio::test]
async fn a_claim_without_supervisor_adoption_stops_with_the_documented_code() {
    let profile = scratch();
    let mut received = Vec::new();
    let error = dispatch(profile.path().to_path_buf(), |directory| {
        received.push(directory);
        std::future::ready(Ok::<(), anyhow::Error>(()))
    })
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains(ADOPTION_UNAVAILABLE), "{error}");
    assert_eq!(received, vec![profile.path().to_path_buf()]);
    // The refusal must not fall back to data-directory creation or AppState.
    assert_eq!(entries(profile.path()), 0);
}

#[tokio::test]
async fn absent_or_invalid_private_transport_is_propagated_and_never_falls_through() {
    let profile = scratch();
    for code in [
        "HANDOFF_PRIVATE_PIPE_REQUIRED",
        "HANDOFF_INVALID_FRAME",
        "HANDOFF_INVALID_REQUEST",
        "HANDOFF_UNSUPPORTED_VERSION",
        "HANDOFF_BOOTSTRAP_EOF",
    ] {
        let error = dispatch(profile.path().to_path_buf(), |_| {
            std::future::ready(Err::<(), anyhow::Error>(anyhow::anyhow!(code)))
        })
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, code);
    }
    assert_eq!(entries(profile.path()), 0);
}

#[test]
fn main_dispatches_target_mode_before_any_data_directory_or_appstate_side_effect() {
    let main = include_str!("../../../main.rs");
    let requested = main
        .find("owner_handoff::target::requested(")
        .expect("main must validate the target argv surface");
    let dispatch = main
        .find("owner_handoff::target::run(&data_dir)")
        .expect("main must dispatch the target mode");
    assert!(
        requested < dispatch,
        "target mode must be decided before run"
    );
    for later in [
        "std::fs::create_dir_all(&data_dir)",
        "DataDirectoryOwner::acquire(",
        "startup::inspect_directory(",
        "AppState::open(",
    ] {
        let index = main
            .find(later)
            .unwrap_or_else(|| panic!("main.rs no longer contains {later}"));
        assert!(
            dispatch < index,
            "target dispatch must precede the ordinary startup step {later}"
        );
    }
    let owner_handoff = include_str!("../../mod.rs");
    assert!(owner_handoff.contains("target::requested(args)"));
}
