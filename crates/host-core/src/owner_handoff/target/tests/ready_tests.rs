use super::*;
use crate::owner_handoff::target::journal::ReadyIntent;

fn intent(
    target: &TargetBootstrap,
    registered: &RegisteredGeneration,
    request_id: &str,
) -> ReadyIntent {
    ReadyIntent {
        request_id: request_id.into(),
        claimed: target.record().clone(),
        owner: target.owner().clone(),
        generation: registered.record().clone(),
        event_epoch: "retained-event-source".into(),
        protocol_version: crate::state::PROTOCOL_VERSION,
    }
}

#[test]
fn populated_claim_initialization_ready_user_path_preserves_work_and_keeps_admission_closed() {
    let f = Fixture::new();
    let original = f.work();
    let target = f.claim();
    let registered = f.registered(&target);
    let resources = Resources::new(&registered, ResourceState::Running);
    let activity = resources.activity.clone();
    let event_epoch = resources.event_epoch.clone();
    let ready = ReadyTarget::new(registered, resources, &id()).unwrap();
    assert!(activity.admit(Ingress::Request).is_err());
    let committed = ready.commit().unwrap();
    assert_eq!(committed.record.phase, Phase::Ready);
    assert_eq!(committed.record.revision, target.record().revision + 1);
    assert_eq!(committed.record.requester, f.released.requester);
    assert_eq!(committed.ready.event_epoch, event_epoch);
    assert_eq!(committed.ready.owner_epoch, f.context.owner.epoch);
    assert_eq!(committed.ready.record_revision, committed.record.revision);
    assert!(committed.ready.snapshot_required);
    assert_eq!(committed.ready.protocol_version, 11);
    assert_eq!(f.work(), original);
    assert!(activity.admit(Ingress::Background).is_err());
    let reopened = Journal::open(&f.directory.path().join("pi.sqlite"), true).unwrap();
    assert_eq!(
        reopened
            .inspect_target(target.owner(), &f.released.id)
            .unwrap(),
        committed.record
    );
    assert!(reopened.inspect_target(&f.source, &f.released.id).is_err());
    assert!(reopened
        .active_transfer(&f.source.profile)
        .unwrap()
        .is_none());
    assert_eq!(
        reopened.active_owners().unwrap(),
        vec![f.context.owner.clone()]
    );
    assert!(!f.snapshot().contains(&f.capability));
    assert_eq!(ready.commit().unwrap(), committed);
    assert_eq!(f.work(), original);
    let before = f.snapshot();
    refused(
        bootstrap::claim_locked(
            f.directory.path(),
            f.lock.clone(),
            &f.context,
            &f.request(),
            &mut Ended::default(),
        ),
        "STALE_REVISION",
    );
    assert_eq!(f.snapshot(), before);
    let wire = serde_json::to_value(&committed.ready).unwrap();
    assert_eq!(
        wire,
        json!({"version":1,"transferId":f.released.id,"profileId":f.source.profile,
        "ownerEpoch":f.context.owner.epoch,"recordRevision":committed.record.revision,
        "eventEpoch":event_epoch,"protocolVersion":11,"snapshotRequired":true})
    );
}

#[test]
fn incomplete_original_resources_and_event_replacement_refuse_without_ready_or_auto_replay() {
    let f = Fixture::new();
    let target = f.claim();
    let registered = f.registered(&target);
    let resources = Resources::new(&registered, ResourceState::Incomplete);
    let ready = ReadyTarget::new(registered, resources, &id()).unwrap();
    let before = f.snapshot();
    for (state, code) in [
        (ResourceState::Incomplete, "NOT_INITIALIZED"),
        (ResourceState::Stopped, "NOT_INITIALIZED"),
        (ResourceState::Replaced, "OWNER_CHANGED"),
        (ResourceState::EventReplaced, "EVENT_STREAM_CHANGED"),
    ] {
        ready.resources().state.set(state);
        refused(ready.commit(), code);
        assert_eq!(f.snapshot(), before);
        assert!(ready.resources().activity.admit(Ingress::Request).is_err());
    }
    ready.resources().state.set(ResourceState::Running);
    let write = ready
        .resources()
        .activity
        .begin(crate::owner_handoff::activity::Kind::Write);
    refused(ready.commit(), "NOT_IDLE");
    write.finish(true);
    assert_eq!(f.snapshot(), before);
    drop(ready);
    assert_eq!(
        f.journal.transfer(&f.released.id).unwrap().phase,
        Phase::TargetClaimed
    );
    assert_eq!(f.snapshot(), before);
}

