use super::protocol::*;
use crate::owner_handoff::model::{Phase, Transfer, VERSION};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../packages/shared/test/fixtures/owner-handoff-source.json"
    ))
    .unwrap()
}

fn request(key: &str) -> Request {
    Request::parse(&serde_json::to_vec(&fixture()[key]["request"]).unwrap()).unwrap()
}

fn reply(key: &str) -> Reply {
    serde_json::from_value(fixture()[key]["reply"].clone()).unwrap()
}

const SOURCE_COMMANDS: [&str; 6] = [
    "preflight",
    "status",
    "prepare",
    "cancel",
    "fence",
    "release",
];
const MUTATIONS: [&str; 4] = ["prepare", "cancel", "fence", "release"];
const PHASES: [&str; 7] = [
    "prepared",
    "source_fencing",
    "source_fenced",
    "release_pending",
    "target_claimed",
    "ready",
    "cancelled",
];

/// Producer and consumer share one golden file: every accepted request/reply
/// pair must survive the producer's constructor and the consumer's
/// correlation checks in both directions.
#[test]
fn source_contract_matches_shared_fixture_for_reads_and_mutations() {
    let fixture = fixture();
    let profile = fixture["profileId"].as_str().unwrap();
    for key in SOURCE_COMMANDS {
        let request = request(key);
        reply(key).validate(&request, profile).unwrap();
        let encoded = crate::owner_handoff::model::encode(&reply(key)).unwrap();
        let decoded: Reply = serde_json::from_str(&encoded).unwrap();
        decoded.validate(&request, profile).unwrap();
    }
    let prepare = request("prepare");
    let record: Transfer =
        serde_json::from_value(fixture["prepare"]["reply"]["result"]["record"].clone()).unwrap();
    let produced = Reply::new(
        &prepare,
        profile,
        Body::Record {
            version: VERSION,
            record,
        },
    );
    produced.validate(&prepare, profile).unwrap();
    let preflight = request("preflight");
    let produced = Reply::new(&preflight, profile, reply("preflight").result);
    produced.validate(&preflight, profile).unwrap();
}

#[test]
fn source_command_helpers_carry_identity_transfer_mutation_and_phase() {
    let fixture = fixture();
    for key in SOURCE_COMMANDS {
        let command = request(key).command;
        let (version, id, epoch) = command.identity();
        assert_eq!(version, VERSION, "{key}");
        assert_eq!(
            id,
            fixture[key]["request"]["command"]["requestId"]
                .as_str()
                .unwrap(),
            "{key}"
        );
        assert_eq!(
            epoch,
            fixture[key]["request"]["command"]["sourceEpoch"]
                .as_str()
                .unwrap(),
            "{key}"
        );
        let transfer = fixture[key]["request"]["command"]["transferId"].as_str();
        assert_eq!(command.transfer_id(), transfer, "{key}");
        assert_eq!(command.is_mutation(), MUTATIONS.contains(&key), "{key}");
    }
    let command = request("prepare").command;
    assert_eq!(command.expected_phase(), Some(Phase::Prepared));
    let command = request("cancel").command;
    assert_eq!(command.expected_phase(), Some(Phase::Cancelled));
    let command = request("fence").command;
    assert_eq!(command.expected_phase(), Some(Phase::SourceFenced));
    let command = request("release").command;
    assert_eq!(command.expected_phase(), Some(Phase::ReleasePending));
    for key in ["status", "preflight"] {
        assert_eq!(request(key).command.expected_phase(), None, "{key}");
    }
}

