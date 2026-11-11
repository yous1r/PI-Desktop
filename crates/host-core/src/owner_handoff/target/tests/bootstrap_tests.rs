use super::*;

#[test]
fn strict_envelope_uses_committed_commands_and_rejects_proof_flags_and_secrets_on_argv() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../packages/shared/test/fixtures/owner-handoff.json"
    ))
    .unwrap();
    // The shared fixture records schema 30 (the H2 acceptance build). Envelope
    // parsing pins the current build identity, so the committed command shapes
    // are exercised against the schema this binary actually accepts.
    let mut target_build = fixture["response"]["record"]["targetBuild"].clone();
    target_build["schema"] = json!(crate::db::SCHEMA_VERSION);
    for command in fixture["bootstrap"].as_array().unwrap() {
        let envelope = json!({"version":1,"profileId":fixture["response"]["record"]["profile"],
            "targetBuild":target_build,"command":command});
        assert_eq!(parse(&envelope).is_ok(), command["operation"] != "status");
    }
    let f = Fixture::new();
    let valid = f.envelope();
    for (field, value) in [
        ("version", json!(2)),
        ("profileId", json!("bad")),
        ("nativeProof", json!(true)),
        ("idle", json!(true)),
    ] {
        let mut input = valid.clone();
        input[field] = value;
        assert!(parse(&input).is_err());
    }
    for (field, value) in [
        ("version", json!(2)),
        ("request_id", json!(uuid::Uuid::nil().to_string())),
        ("transfer_id", json!("ABCDEFAB-0000-4000-8000-000000000001")),
        ("source_epoch", valid["command"]["target_epoch"].clone()),
        ("expected_revision", json!(0)),
        ("expected_revision", json!(9_007_199_254_740_992i64)),
        ("expected_revision", json!(1.5)),
        ("capability", json!("invalid-secret-value")),
        ("nativeProof", json!(true)),
        ("owner", json!({"pid":1})),
    ] {
        let mut input = valid.clone();
        input["command"][field] = value;
        let error = parse(&input).err().expect("must reject").to_string();
        assert!(!error.contains("invalid-secret-value"));
    }
    let raw = serde_json::to_string(&valid).unwrap();
    let duplicate = raw.replacen("\"version\":1", "\"version\":1,\"version\":1", 1);
    refused(
        BootstrapRequest::parse(duplicate.as_bytes()),
        "INVALID_REQUEST",
    );
    refused(
        BootstrapRequest::parse(&vec![b' '; model::MAX_RECORD_BYTES + 1]),
        "INVALID_FRAME",
    );
    let mut exact = raw.as_bytes().to_vec();
    exact.resize(model::MAX_RECORD_BYTES, b' ');
    assert!(BootstrapRequest::parse(&exact).is_ok());
    assert!(requested(&[FLAG.into()]).unwrap());
    assert!(!requested(&[]).unwrap());
    assert!(requested(&[FLAG.into(), f.capability.into()]).is_err());
}

#[test]
fn preclaim_refusals_leave_populated_journal_and_user_work_unchanged() {
    let f = Fixture::new();
    let before = f.snapshot();
    let mut cases = Vec::new();
    for (field, value) in [
        ("profileId", json!(model::digest(b"other profile"))),
        (
            "targetBuild",
            json!(Build {
                sha256: model::digest(b"other build"),
                ..f.context.build.clone()
            }),
        ),
    ] {
        let mut input = f.envelope();
        input[field] = value;
        cases.push(input);
    }
    for (field, value) in [
        ("capability", json!(id())),
        ("source_epoch", json!(id())),
        ("target_epoch", json!(id())),
        ("expected_revision", json!(f.released.revision + 1)),
    ] {
        let mut input = f.envelope();
        input["command"][field] = value;
        cases.push(input);
    }
    for input in cases {
        assert!(bootstrap::claim_locked(
            f.directory.path(),
            f.lock.clone(),
            &f.context,
            &parse(&input).unwrap(),
            &mut Ended::default()
        )
        .is_err());
        assert_eq!(f.snapshot(), before);
    }
    for proof in [
        Ended {
            reject_owner: Some(f.source.epoch.clone()),
            ..Default::default()
        },
        Ended {
            reject_generation: Some(f.source_generation.id.clone()),
            ..Default::default()
        },
    ] {
        assert!(bootstrap::claim_locked(
            f.directory.path(),
            f.lock.clone(),
            &f.context,
            &f.request(),
            &mut { proof }
        )
        .is_err());
        assert_eq!(f.snapshot(), before);
    }
    let foreign = ContextIdentity {
        owner: Owner {
            host: ProcessIdentity {
                sid: "S-1-5-21-999".into(),
                ..process(21)
            },
            coordinator: ProcessIdentity {
                sid: "S-1-5-21-999".into(),
                ..process(22)
            },
            ..f.context.owner.clone()
        },
        build: f.context.build.clone(),
    };
    refused(
        bootstrap::claim_locked(
            f.directory.path(),
            f.lock.clone(),
            &foreign,
            &f.request(),
            &mut Ended::default(),
        ),
        "PROFILE_MISMATCH",
    );
    assert_eq!(f.snapshot(), before);
}