#[test]
fn failed_initialization_is_explicitly_recoverable_only_after_target_generation_proof() {
    let f = Fixture::new();
    let target = f.claim();
    let registered = f.registered(&target);
    let generation_id = registered.record().id.clone();
    let resources = Resources::new(&registered, ResourceState::Incomplete);
    let ready = ReadyTarget::new(registered, resources, &id()).unwrap();
    refused(ready.commit(), "NOT_INITIALIZED");
    let original = f.work();
    let mut recover = f.envelope();
    recover["command"]["operation"] = json!("recover");
    recover["command"]["request_id"] = json!(id());
    recover["command"]["expected_revision"] = json!(target.record().revision);
    recover["command"]["target_epoch"] = json!(id());
    recover["command"]["capability"] = json!(id());
    let context = ContextIdentity {
        owner: Owner {
            epoch: recover["command"]["target_epoch"].as_str().unwrap().into(),
            host: process(31),
            coordinator: process(32),
            ..f.context.owner.clone()
        },
        build: f.context.build.clone(),
    };
    let request = parse(&recover).unwrap();
    let before = f.snapshot();
    refused(
        bootstrap::execute_locked(
            f.directory.path(),
            &f.lock,
            &context,
            &request,
            &mut Ended {
                reject_generation: Some(generation_id),
                ..Default::default()
            },
        ),
        "PREVIOUS_CONTAINMENT_ACTIVE",
    );
    assert_eq!(f.snapshot(), before);
    let rotated = bootstrap::execute_locked(
        f.directory.path(),
        &f.lock,
        &context,
        &request,
        &mut Ended::default(),
    )
    .unwrap();
    assert_eq!(rotated.phase, Phase::ReleasePending);
    assert_eq!(rotated.recovery_attempt, 1);
    assert!(f.journal.active_owners().unwrap().is_empty());
    assert_eq!(f.work(), original);
    ready.resources().state.set(ResourceState::Running);
    assert!(ready.commit().is_err());
    assert_eq!(f.journal.transfer(&f.released.id).unwrap(), rotated);
    assert!(ready.resources().activity.admit(Ingress::Request).is_err());
}

#[test]
fn exact_ready_replay_remains_historical_after_resources_end_and_changed_payload_conflicts() {
    let mut f = Fixture::new();
    let target = f.claim();
    let registered = f.registered(&target);
    let resources = Resources::new(&registered, ResourceState::Running);
    let request_id = id();
    let mut request = intent(&target, &registered, &request_id);
    request.event_epoch = resources.event_epoch.clone();
    let ready = ReadyTarget::new(registered, resources, &request_id).unwrap();
    let committed = ready.commit().unwrap();
    // Model a lost output followed by resource teardown. Historical receipt
    // reconciliation cannot initialize anything or fabricate a rollback.
    ready.resources().state.set(ResourceState::Stopped);
    f.journal.close_generation(&request.generation.id).unwrap();
    f.journal.retire_owner(&target.owner().epoch).unwrap();
    let before = f.snapshot();
    assert_eq!(ready.commit().unwrap(), committed);
    assert_eq!(f.snapshot(), before);
    let reopened = Journal::open(&f.directory.path().join("pi.sqlite"), true).unwrap();
    assert_eq!(
        reopened.target_ready_receipt(&request).unwrap(),
        Some(committed)
    );
    let mut changed = request.clone();
    changed.event_epoch = "new-stream".into();
    refused(reopened.target_ready_receipt(&changed), "REQUEST_CONFLICT");
    let mut changed = request.clone();
    changed.claimed.revision += 1;
    refused(reopened.target_ready_receipt(&changed), "REQUEST_CONFLICT");
    let mut changed = request.clone();
    changed.owner.host.created_at = "134115649234567899".into();
    refused(reopened.target_ready_receipt(&changed), "REQUEST_CONFLICT");
    let mut changed = request.clone();
    changed.generation.root = Some(process(24));
    refused(reopened.target_ready_receipt(&changed), "REQUEST_CONFLICT");
    assert_eq!(f.snapshot(), before);
}

