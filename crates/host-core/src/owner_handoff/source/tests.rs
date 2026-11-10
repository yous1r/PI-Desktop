use super::protocol::*;
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../packages/shared/test/fixtures/owner-handoff-source.json"
    ))
    .unwrap()
}
#[test]
fn source_contract_matches_shared_fixture_and_rejects_mutations() {
    let fixture = fixture();
    for key in ["preflight", "status"] {
        let request =
            Request::parse(&serde_json::to_vec(&fixture[key]["request"]).unwrap()).unwrap();
        let reply: Reply = serde_json::from_value(fixture[key]["reply"].clone()).unwrap();
        reply
            .validate(&request, fixture["profileId"].as_str().unwrap())
            .unwrap();
    }
    for operation in [
        "prepare", "cancel", "fence", "release", "claim", "recover", "ready",
    ] {
        let mut value = fixture["preflight"]["request"].clone();
        value["command"]["operation"] = json!(operation);
        assert!(Request::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}
#[test]
fn source_rejects_unknown_fields_noncanonical_identity_and_unbounded_frames() {
    let base = fixture()["preflight"]["request"].clone();
    for (key, value) in [
        ("idle", json!(true)),
        ("pid", json!(1)),
        ("requester", json!({})),
        ("requestId", json!("00000000-0000-0000-0000-000000000000")),
        ("sourceEpoch", json!("bad")),
        ("version", json!(2)),
    ] {
        let mut request = base.clone();
        request["command"][key] = value;
        assert!(Request::parse(&serde_json::to_vec(&request).unwrap()).is_err());
    }
    for value in [
        json!({"protocol":"owner-control","version":1,"command":base["command"]}),
        json!({"protocol":"owner-transfer","version":2,"command":base["command"]}),
    ] {
        assert!(Request::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    for bytes in [vec![0xff], vec![b' '; 16385], Vec::new()] {
        assert!(Request::parse(&bytes).is_err());
    }
}
#[test]
fn source_reply_cannot_substitute_identity_or_advertise_readiness() {
    let fixture = fixture();
    let profile = fixture["profileId"].as_str().unwrap();
    let request =
        Request::parse(&serde_json::to_vec(&fixture["preflight"]["request"]).unwrap()).unwrap();
    let base = fixture["preflight"]["reply"].clone();
    for (key, replacement) in [
        ("requestId", json!(uuid::Uuid::new_v4().to_string())),
        ("sourceEpoch", json!(uuid::Uuid::new_v4().to_string())),
        ("profileId", json!("f".repeat(64))),
        ("result", fixture["status"]["reply"]["result"].clone()),
    ] {
        let mut value = base.clone();
        value[key] = replacement;
        // The malformed value must fail either deserialization or correlation.
        assert!(serde_json::from_value::<Reply>(value)
            .and_then(|reply| reply
                .validate(&request, profile)
                .map_err(serde::de::Error::custom))
            .is_err());
    }
    let mut value = base;
    value["result"]["ready"] = json!(true);
    assert!(serde_json::from_value::<Reply>(value).is_err());
}
#[test]
fn source_cli_is_exclusive() {
    use std::ffi::OsString;
    assert!(super::validate_cli(&[OsString::from("--owner-source")]).is_ok());
    for flag in [
        "--execution-fence",
        "--owner-handoff",
        "--owner-source",
        "secret",
    ] {
        assert!(
            super::validate_cli(&[OsString::from("--owner-source"), OsString::from(flag)]).is_err()
        );
    }
}

#[cfg(windows)]
pub(super) fn state() -> (
    tempfile::TempDir,
    std::sync::Arc<tokio::sync::Mutex<crate::state::AppState>>,
    Request,
) {
    let directory = tempfile::tempdir().unwrap();
    let mut state = crate::state::AppState::open(directory.path()).unwrap();
    let mut registry = crate::execution_fence::Registry::start(directory.path()).unwrap();
    registry.bind_journal(directory.path()).unwrap();
    let mut value = fixture()["preflight"]["request"].clone();
    value["command"]["sourceEpoch"] = json!(registry.epoch());
    value["command"]["targetBuild"] =
        serde_json::to_value(crate::owner_handoff::model::Build::current().unwrap()).unwrap();
    state.execution_fence = Some(registry);
    (
        directory,
        std::sync::Arc::new(tokio::sync::Mutex::new(state)),
        Request::parse(&serde_json::to_vec(&value).unwrap()).unwrap(),
    )
}
#[cfg(windows)]
#[tokio::test]
async fn source_service_preserves_journal_and_rejects_stale_retired_and_contended_owners() {
    let (_directory, state, request) = state();
    let service = super::service::Service::capture(state.clone())
        .unwrap()
        .unwrap();
    assert!(matches!(
        service.execute(&request).result,
        Body::Preflight(_)
    ));
    let mut stale = request.clone();
    if let Command::Preflight { source_epoch, .. } = &mut stale.command {
        *source_epoch = uuid::Uuid::new_v4().to_string();
    }
    assert!(matches!(
        service.execute(&stale).result,
        Body::Failure {
            error: Failure {
                code: Code::OwnerChanged
            },
            ..
        }
    ));
    let mut incompatible = request.clone();
    if let Command::Preflight { target_build, .. } = &mut incompatible.command {
        target_build.sha256 = "a".repeat(64);
    }
    assert!(matches!(
        service.execute(&incompatible).result,
        Body::Failure {
            error: Failure {
                code: Code::IncompatibleBuild
            },
            ..
        }
    ));
    {
        let state = state.lock().await;
        assert!(matches!(
            service.execute(&request).result,
            Body::Failure {
                error: Failure {
                    code: Code::Unavailable
                },
                ..
            }
        ));
        for table in ["owner_handoffs", "owner_handoff_receipts"] {
            let count: i64 = state
                .db
                .conn()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
        state
            .db
            .conn()
            .execute("UPDATE execution_owners SET retired=1", [])
            .unwrap();
    }
    assert!(matches!(
        service.execute(&request).result,
        Body::Failure {
            error: Failure {
                code: Code::OwnerChanged
            },
            ..
        }
    ));
    state.lock().await.execution_fence = None;
    assert!(matches!(
        service.execute(&request).result,
        Body::Failure {
            error: Failure {
                code: Code::OwnerChanged
            },
            ..
        }
    ));
}