#[test]
fn claim_preserves_exact_owner_and_lock_and_duplicate_does_not_grant_another_process() {
    let f = Fixture::new();
    let work = f.work();
    let target = f.claim();
    assert_eq!(target.owner(), &f.context.owner);
    assert_eq!(target.record().target_epoch, f.released.target_epoch);
    assert_eq!(target.record().requester, f.released.requester);
    assert_eq!(f.work(), work);
    assert!(DataDirectoryOwner::acquire(f.directory.path()).is_err());
    assert!(crate::owner_handoff::startup::inspect(
        &f.directory.path().join("pi.sqlite"),
        Some(&f.source.profile),
        &mut Ended::default()
    )
    .is_err());
    let before = f.snapshot();
    assert_eq!(f.claim().record(), target.record());
    assert_eq!(f.snapshot(), before);
    let changed = ContextIdentity {
        owner: Owner {
            host: process(31),
            ..f.context.owner.clone()
        },
        build: f.context.build.clone(),
    };
    refused(
        bootstrap::claim_locked(
            f.directory.path(),
            f.lock.clone(),
            &changed,
            &f.request(),
            &mut Ended::default(),
        ),
        "REQUEST_CONFLICT",
    );
    let mut changed_payload = f.envelope();
    changed_payload["command"]["expected_revision"] = json!(f.released.revision + 1);
    refused(
        bootstrap::claim_locked(
            f.directory.path(),
            f.lock.clone(),
            &f.context,
            &parse(&changed_payload).unwrap(),
            &mut Ended::default(),
        ),
        "REQUEST_CONFLICT",
    );
    assert_eq!(f.snapshot(), before);
}

#[test]
fn retained_retired_generation_is_proven_even_after_explicit_rotation() {
    let mut f = Fixture::new();
    let first = f.claim();
    let registered = f.registered(&first);
    let old_generation = registered.record().id.clone();
    let mut recover = f.envelope();
    recover["command"]["operation"] = json!("recover");
    recover["command"]["request_id"] = json!(id());
    recover["command"]["expected_revision"] = json!(first.record().revision);
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
    let mut proof = Ended::default();
    let rotated = bootstrap::execute_locked(
        f.directory.path(),
        &f.lock,
        &context,
        &parse(&recover).unwrap(),
        &mut proof,
    )
    .unwrap();
    assert!(proof.owners.contains(&f.source.epoch));
    assert!(proof.owners.contains(&first.owner().epoch));
    assert!(proof.generations.contains(&old_generation));
    assert_eq!(rotated.phase, Phase::ReleasePending);
    assert!(f.journal.active_owners().unwrap().is_empty());
    let mut claim = recover;
    claim["command"]["operation"] = json!("claim");
    claim["command"]["request_id"] = json!(id());
    claim["command"]["expected_revision"] = json!(rotated.revision);
    let before = f.snapshot();
    refused(
        bootstrap::claim_locked(
            f.directory.path(),
            f.lock.clone(),
            &context,
            &parse(&claim).unwrap(),
            &mut Ended {
                reject_generation: Some(old_generation),
                ..Default::default()
            },
        ),
        "PREVIOUS_CONTAINMENT_ACTIVE",
    );
    assert_eq!(f.snapshot(), before);
    let target = bootstrap::claim_locked(
        f.directory.path(),
        f.lock.clone(),
        &context,
        &parse(&claim).unwrap(),
        &mut Ended::default(),
    )
    .unwrap();
    assert_eq!(target.record().recovery_attempt, 1);
    assert_eq!(f.journal.active_owners().unwrap(), vec![context.owner]);
    // The superseded capability cannot register or bind anything after rotation.
    assert!(first.prepare_generation(generation(first.owner())).is_err());
    assert!(f
        .journal
        .register_generation(&generation(target.owner()))
        .is_err());
}

#[test]
fn generation_capability_retains_lock_after_bootstrap_and_only_initializes_once() {
    let mut f = Fixture::new();
    let target = f.claim();
    let guard = target.directory_owner();
    let prepared = target
        .prepare_generation(generation(target.owner()))
        .unwrap();
    assert_eq!(prepared.owner(), target.owner());
    assert!(f
        .journal
        .bind_root(&prepared.record().id, &process(23))
        .is_err());
    assert!(target
        .prepare_generation(generation(target.owner()))
        .is_err());
    let registered = prepared.bind_root(&process(23)).unwrap();
    assert!(prepared.bind_root(&process(24)).is_err());
    f.journal.close_generation(&registered.record().id).unwrap();
    assert!(target
        .prepare_generation(generation(target.owner()))
        .is_err());
    let directory = f.directory.path().to_owned();
    drop(target);
    drop(guard);
    drop(f.lock);
    assert!(DataDirectoryOwner::acquire(&directory).is_err());
    drop(prepared);
    drop(registered);
    assert!(DataDirectoryOwner::acquire(&directory).is_ok());
}

#[test]
fn corrupt_history_cannot_hide_predecessors_behind_pagination_cursor() {
    for table in ["execution_owners", "execution_generations"] {
        let f = Fixture::new();
        f.journal
            .conn
            .execute(&format!("UPDATE {table} SET sequence=0"), [])
            .unwrap();
        let before = f.snapshot();
        refused(
            bootstrap::claim_locked(
                f.directory.path(),
                f.lock.clone(),
                &f.context,
                &f.request(),
                &mut Ended::default(),
            ),
            "CORRUPT_HISTORY",
        );
        assert_eq!(f.snapshot(), before);
    }
}