#[test]
fn ready_receipt_write_failure_rolls_back_phase_and_preserves_claim_for_explicit_retry() {
    let mut f = Fixture::new();
    let target = f.claim();
    let registered = f.registered(&target);
    let request = intent(&target, &registered, &id());
    // Inject failure on this connection after the phase UPDATE. A temporary
    // trigger preserves the production schema validator's exact table shape.
    f.journal.conn.execute_batch("CREATE TEMP TRIGGER reject_target_receipt BEFORE INSERT ON owner_handoff_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;").unwrap();
    let before = f.snapshot();
    assert!(f.journal.target_ready(&target.authority, &request).is_err());
    assert_eq!(f.snapshot(), before);
    assert_eq!(
        f.journal.transfer(&f.released.id).unwrap().phase,
        Phase::TargetClaimed
    );
    f.journal
        .conn
        .execute_batch("DROP TRIGGER reject_target_receipt;")
        .unwrap();
    assert_eq!(
        f.journal
            .target_ready(&target.authority, &request)
            .unwrap()
            .record
            .phase,
        Phase::Ready
    );
}

#[test]
fn ready_checks_exact_owner_generation_requester_and_revision_inside_transaction() {
    for variant in 0..8 {
        let mut f = Fixture::new();
        let target = f.claim();
        let registered = f.registered(&target);
        let request = intent(&target, &registered, &id());
        match variant {
            0 => {
                f.journal.close_generation(&registered.record().id).unwrap();
            }
            1 => {
                let mut replacement = registered.record().clone();
                replacement.root = Some(process(24));
                f.journal
                    .conn
                    .execute(
                        "UPDATE execution_generations SET record_json=?1 WHERE id=?2",
                        params![model::encode(&replacement).unwrap(), replacement.id],
                    )
                    .unwrap();
            }
            2 => {
                let mut replacement = target.owner().clone();
                replacement.host.created_at = "134115649234567899".into();
                f.journal
                    .conn
                    .execute(
                        "UPDATE execution_owners SET record_json=?1 WHERE epoch=?2",
                        params![model::encode(&replacement).unwrap(), replacement.epoch],
                    )
                    .unwrap();
            }
            3 => {
                let mut replacement = target.owner().clone();
                replacement.coordinator = process(32);
                f.journal
                    .conn
                    .execute(
                        "UPDATE execution_owners SET record_json=?1 WHERE epoch=?2",
                        params![model::encode(&replacement).unwrap(), replacement.epoch],
                    )
                    .unwrap();
            }
            4 => {
                f.journal.retire_owner(&target.owner().epoch).unwrap();
            }
            5 | 6 => {
                let mut changed = target.record().clone();
                if variant == 5 {
                    changed.revision += 1;
                } else {
                    changed.requester = process(19);
                }
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
            }
            7 => {
                f.journal.close_generation(&registered.record().id).unwrap();
                let mut replacement = generation(target.owner());
                replacement.root = Some(process(24));
                f.journal.conn.execute("INSERT INTO execution_generations(id,owner_epoch,record_json) VALUES(?1,?2,?3)", params![replacement.id,replacement.owner_epoch,model::encode(&replacement).unwrap()]).unwrap();
            }
            _ => unreachable!(),
        }
        let before = f.snapshot();
        assert!(
            f.journal.target_ready(&target.authority, &request).is_err(),
            "variant {variant}"
        );
        assert_eq!(f.snapshot(), before);
        assert_eq!(
            f.journal.transfer(&f.released.id).unwrap().phase,
            Phase::TargetClaimed
        );
    }
}