/// A syntactically valid read reply still cannot substitute identity, mix a
/// journal record into preflight, or advertise readiness.
#[test]
fn source_reply_cannot_substitute_identity_or_advertise_readiness() {
    let fixture = fixture();
    let profile = fixture["profileId"].as_str().unwrap();
    let request = request("preflight");
    let base = fixture["preflight"]["reply"].clone();
    for replacement in [
        json!({"requestId": uuid::Uuid::new_v4().to_string()}),
        json!({"sourceEpoch": uuid::Uuid::new_v4().to_string()}),
        json!({"profileId": "f".repeat(64)}),
        json!({"result": fixture["status"]["reply"]["result"].clone()}),
    ] {
        let mut value = base.clone();
        for (key, field) in replacement.as_object().unwrap() {
            value[key] = field.clone();
        }
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
fn source_rejects_caller_authority_revision_drift_and_foreign_fingerprints() {
    let fixture = fixture();
    let rejected = fixture["rejectedRequests"].as_array().unwrap();
    assert!(rejected.len() >= 17);
    for item in rejected {
        let bytes = serde_json::to_vec(&item["request"]).unwrap();
        assert!(Request::parse(&bytes).is_err(), "{}", item["case"]);
    }
    // A camelCase target-bootstrap fingerprint still names an unknown
    // operation; the source envelope never adopts claim/recover/ready.
    for operation in ["claim", "recover"] {
        let mut claim = fixture["prepare"]["request"].clone();
        claim["command"]["operation"] = json!(operation);
        assert!(Request::parse(&serde_json::to_vec(&claim).unwrap()).is_err());
    }
    let mut ready = fixture["status"]["request"].clone();
    ready["command"]["operation"] = json!("ready");
    assert!(Request::parse(&serde_json::to_vec(&ready).unwrap()).is_err());
}

#[test]
fn source_receipts_bind_operation_identity_target_and_phase() {
    let fixture = fixture();
    let profile = fixture["profileId"].as_str().unwrap();
    let rejected = fixture["rejectedReplies"].as_array().unwrap();
    assert!(rejected.len() >= 14);
    for item in rejected {
        let operation = item["operation"].as_str().unwrap();
        let request =
            Request::parse(&serde_json::to_vec(&fixture[operation]["request"]).unwrap()).unwrap();
        let profile = item["profileId"].as_str().unwrap_or(profile);
        let outcome = serde_json::from_value::<Reply>(item["reply"].clone()).and_then(|reply| {
            reply
                .validate(&request, profile)
                .map_err(serde::de::Error::custom)
        });
        assert!(outcome.is_err(), "{}", item["case"]);
    }
}

/// A replayed receipt may carry a historic revision, so revision progression
/// stays with the service; `status` observes any valid durable phase.
#[test]
fn source_receipts_bind_phase_but_not_historic_revision_progress() {
    let fixture = fixture();
    let profile = fixture["profileId"].as_str().unwrap();
    let prepare = request("prepare");
    let mut replay = fixture["prepare"]["reply"].clone();
    replay["result"]["record"]["revision"] = json!(9);
    serde_json::from_value::<Reply>(replay)
        .unwrap()
        .validate(&prepare, profile)
        .unwrap();
    let status = request("status");
    for phase in PHASES {
        let mut value = fixture["status"]["reply"].clone();
        value["result"]["record"]["phase"] = json!(phase);
        serde_json::from_value::<Reply>(value)
            .unwrap()
            .validate(&status, profile)
            .unwrap_or_else(|error| panic!("{phase}: {error:?}"));
    }
    // The fixture's scripted receipts: prepare commits revision 1, fence
    // commits intent and confirmation from expectedRevision 1, release and
    // cancel advance once.
    for (key, revision) in [("prepare", 1), ("cancel", 2), ("fence", 3), ("release", 4)] {
        assert_eq!(
            fixture[key]["reply"]["result"]["record"]["revision"].as_i64(),
            Some(revision),
            "{key}"
        );
    }
    assert_eq!(
        fixture["fence"]["request"]["command"]["expectedRevision"].as_i64(),
        Some(1)
    );
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
        ("expectedRevision", json!(1)),
    ] {
        let mut request = base.clone();
        request["command"][key] = value;
        assert!(Request::parse(&serde_json::to_vec(&request).unwrap()).is_err());
    }
    let mutation = fixture()["prepare"]["request"].clone();
    for (key, value) in [
        ("idle", json!(true)),
        ("pid", json!(12)),
        ("proof", json!("native")),
        ("requester", json!({})),
        ("capability", json!("cccc")),
        ("expectedRevision", json!(1)),
    ] {
        let mut request = mutation.clone();
        request["command"][key] = value;
        assert!(Request::parse(&serde_json::to_vec(&request).unwrap()).is_err());
    }
    for value in [
        json!({"protocol":"owner-control","version":1,"command":base["command"]}),
        json!({"protocol":"owner-transfer","version":2,"command":base["command"]}),
    ] {
        assert!(Request::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    let mut oversized = mutation;
    oversized["command"]["requestId"] = json!("x".repeat(17000));
    assert!(Request::parse(&serde_json::to_vec(&oversized).unwrap()).is_err());
    for bytes in [vec![0xff], vec![b' '; 16385], Vec::new()] {
        assert!(Request::parse(&bytes).is_err());
    }
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
