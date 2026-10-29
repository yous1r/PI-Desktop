//! Project-root selection and registration.
//!
//! Every `fs.*` request names the one root it addresses. These tests pin the
//! defect a real host exposed: before the scope was explicit, `bin/run.sh` in a
//! project without `bin/` was written into the helper's own `bin/` directory,
//! and `env.json` meant for the helper landed in the user's project.

use std::fs;

use serde_json::json;

use super::{call, connect, digest, object, read_response, send_request, spawn, test_env};
use crate::contain::{Roots, Scope, MAX_PROJECT_ROOTS};
use crate::frame::{write_data_frame, write_end_frame};
use crate::{dispatch, HelperError, Op};

#[test]
fn project_paths_never_resolve_into_the_helper_directory() {
    let env = test_env();
    let roots = env.state.roots.as_ref();

    // The project has no `bin/`, while the helper directory always has one.
    assert!(env.helper.join("bin").is_dir());
    assert!(!env.project.join("bin").exists());

    let created = roots.resolve_mkdir(env.scope(), "bin").unwrap();
    assert_eq!(created, fs::canonicalize(env.project.join("bin")).unwrap());
    assert_eq!(
        roots.resolve_write(env.scope(), "bin/run.sh").unwrap(),
        env.project.join("bin").join("run.sh")
    );

    // A helper file name at the top of a project stays in the project, even
    // after the helper has written its own copy.
    fs::write(env.helper.join("env.json"), b"{}").unwrap();
    assert_eq!(
        roots.resolve_write(env.scope(), "env.json").unwrap(),
        env.project.join("env.json")
    );
    assert!(env.helper.join("logs").is_dir());
    assert_eq!(
        roots.resolve_mkdir(env.scope(), "logs").unwrap(),
        fs::canonicalize(env.project.join("logs")).unwrap()
    );
}

#[test]
fn fs_requests_must_name_a_registered_root() {
    let env = test_env();
    fs::write(env.project.join("hello.txt"), b"abc").unwrap();
    let outside = tempfile::tempdir().unwrap();
    let outside = fs::canonicalize(outside.path()).unwrap();

    assert!(matches!(
        dispatch(
            &env.state,
            Op::Hash,
            &object(json!({ "path": "hello.txt" }))
        ),
        Err(HelperError::InvalidArgument)
    ));
    assert!(matches!(
        dispatch(
            &env.state,
            Op::Hash,
            &object(json!({ "root": "project", "path": "hello.txt" })),
        ),
        Err(HelperError::InvalidArgument)
    ));
    assert!(matches!(
        dispatch(
            &env.state,
            Op::Hash,
            &object(json!({ "root": outside.to_str().unwrap(), "path": "hello.txt" })),
        ),
        Err(HelperError::PathForbidden)
    ));
    // The helper directory is never a project root.
    assert!(matches!(
        dispatch(
            &env.state,
            Op::Stat,
            &object(json!({ "root": env.helper.to_str().unwrap(), "paths": ["token"] })),
        ),
        Err(HelperError::PathForbidden)
    ));

    let hash = dispatch(
        &env.state,
        Op::Hash,
        &object(json!({ "root": env.root(), "path": "hello.txt" })),
    )
    .unwrap();
    assert_eq!(hash["sha256"], digest(b"abc"));
}

#[test]
fn two_registered_roots_never_see_each_other() {
    let env = test_env();
    let other = env.project.parent().unwrap().join("other");
    fs::create_dir_all(&other).unwrap();
    let other = env.state.roots.register(other.to_str().unwrap()).unwrap();
    fs::write(env.project.join("only-first.txt"), b"first").unwrap();
    fs::write(other.join("only-second.txt"), b"second").unwrap();

    let roots = env.state.roots.as_ref();
    assert!(roots.resolve_read(env.scope(), "only-first.txt").is_ok());
    assert!(roots
        .resolve_read(Scope::Project(&other), "only-second.txt")
        .is_ok());
    assert!(matches!(
        roots.resolve_read(env.scope(), "only-second.txt"),
        Err(HelperError::PathNotFound)
    ));
    assert!(matches!(
        roots.resolve_read(Scope::Project(&other), "only-first.txt"),
        Err(HelperError::PathNotFound)
    ));

    // A directory is created only in the root the request names.
    roots
        .resolve_mkdir(Scope::Project(&other), "src/deep")
        .unwrap();
    assert!(other.join("src").join("deep").is_dir());
    assert!(!env.project.join("src").exists());
}