#[test]
fn ready_cannot_use_source_authority_or_borrow_claim_receipt_and_first_cas_wins() {
    let mut f = Fixture::new();
    let target = f.claim();
    let registered = f.registered(&target);
    let mut request = intent(&target, &registered, &f.claim_id);
    let before = f.snapshot();
    refused(
        f.journal.target_ready(&target.authority, &request),
        "REQUEST_CONFLICT",
    );
    request.request_id = id();
    let mut source = request.clone();
    source.owner = f.source.clone();
    refused(
        f.journal.target_ready(&target.authority, &source),
        "INVALID_READY",
    );
    let mut wrong_target = request.clone();
    wrong_target.owner.epoch = id();
    refused(
        f.journal.target_ready(&target.authority, &wrong_target),
        "INVALID_READY",
    );
    let mut wrong_requester = request.clone();
    wrong_requester.claimed.requester.sid = "S-1-5-21-999".into();
    refused(
        f.journal.target_ready(&target.authority, &wrong_requester),
        "INVALID_READY",
    );
    assert_eq!(f.snapshot(), before);
    let first = f.journal.target_ready(&target.authority, &request).unwrap();
    let mut second = request.clone();
    second.request_id = id();
    refused(
        f.journal.target_ready(&target.authority, &second),
        "STALE_REVISION",
    );
    assert_eq!(
        f.journal.target_ready(&target.authority, &request).unwrap(),
        first
    );
}

#[test]
fn event_and_revision_bounds_refuse_before_any_ready_write() {
    let mut f = Fixture::new();
    let target = f.claim();
    let registered = f.registered(&target);
    let base = intent(&target, &registered, &id());
    let before = f.snapshot();
    for epoch in [String::new(), "x\0y".into(), "x".repeat(257)] {
        let mut bad = base.clone();
        bad.event_epoch = epoch;
        refused(
            f.journal.target_ready(&target.authority, &bad),
            "INVALID_READY",
        );
    }
    let mut bad = base.clone();
    bad.protocol_version += 1;
    refused(
        f.journal.target_ready(&target.authority, &bad),
        "INVALID_READY",
    );
    let mut bad = base;
    bad.claimed.revision = 9_007_199_254_740_991;
    refused(
        f.journal.target_ready(&target.authority, &bad),
        "INVALID_READY",
    );
    assert_eq!(f.snapshot(), before);
}

#[test]
fn concurrent_ready_requests_commit_one_cas_and_one_retained_receipt() {
    let f = Fixture::new();
    let target = f.claim();
    let registered = f.registered(&target);
    let request = intent(&target, &registered, &id());
    let before: i64 = f
        .journal
        .conn
        .query_row("SELECT count(*) FROM owner_handoff_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let authority = target.authority.clone();
            let mut request = request.clone();
            request.request_id = id();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut journal = Journal::open(&authority.path, false).unwrap();
                barrier.wait();
                journal.target_ready(&authority, &request)
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let after: i64 = f
        .journal
        .conn
        .query_row("SELECT count(*) FROM owner_handoff_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(after, before + 1);
    assert_eq!(
        f.journal.transfer(&f.released.id).unwrap().phase,
        Phase::Ready
    );
}

#[test]
fn corrupted_ready_publication_is_not_replayed_as_a_success() {
    let mut f = Fixture::new();
    let target = f.claim();
    let registered = f.registered(&target);
    let request = intent(&target, &registered, &id());
    let mut committed = f.journal.target_ready(&target.authority, &request).unwrap();
    committed.ready.owner_epoch = id();
    f.journal
        .conn
        .execute(
            "UPDATE owner_handoff_receipts SET result_json=?1 WHERE principal=?2 AND request_id=?3",
            params![
                model::encode(&committed).unwrap(),
                request.owner.host.sid,
                request.request_id
            ],
        )
        .unwrap();
    let before = f.snapshot();
    refused(f.journal.target_ready_receipt(&request), "CORRUPT_RECEIPT");
    assert_eq!(f.snapshot(), before);
}
