//! Ready commit/refusal evidence for the restricted target provider. The same
//! production publisher, journal transaction and ReadyTarget path are used;
//! only the surrounding profile fixture is generated.
use super::*;
use crate::owner_handoff::{
    repository::{read_generation, Journal},
    target::journal::ReadyIntent,
    target::protocol::{ready_error_reply, ready_reply},
    target::ready_resources::{ReadyFacts, TargetReadyPublisher, TargetReadyResources},
};

fn build_request(f: &Fixture, request_id: &str) -> ReadyRequest {
    let value = json!({
        "version": VERSION,
        "operation": "ready",
        "requestId": request_id,
        "transferId": f.released.id,
        "targetEpoch": f.context.owner.epoch,
        "expectedRevision": f.released.revision + 1,
    });
    ReadyRequest::parse(&serde_json::to_vec(&value).unwrap()).unwrap()
}

fn one_generation(f: &Fixture) -> String {
    f.journal
        .conn
        .query_row(
            "SELECT id FROM execution_generations WHERE owner_epoch=?1",
            [&f.context.owner.epoch],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn restricted_ready_publishes_exact_outcome_and_preserves_work() {
    let f = Fixture::new();
    let original = f.work();
    let claim = f.claim();
    let claim_record = claim.record().clone();
    let claim_revision = claim.record().revision;
    let registered = f.registered(&claim);
    let publisher =
        TargetReadyPublisher::new(claim, f.context.build.clone(), "target-event-epoch".into())
            .unwrap();
    let request = build_request(&f, &id());
    let ready = publisher
        .into_ready_target(registered, request.request_id())
        .unwrap();
    let outcome = ready.commit().unwrap();
    assert_eq!(outcome.record.phase, Phase::Ready);
    assert_eq!(outcome.record.revision, claim_revision + 1);
    assert_eq!(outcome.record.id, f.released.id);
    assert_eq!(outcome.record.target_epoch, f.context.owner.epoch);
    assert_eq!(outcome.record.capability_hash, f.released.capability_hash);
    assert_eq!(outcome.ready.record_revision, outcome.record.revision);
    assert_eq!(outcome.ready.owner_epoch, f.context.owner.epoch);
    assert_eq!(outcome.ready.profile_id, f.context.owner.profile);
    assert!(outcome.ready.snapshot_required);
    assert_eq!(outcome.ready.protocol_version, 11);
    assert!(!outcome.ready.event_epoch.is_empty());
    assert_eq!(f.work(), original);
    let generation = read_generation(&f.journal.conn, &one_generation(&f)).unwrap();
    // The target generation is rooted by the real registration join.
    assert!(generation.root.is_some());
    assert_eq!(
        f.journal.transfer(&f.released.id).unwrap().phase,
        Phase::Ready
    );
    let reopened = Journal::open(&f.directory.path().join("pi.sqlite"), true).unwrap();
    assert_eq!(
        reopened
            .target_ready_receipt(&ready_intent(
                &request,
                &claim_record,
                &f.context.owner,
                &generation,
                &outcome
            ))
            .unwrap(),
        Some(outcome)
    );
}

fn ready_intent(
    request: &ReadyRequest,
    claimed: &Transfer,
    owner: &Owner,
    generation: &Generation,
    outcome: &ReadyOutcome,
) -> ReadyIntent {
    ReadyIntent {
        request_id: request.request_id().into(),
        claimed: claimed.clone(),
        owner: owner.clone(),
        generation: generation.clone(),
        event_epoch: outcome.ready.event_epoch.clone(),
        protocol_version: crate::state::PROTOCOL_VERSION,
    }
}

#[test]
fn missing_generation_refuses_before_any_ready_write() {
    let f = Fixture::new();
    let claim = f.claim();
    let registered = f.registered(&claim);
    let publisher =
        TargetReadyPublisher::new(claim, f.context.build.clone(), "target-event-epoch".into())
            .unwrap();
    let request = build_request(&f, &id());
    let ready = publisher
        .into_ready_target(registered, request.request_id())
        .unwrap();
    let generation = one_generation(&f);
    f.journal
        .conn
        .execute(
            "DELETE FROM execution_generations WHERE id=?1",
            [&generation],
        )
        .unwrap();
    let before = f.snapshot();
    refused(ready.commit(), "TARGET_NOT_INITIALIZED");
    assert_eq!(f.snapshot(), before);
    assert_eq!(
        f.journal.transfer(&f.released.id).unwrap().phase,
        Phase::TargetClaimed
    );
}

#[test]
fn inconsistent_build_identity_capability_and_ready_version_refuse_explicitly() {
    let f = Fixture::new();
    let target = f.claim();
    let other = Build {
        sha256: model::digest(b"another build"),
        schema: f.context.build.schema,
        protocol: f.context.build.protocol,
    };
    refused(
        TargetReadyPublisher::new(f.claim(), other, "target-event-epoch".into()),
        "INCOMPATIBLE_BUILD",
    );
    let generation = generation(target.owner());
    let facts = ReadyFacts {
        owner: target.owner().clone(),
        generation,
        build: target.record().target_build.clone(),
        capability_hash: target.record().capability_hash.clone(),
        event_epoch: "target-event-epoch".into(),
        ready_version: VERSION,
    };
    TargetReadyResources::new(target.authority.clone(), facts.clone()).unwrap();
    for (bad, code) in [
        (
            ReadyFacts {
                generation: generation_of_other_owner(target.owner()),
                ..facts.clone()
            },
            "TARGET_IDENTITY_MISMATCH",
        ),
        (
            ReadyFacts {
                capability_hash: model::digest(b"other capability"),
                ..facts.clone()
            },
            "TARGET_IDENTITY_MISMATCH",
        ),
        (
            ReadyFacts {
                ready_version: VERSION + 1,
                ..facts.clone()
            },
            "UNSUPPORTED_VERSION",
        ),
        (
            ReadyFacts {
                event_epoch: "x".repeat(257),
                ..facts.clone()
            },
            "INVALID_READY",
        ),
    ] {
        refused(
            TargetReadyResources::new(target.authority.clone(), bad),
            code,
        );
    }
    // The provided facts object itself remains the authoritative shape.
    assert_eq!(facts.capability_hash, target.record().capability_hash);
}

fn generation_of_other_owner(owner: &Owner) -> Generation {
    let id = id();
    let epoch = uuid::Uuid::new_v4().to_string();
    Generation {
        version: VERSION,
        job_name: Generation::job_name(&owner.profile, &epoch, &id),
        id,
        owner_epoch: epoch,
        profile: owner.profile.clone(),
        root: None,
    }
}

#[test]
fn stale_revision_refuses_without_overwriting_claim() {
    let f = Fixture::new();
    let claim = f.claim();
    let registered = f.registered(&claim);
    let publisher =
        TargetReadyPublisher::new(claim, f.context.build.clone(), "target-event-epoch".into())
            .unwrap();
    let request = build_request(&f, &id());
    let ready = publisher
        .into_ready_target(registered, request.request_id())
        .unwrap();
    let mut changed = f.journal.transfer(&f.released.id).unwrap();
    changed.revision += 1;
    f.journal
        .conn
        .execute(
            "UPDATE owner_handoffs SET revision=?1,record_json=?2 WHERE id=?3",
            params![
                changed.revision,
                model::encode(&changed).unwrap(),
                changed.id
            ],
        )
        .unwrap();
    let before = f.snapshot();
    refused(ready.commit(), "STALE_REVISION");
    // The retained generation is closed by the target join's abort path, not
    // by a Ready transaction that refused before any write.
    let claim = f.journal.transfer(&f.released.id).unwrap();
    assert_eq!(claim, changed);
    assert_eq!(claim.phase, Phase::TargetClaimed);
    let root: Option<String> = f
        .journal
        .conn
        .query_row(
            "SELECT json_extract(record_json,'$.root') FROM execution_generations WHERE owner_epoch=?1",
            [&f.context.owner.epoch],
            |row| row.get(0),
        )
        .unwrap();
    assert!(root.is_some());
    assert!(f.snapshot().contains(&changed.id));
    assert!(before.contains(&changed.id));
}

#[test]
fn ready_request_protocol_is_strict_and_bounded() {
    let f = Fixture::new();
    let valid = build_request(&f, &id());
    assert_eq!(valid.request_id().len(), 36);
    let base = json!({
        "version": VERSION, "operation": "ready", "requestId": id(),
        "transferId": f.released.id, "targetEpoch": f.context.owner.epoch,
        "expectedRevision": f.released.revision + 1,
    });
    let encode = |value: &Value| serde_json::to_vec(value).unwrap();
    refused(ReadyRequest::parse(&[]), "INVALID_FRAME");
    refused(
        ReadyRequest::parse(&vec![b' '; model::MAX_RECORD_BYTES + 1]),
        "INVALID_FRAME",
    );
    for (field, value) in [
        ("version", json!(2)),
        ("operation", json!("status")),
        ("requestId", json!("not-a-uuid")),
        ("transferId", json!("not-a-uuid")),
        ("targetEpoch", json!("not-a-uuid")),
        ("expectedRevision", json!(0)),
        ("expectedRevision", json!(9_007_199_254_740_992_i64)),
    ] {
        let mut bad = base.clone();
        bad[field] = value;
        let code = if field == "version" {
            "UNSUPPORTED_VERSION"
        } else if field == "expectedRevision" {
            "INVALID_REVISION"
        } else if field == "operation" {
            "INVALID_REQUEST"
        } else {
            "INVALID_IDENTITY"
        };
        refused(ReadyRequest::parse(&encode(&bad)), code);
    }
    let mut extra = base.clone();
    extra["extra"] = json!(true);
    refused(ReadyRequest::parse(&encode(&extra)), "INVALID_REQUEST");

    // Binding to the exact committed claim is separate from syntax.
    let claim = f.claim();
    let mut wrong = base.clone();
    wrong["transferId"] = json!(id());
    refused(
        ReadyRequest::parse(&encode(&wrong)).unwrap().check(&claim),
        "TARGET_IDENTITY_MISMATCH",
    );
    let mut stale = base;
    stale["expectedRevision"] = json!(f.released.revision);
    refused(
        ReadyRequest::parse(&encode(&stale)).unwrap().check(&claim),
        "STALE_REVISION",
    );
}

#[test]
fn ready_reply_and_error_reply_are_bounded_and_classified() {
    let f = Fixture::new();
    let claim = f.claim();
    let registered = f.registered(&claim);
    let publisher =
        TargetReadyPublisher::new(claim, f.context.build.clone(), "target-event-epoch".into())
            .unwrap();
    let request = build_request(&f, &id());
    let outcome = publisher
        .into_ready_target(registered, request.request_id())
        .unwrap()
        .commit()
        .unwrap();
    let reply: Value = serde_json::from_slice(&ready_reply(&outcome).unwrap()).unwrap();
    assert_eq!(reply["version"], json!(VERSION));
    assert_eq!(reply["ready"]["record"]["phase"], json!("ready"));
    assert_eq!(
        reply["ready"]["ready"]["recordRevision"],
        json!(outcome.record.revision)
    );
    let error = anyhow::anyhow!("HANDOFF_TARGET_NOT_INITIALIZED");
    let error_reply: Value = serde_json::from_slice(&ready_error_reply(&error).unwrap()).unwrap();
    assert_eq!(
        error_reply,
        json!({"version":1,"error":{"code":"HANDOFF_TARGET_NOT_INITIALIZED"}})
    );
    let incidental = anyhow::anyhow!("C:\\secret\\path");
    let error_reply: Value =
        serde_json::from_slice(&ready_error_reply(&incidental).unwrap()).unwrap();
    assert_eq!(
        error_reply,
        json!({"version":1,"error":{"code":"HANDOFF_REFUSED"}})
    );
}