#[tokio::test]
async fn root_register_is_idempotent_canonical_and_refuses_the_helper_tree() {
    let env = test_env();
    let second = env.project.parent().unwrap().join("second");
    fs::create_dir_all(&second).unwrap();
    let second = fs::canonicalize(&second).unwrap();
    let second_text = second.to_str().unwrap().to_owned();
    let file = second.join("file.txt");
    fs::write(&file, b"x").unwrap();

    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;

    let first = call(
        &mut client,
        "r1",
        "root.register",
        json!({ "path": second_text }),
    )
    .await;
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["result"]["root"].as_str(), Some(second_text.as_str()));
    let again = call(
        &mut client,
        "r2",
        "root.register",
        json!({ "path": second_text }),
    )
    .await;
    assert_eq!(again["result"]["root"].as_str(), Some(second_text.as_str()));
    let health = call(&mut client, "h", "health", json!({})).await;
    assert_eq!(health["result"]["projectRootCount"], 2);

    // `$HOME`, which holds the helper directory, and anything inside it.
    let home = env.helper.parent().unwrap().to_str().unwrap().to_owned();
    let inside = env.helper.join("adapters").to_str().unwrap().to_owned();
    for (id, path) in [("home", home), ("inside", inside)] {
        let refused = call(&mut client, id, "root.register", json!({ "path": path })).await;
        assert_eq!(refused["error"]["code"], "REMOTE_PATH_FORBIDDEN", "{id}");
    }
    let missing = second.join("missing").to_str().unwrap().to_owned();
    let refused = call(
        &mut client,
        "m",
        "root.register",
        json!({ "path": missing }),
    )
    .await;
    assert_eq!(refused["error"]["code"], "REMOTE_PATH_NOT_FOUND");
    for (id, path) in [
        ("relative", "relative/path".to_owned()),
        ("empty", String::new()),
        ("file", file.to_str().unwrap().to_owned()),
    ] {
        let refused = call(&mut client, id, "root.register", json!({ "path": path })).await;
        assert_eq!(refused["error"]["code"], "INVALID_ARGUMENT", "{id}");
    }
    let health = call(&mut client, "h2", "health", json!({})).await;
    assert_eq!(health["result"]["projectRootCount"], 2);

    drop(client);
    server.await.unwrap().unwrap();
}

#[cfg(unix)]
#[test]
fn root_register_returns_the_canonical_spelling() {
    let env = test_env();
    let second = env.project.parent().unwrap().join("second");
    fs::create_dir_all(second.join("sub")).unwrap();
    let spelled = second.join("sub").join("..");
    let registered = env.state.roots.register(spelled.to_str().unwrap()).unwrap();
    assert_eq!(registered, fs::canonicalize(&second).unwrap());
    assert_eq!(env.state.roots.project_count(), 2);
}

#[test]
fn the_root_registry_is_bounded_and_registration_stays_idempotent_at_the_cap() {
    let env = test_env();
    let roots: &Roots = env.state.roots.as_ref();
    let mut keep = Vec::new();
    while roots.project_count() < MAX_PROJECT_ROOTS {
        let directory = tempfile::tempdir().unwrap();
        roots.register(directory.path().to_str().unwrap()).unwrap();
        keep.push(directory);
    }
    let extra = tempfile::tempdir().unwrap();
    assert!(matches!(
        roots.register(extra.path().to_str().unwrap()),
        Err(HelperError::InvalidArgument)
    ));
    assert!(roots.register(&env.root()).is_ok());
    assert_eq!(roots.project_count(), MAX_PROJECT_ROOTS);
}

/// The exact write that misrouted on a real host, driven over the wire.
#[tokio::test]
async fn a_helper_shaped_project_file_is_uploaded_into_the_project() {
    let env = test_env();
    let bytes = b"#!/bin/sh\necho project\n";
    let (address, server) = spawn(env.state.clone()).await;
    let mut client = connect(address, &env.token).await;

    let created = call(
        &mut client,
        "mk",
        "fs.mkdirs",
        json!({ "root": env.root(), "paths": ["bin"] }),
    )
    .await;
    assert_eq!(created["ok"], true, "{created}");
    send_request(
        &mut client,
        "put",
        "fs.put.begin",
        json!({
            "root": env.root(),
            "path": "bin/run.sh",
            "streamId": 21,
            "size": bytes.len(),
            "sha256": digest(bytes),
        }),
    )
    .await;
    write_data_frame(&mut client, 21, bytes).await.unwrap();
    write_end_frame(&mut client, 21).await.unwrap();
    let response = read_response(&mut client).await;
    assert_eq!(response["ok"], true, "{response}");
    drop(client);
    server.await.unwrap().unwrap();

    assert_eq!(
        fs::read(env.project.join("bin").join("run.sh")).unwrap(),
        bytes
    );
    assert!(!env.helper.join("bin").join("run.sh").exists());
}
