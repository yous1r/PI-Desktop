//! Source journal behaviour on a real SQLite journal. Each case drives the
//! public `Journal` surface only (plus direct SQL where a test has to simulate
//! a storage fault or a stale receipt row) and asserts on durable rows, not on
//! call counts, so the checks stay meaningful if internals move.
use super::*;
use crate::{
    db::{Database, SCHEMA_VERSION},
    owner_handoff::{
        model::{self, Build, Generation, Owner, Phase, ProcessIdentity, Transfer, VERSION},
        repository::Journal,
        transitions::{Mutation, Request as LegacyRequest},
    },
};
use rusqlite::params;
use std::path::PathBuf;

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn digest(seed: &[u8]) -> String {
    model::digest(seed)
}
fn principal() -> String {
    "S-1-5-21-1234".into()
}
fn process(pid: u32, sid: &str) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        created_at: "134115649234567891".into(),
        sid: sid.into(),
        image: "C:\\fixture\\host.exe".into(),
    }
}
fn build() -> Build {
    Build {
        sha256: digest(b"fixture build"),
        schema: SCHEMA_VERSION as u32,
        protocol: VERSION,
    }
}
fn owner(profile: &[u8], sid: &str) -> Owner {
    Owner {
        version: VERSION,
        epoch: uuid(),
        profile: digest(profile),
        host: process(11, sid),
        coordinator: process(12, sid),
    }
}
fn generation(owner: &Owner) -> Generation {
    let id = uuid();
    Generation {
        version: VERSION,
        job_name: Generation::job_name(&owner.profile, &owner.epoch, &id),
        id,
        owner_epoch: owner.epoch.clone(),
        profile: owner.profile.clone(),
        root: None,
    }
}
fn new_record(owner: &Owner, sid: &str) -> Transfer {
    Transfer {
        version: VERSION,
        id: uuid(),
        profile: owner.profile.clone(),
        source_epoch: owner.epoch.clone(),
        target_epoch: uuid(),
        source_build: build(),
        target_build: build(),
        requester: process(12, sid),
        capability_hash: digest(b"private fixture capability"),
        revision: 1,
        phase: Phase::Prepared,
        recovery_attempt: 0,
        last_failure: None,
    }
}
fn prepare(record: &Transfer, request_id: &str) -> Command {
    Command::Prepare {
        version: VERSION,
        request_id: request_id.into(),
        source_epoch: record.source_epoch.clone(),
        transfer_id: record.id.clone(),
        expected_revision: 0,
        target_epoch: record.target_epoch.clone(),
        capability_hash: record.capability_hash.clone(),
        target_build: record.target_build.clone(),
    }
}
fn fence(record: &Transfer, request_id: &str, expected_revision: u64) -> Command {
    Command::Fence {
        version: VERSION,
        request_id: request_id.into(),
        source_epoch: record.source_epoch.clone(),
        transfer_id: record.id.clone(),
        expected_revision,
    }
}
fn cancel(record: &Transfer, request_id: &str, expected_revision: u64) -> Command {
    Command::Cancel {
        version: VERSION,
        request_id: request_id.into(),
        source_epoch: record.source_epoch.clone(),
        transfer_id: record.id.clone(),
        expected_revision,
    }
}
fn release(record: &Transfer, request_id: &str, expected_revision: u64) -> Command {
    Command::Release {
        version: VERSION,
        request_id: request_id.into(),
        source_epoch: record.source_epoch.clone(),
        transfer_id: record.id.clone(),
        expected_revision,
    }
}
fn status(record: &Transfer, request_id: &str) -> Command {
    Command::Status {
        version: VERSION,
        request_id: request_id.into(),
        source_epoch: record.source_epoch.clone(),
        transfer_id: record.id.clone(),
    }
}
fn preflight(record: &Transfer, request_id: &str) -> Command {
    Command::Preflight {
        version: VERSION,
        request_id: request_id.into(),
        source_epoch: record.source_epoch.clone(),
        target_build: build(),
    }
}
fn count(journal: &Journal, table: &str) -> i64 {
    journal
        .conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}
fn receipts(journal: &Journal) -> i64 {
    count(journal, "owner_handoff_receipts")
}
fn transfers(journal: &Journal) -> i64 {
    count(journal, "owner_handoffs")
}
fn closed(journal: &Journal, generation: &str) -> bool {
    journal
        .conn
        .query_row(
            "SELECT closed FROM execution_generations WHERE id=?1",
            [generation],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
        == 1
}

struct Fixture {
    directory: tempfile::TempDir,
    journal: Journal,
    owner: Owner,
    generation: String,
}
impl Fixture {
    /// Registered owner and generation, deliberately without a bound root.
    fn unbound() -> Self {
        let directory = tempfile::tempdir().unwrap();
        drop(Database::open_in_dir(directory.path()).unwrap());
        let mut journal = Journal::open(&directory.path().join("pi.sqlite"), false).unwrap();
        let owner = owner(b"fixture profile", &principal());
        journal.register_owner(&owner).unwrap();
        let registered = generation(&owner);
        journal.register_generation(&registered).unwrap();
        Self {
            directory,
            journal,
            owner,
            generation: registered.id,
        }
    }
    fn new() -> Self {
        let mut fixture = Self::unbound();
        fixture
            .journal
            .bind_root(&fixture.generation, &process(13, &fixture.owner.host.sid))
            .unwrap();
        fixture
    }
    fn path(&self) -> PathBuf {
        self.directory.path().join("pi.sqlite")
    }
    fn reopen(&mut self) {
        self.journal = Journal::open(&self.path(), false).unwrap();
    }
    fn prepared(&mut self) -> (Transfer, String) {
        let transfer = new_record(&self.owner, &principal());
        let request_id = uuid();
        let command = prepare(&transfer, &request_id);
        let prepared = self
            .journal
            .source_step(&principal(), &command, Step::Prepare(transfer.clone()))
            .unwrap();
        assert_eq!(prepared, transfer);
        (prepared, request_id)
    }
}

/// A second original owner with its own profile, so a generation can be named
/// that is registered but not bound to the transfer's source epoch.
fn foreign_generation(journal: &mut Journal) -> String {
    let other = owner(b"other fixture profile", &principal());
    journal.register_owner(&other).unwrap();
    let registration = generation(&other);
    journal.register_generation(&registration).unwrap();
    registration.id
}

#[test]
fn source_sequence_commits_each_step_and_reopens_without_rewinding_history() {
    let mut fixture = Fixture::new();
    let (prepared, prepare_id) = fixture.prepared();
    let prepare_command = prepare(&prepared, &prepare_id);

    let fence_id = uuid();
    let fence_command = fence(&prepared, &fence_id, 1);
    let fencing = fixture
        .journal
        .source_step(&principal(), &fence_command, Step::BeginFencing)
        .unwrap();
    assert_eq!((fencing.phase, fencing.revision), (Phase::SourceFencing, 2));
    fixture.reopen();
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), fencing);

    // A refused native confirmation keeps the durable intent and its code.
    let failed = fixture
        .journal
        .source_step(
            &principal(),
            &fence_command,
            Step::FenceFailure("EXIT_UNCONFIRMED".into()),
        )
        .unwrap();
    assert_eq!(failed.phase, Phase::SourceFencing);
    assert_eq!(failed.revision, 3);
    assert_eq!(failed.last_failure.as_deref(), Some("EXIT_UNCONFIRMED"));
    // Same request, same code: the stored receipt answers, no new revision.
    assert_eq!(
        fixture
            .journal
            .source_step(
                &principal(),
                &fence_command,
                Step::FenceFailure("EXIT_UNCONFIRMED".into()),
            )
            .unwrap(),
        failed
    );
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), failed);

    let fenced = fixture
        .journal
        .source_step(
            &principal(),
            &fence_command,
            Step::ConfirmFenced {
                generation: fixture.generation.clone(),
            },
        )
        .unwrap();
    assert_eq!((fenced.phase, fenced.revision), (Phase::SourceFenced, 4));
    assert_eq!(fenced.last_failure, None);
    let source_generation = fixture.generation.clone();
    assert!(closed(&fixture.journal, &source_generation));

    fixture.reopen();
    let release_id = uuid();
    let release_command = release(&prepared, &release_id, 4);
    let released = fixture
        .journal
        .source_step(&principal(), &release_command, Step::Release)
        .unwrap();
    assert_eq!(
        (released.phase, released.revision),
        (Phase::ReleasePending, 5)
    );
    assert_eq!(
        fixture
            .journal
            .source_step(&principal(), &release_command, Step::Release)
            .unwrap(),
        released
    );

    // Reopening exposes every committed row; history receipts stay historic.
    fixture.reopen();
    assert_eq!(fixture.journal.transfer(&released.id).unwrap(), released);
    assert_eq!(
        fixture
            .journal
            .source_receipt(&principal(), &prepare_command)
            .unwrap(),
        Some(prepared.clone())
    );
    assert_eq!(
        fixture
            .journal
            .source_receipt(&principal(), &fence_command)
            .unwrap(),
        Some(fenced.clone())
    );
    assert_eq!(
        fixture
            .journal
            .source_receipt(&principal(), &release_command)
            .unwrap(),
        Some(released.clone())
    );
    assert_eq!(fixture.journal.transfer(&released.id).unwrap(), released);
    assert_eq!(receipts(&fixture.journal), 3);
    assert_eq!(transfers(&fixture.journal), 1);
    // The first requester and the reserved successor stayed immutable.
    assert_eq!(prepared.requester, process(12, &principal()));
    assert_eq!(released.target_epoch, prepared.target_epoch);
}

#[test]
fn source_query_commands_never_leave_a_receipt() {
    let mut fixture = Fixture::new();
    let (prepared, prepare_id) = fixture.prepared();
    let before = receipts(&fixture.journal);
    for command in [status(&prepared, &uuid()), preflight(&prepared, &uuid())] {
        let error = fixture
            .journal
            .source_receipt(&principal(), &command)
            .unwrap_err()
            .to_string();
        assert!(error.contains("HANDOFF_INVALID_REQUEST"), "{error}");
        assert!(fixture
            .journal
            .source_step(&principal(), &command, Step::Release)
            .is_err());
    }
    // A read command cannot borrow the committed mutation receipt of a request.
    let borrowed = status(&prepared, &prepare_id);
    assert!(fixture
        .journal
        .source_receipt(&principal(), &borrowed)
        .is_err());
    assert_eq!(receipts(&fixture.journal), before);
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), prepared);
}

#[test]
fn source_cancel_and_fence_have_one_winner_across_connections() {
    let mut fixture = Fixture::new();
    let (prepared, _) = fixture.prepared();
    let path = fixture.path();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let contenders = [
        (cancel(&prepared, &uuid(), 1), Step::Cancel),
        (fence(&prepared, &uuid(), 1), Step::BeginFencing),
    ];
    let handles: Vec<_> = contenders
        .into_iter()
        .map(|(command, step)| {
            let path = path.clone();
            let barrier = barrier.clone();
            let principal = principal();
            std::thread::spawn(move || {
                let mut journal = Journal::open(&path, false).unwrap();
                barrier.wait();
                journal.source_step(&principal, &command, step)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let loser = results
        .iter()
        .find_map(|result| result.as_ref().err())
        .unwrap()
        .to_string();
    assert!(loser.contains("HANDOFF_STALE_REVISION"), "{loser}");

    fixture.reopen();
    let settled = fixture.journal.transfer(&prepared.id).unwrap();
    assert_eq!(settled.revision, 2);
    assert!(matches!(
        settled.phase,
        Phase::Cancelled | Phase::SourceFencing
    ));
    assert_eq!(receipts(&fixture.journal), 2);
}

#[test]
fn source_request_id_conflict_detects_target_capability_build_revision_and_epoch_drift() {
    let mut fixture = Fixture::new();
    let (prepared, prepare_id) = fixture.prepared();
    let fence_id = uuid();
    let fence_command = fence(&prepared, &fence_id, 1);
    let fencing = fixture
        .journal
        .source_step(&principal(), &fence_command, Step::BeginFencing)
        .unwrap();

    let mut drifted_target = prepared.clone();
    drifted_target.target_epoch = uuid();
    let mut drifted_capability = prepared.clone();
    drifted_capability.capability_hash = digest(b"other capability");
    let mut drifted_build = prepared.clone();
    drifted_build.target_build.sha256 = digest(b"other build");
    let mut drifted_epoch = fence(&prepared, &fence_id, 1);
    if let Command::Fence { source_epoch, .. } = &mut drifted_epoch {
        *source_epoch = uuid();
    }
    let variants = [
        prepare(&drifted_target, &prepare_id),
        prepare(&drifted_capability, &prepare_id),
        prepare(&drifted_build, &prepare_id),
        fence(&prepared, &fence_id, 2),
        drifted_epoch,
    ];
    let steps = [
        Step::Prepare(drifted_target),
        Step::Prepare(drifted_capability),
        Step::Prepare(drifted_build),
        Step::BeginFencing,
        Step::BeginFencing,
    ];
    for (command, step) in variants.into_iter().zip(steps) {
        let error = fixture
            .journal
            .source_step(&principal(), &command, step)
            .unwrap_err()
            .to_string();
        assert!(error.contains("HANDOFF_REQUEST_CONFLICT"), "{error}");
        assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), fencing);
    }
    assert_eq!(receipts(&fixture.journal), 2);
    // The committed request still replays exactly once.
    assert_eq!(
        fixture
            .journal
            .source_step(&principal(), &fence_command, Step::BeginFencing)
            .unwrap(),
        fencing
    );
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), fencing);
}

#[test]
fn source_mutation_refuses_a_different_sid() {
    let mut fixture = Fixture::new();
    let (prepared, prepare_id) = fixture.prepared();
    let fence_command = fence(&prepared, &uuid(), 1);
    let error = fixture
        .journal
        .source_step("S-1-5-21-999", &fence_command, Step::BeginFencing)
        .unwrap_err()
        .to_string();
    assert!(error.contains("HANDOFF_PRINCIPAL_MISMATCH"), "{error}");
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), prepared);
    assert_eq!(receipts(&fixture.journal), 1);
    // A foreign principal cannot open a second transfer either.
    let intruder = new_record(&fixture.owner, &principal());
    let intruder_command = prepare(&intruder, &uuid());
    let error = fixture
        .journal
        .source_step("S-1-5-21-999", &intruder_command, Step::Prepare(intruder))
        .unwrap_err()
        .to_string();
    assert!(error.contains("HANDOFF_PROFILE_MISMATCH"), "{error}");
    assert_eq!(transfers(&fixture.journal), 1);
    // Receipts are per principal, so another SID observes nothing.
    assert_eq!(
        fixture
            .journal
            .source_receipt("S-1-5-21-999", &prepare(&prepared, &prepare_id))
            .unwrap(),
        None
    );
}

#[test]
fn source_prepare_replay_keeps_the_first_requester_and_ignores_a_new_cli_identity() {
    let mut fixture = Fixture::new();
    let (prepared, prepare_id) = fixture.prepared();
    let command = prepare(&prepared, &prepare_id);
    // A fresh CLI with the same SID but a new process identity replays Prepare.
    let mut replacement = prepared.clone();
    replacement.requester = ProcessIdentity {
        pid: 99,
        created_at: "134115649299999999".into(),
        sid: principal(),
        image: "C:\\fixture\\new-cli.exe".into(),
    };
    let replayed = fixture
        .journal
        .source_step(&principal(), &command, Step::Prepare(replacement))
        .unwrap();
    assert_eq!(replayed, prepared);
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), prepared);
    assert_eq!(receipts(&fixture.journal), 1);
    let stored: Transfer = model::decode(
        &fixture
            .journal
            .conn
            .query_row("SELECT record_json FROM owner_handoffs", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
    )
    .unwrap();
    assert_eq!(stored.requester, process(12, &principal()));
    assert_eq!(stored.requester.image, "C:\\fixture\\host.exe");
}

#[test]
fn source_receipt_domain_is_distinct_from_legacy_request_fingerprints() {
    let mut fixture = Fixture::new();
    let (prepared, prepare_id) = fixture.prepared();
    let prepare_command = prepare(&prepared, &prepare_id);
    // Domain separation is an explicit prefix, not a coincidental JSON shape.
    assert_ne!(
        fingerprint(&prepare_command).unwrap(),
        digest(model::encode(&prepare_command).unwrap().as_bytes())
    );
    let legacy = LegacyRequest {
        id: prepare_id.clone(),
        transfer_id: prepared.id.clone(),
        source_epoch: prepared.source_epoch.clone(),
        expected_revision: prepared.revision,
        mutation: Mutation::Recover {
            target_epoch: uuid(),
            capability_hash: digest(b"rotated capability"),
        },
    };
    let error = fixture
        .journal
        .receipt(&principal(), &legacy)
        .unwrap_err()
        .to_string();
    assert!(error.contains("HANDOFF_REQUEST_CONFLICT"), "{error}");
    assert!(fixture.journal.mutate(&principal(), &legacy).is_err());
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), prepared);
    assert_eq!(receipts(&fixture.journal), 1);

    // The reverse direction: a legacy receipt is not a source receipt.
    let shared_id = uuid();
    let legacy_failure = LegacyRequest {
        id: shared_id.clone(),
        transfer_id: prepared.id.clone(),
        source_epoch: prepared.source_epoch.clone(),
        expected_revision: prepared.revision,
        mutation: Mutation::Failure {
            code: "PROBE_FAILURE".into(),
        },
    };
    let failed = fixture
        .journal
        .mutate(&principal(), &legacy_failure)
        .unwrap();
    assert_eq!(failed.revision, 2);
    assert_eq!(failed.last_failure.as_deref(), Some("PROBE_FAILURE"));
    let source_claim = cancel(&prepared, &shared_id, failed.revision as u64);
    let error = fixture
        .journal
        .source_receipt(&principal(), &source_claim)
        .unwrap_err()
        .to_string();
    assert!(error.contains("HANDOFF_REQUEST_CONFLICT"), "{error}");
    assert!(fixture
        .journal
        .source_step(&principal(), &source_claim, Step::Cancel)
        .is_err());
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), failed);
}

#[test]
fn legacy_claim_and_recover_stay_legacy_and_do_not_rewind_source_receipts() {
    let mut fixture = Fixture::new();
    let (prepared, prepare_id) = fixture.prepared();
    let fence_command = fence(&prepared, &uuid(), 1);
    let fencing = fixture
        .journal
        .source_step(&principal(), &fence_command, Step::BeginFencing)
        .unwrap();
    assert_eq!(fencing.phase, Phase::SourceFencing);
    let fenced = fixture
        .journal
        .source_step(
            &principal(),
            &fence_command,
            Step::ConfirmFenced {
                generation: fixture.generation.clone(),
            },
        )
        .unwrap();
    let release_command = release(&prepared, &uuid(), fenced.revision as u64);
    let released = fixture
        .journal
        .source_step(&principal(), &release_command, Step::Release)
        .unwrap();
    assert_eq!(released.phase, Phase::ReleasePending);

    let mut target = owner(b"fixture profile", &principal());
    target.epoch = released.target_epoch.clone();
    target.profile = released.profile.clone();
    target.host.pid = 21;
    let claim = LegacyRequest {
        id: uuid(),
        transfer_id: released.id.clone(),
        source_epoch: released.source_epoch.clone(),
        expected_revision: released.revision,
        mutation: Mutation::Claim { owner: target },
    };
    let claimed = fixture.journal.mutate(&principal(), &claim).unwrap();
    assert_eq!(claimed.phase, Phase::TargetClaimed);
    assert_eq!(claimed.revision, released.revision + 1);

    let rotated = uuid();
    let recover = LegacyRequest {
        id: uuid(),
        transfer_id: claimed.id.clone(),
        source_epoch: claimed.source_epoch.clone(),
        expected_revision: claimed.revision,
        mutation: Mutation::Recover {
            target_epoch: rotated.clone(),
            capability_hash: digest(b"rotated capability"),
        },
    };
    let recovered = fixture.journal.mutate(&principal(), &recover).unwrap();
    assert_eq!(recovered.phase, Phase::ReleasePending);
    assert_eq!(recovered.target_epoch, rotated);
    assert_eq!(recovered.recovery_attempt, 1);

    // Source receipts stay at their own revision and cannot pull the journal back.
    assert_eq!(
        fixture
            .journal
            .source_receipt(&principal(), &prepare(&prepared, &prepare_id))
            .unwrap()
            .map(|item| (item.phase, item.revision)),
        Some((Phase::Prepared, 1))
    );
    assert_eq!(
        fixture
            .journal
            .source_receipt(&principal(), &release_command)
            .unwrap()
            .map(|item| (item.phase, item.revision)),
        Some((Phase::ReleasePending, released.revision))
    );
    assert_eq!(
        fixture
            .journal
            .source_receipt(&principal(), &fence_command)
            .unwrap(),
        Some(fenced)
    );
    assert_eq!(fixture.journal.transfer(&recovered.id).unwrap(), recovered);
}

#[test]
fn source_failed_receipt_commit_rolls_back_prepare_and_closed_generation() {
    let mut fixture = Fixture::new();
    let pending = new_record(&fixture.owner, &principal());
    let prepare_command = prepare(&pending, &uuid());
    fixture
        .journal
        .conn
        .execute_batch(
            "CREATE TRIGGER refuse_source_receipt BEFORE INSERT ON owner_handoff_receipts
             BEGIN SELECT RAISE(ABORT, 'fixture unavailable'); END;",
        )
        .unwrap();
    assert!(fixture
        .journal
        .source_step(
            &principal(),
            &prepare_command,
            Step::Prepare(pending.clone())
        )
        .is_err());
    assert_eq!(transfers(&fixture.journal), 0);
    assert_eq!(receipts(&fixture.journal), 0);
    assert_eq!(
        fixture
            .journal
            .active_transfer(&fixture.owner.profile)
            .unwrap(),
        None
    );
    assert_eq!(
        fixture
            .journal
            .source_receipt(&principal(), &prepare_command)
            .unwrap(),
        None
    );
    fixture
        .journal
        .conn
        .execute_batch("DROP TRIGGER refuse_source_receipt;")
        .unwrap();
    assert_eq!(
        fixture
            .journal
            .source_step(
                &principal(),
                &prepare_command,
                Step::Prepare(pending.clone())
            )
            .unwrap(),
        pending
    );

    // The fencing confirmation closes the generation and commits the phase
    // together; a refused receipt write must undo both.
    let fence_command = fence(&pending, &uuid(), 1);
    let fencing = fixture
        .journal
        .source_step(&principal(), &fence_command, Step::BeginFencing)
        .unwrap();
    fixture
        .journal
        .conn
        .execute_batch(
            "CREATE TRIGGER refuse_source_receipt BEFORE UPDATE ON owner_handoff_receipts
             BEGIN SELECT RAISE(ABORT, 'fixture unavailable'); END;",
        )
        .unwrap();
    assert!(fixture
        .journal
        .source_step(
            &principal(),
            &fence_command,
            Step::ConfirmFenced {
                generation: fixture.generation.clone(),
            },
        )
        .is_err());
    let source_generation = fixture.generation.clone();
    assert_eq!(fixture.journal.transfer(&pending.id).unwrap(), fencing);
    assert!(!closed(&fixture.journal, &source_generation));
    assert_eq!(
        fixture
            .journal
            .source_receipt(&principal(), &fence_command)
            .unwrap(),
        Some(fencing)
    );
    fixture
        .journal
        .conn
        .execute_batch("DROP TRIGGER refuse_source_receipt;")
        .unwrap();
    let fenced = fixture
        .journal
        .source_step(
            &principal(),
            &fence_command,
            Step::ConfirmFenced {
                generation: source_generation.clone(),
            },
        )
        .unwrap();
    assert_eq!((fenced.phase, fenced.revision), (Phase::SourceFenced, 3));
    assert!(closed(&fixture.journal, &source_generation));
    assert_eq!(
        fixture
            .journal
            .source_receipt(&principal(), &fence_command)
            .unwrap(),
        Some(fenced)
    );
}

#[test]
fn source_confirm_fenced_requires_prior_fence_receipt() {
    let mut fixture = Fixture::new();
    let (prepared, _) = fixture.prepared();
    let request_id = uuid();
    let skip = fence(&prepared, &request_id, 1);
    for step in [
        Step::ConfirmFenced {
            generation: fixture.generation.clone(),
        },
        Step::FenceFailure("EXIT_UNCONFIRMED".into()),
    ] {
        let error = fixture
            .journal
            .source_step(&principal(), &skip, step)
            .unwrap_err()
            .to_string();
        assert!(error.contains("HANDOFF_INVALID_TRANSITION"), "{error}");
        assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), prepared);
        assert_eq!(receipts(&fixture.journal), 1);
    }
}

#[test]
fn source_confirm_fenced_requires_the_bound_original_generation() {
    // Registered but unbound generation: the original root was never proven.
    let mut unbound = Fixture::unbound();
    let (prepared, _) = unbound.prepared();
    let fence_command = fence(&prepared, &uuid(), 1);
    let fencing = unbound
        .journal
        .source_step(&principal(), &fence_command, Step::BeginFencing)
        .unwrap();
    let unbound_generation = unbound.generation.clone();
    let error = unbound
        .journal
        .source_step(
            &principal(),
            &fence_command,
            Step::ConfirmFenced {
                generation: unbound_generation.clone(),
            },
        )
        .unwrap_err()
        .to_string();
    assert!(error.contains("HANDOFF_OWNER_CHANGED"), "{error}");
    assert_eq!(unbound.journal.transfer(&prepared.id).unwrap(), fencing);
    assert!(!closed(&unbound.journal, &unbound_generation));

    // A generation of another original owner can never be named.
    let mut fixture = Fixture::new();
    let (prepared, _) = fixture.prepared();
    let fence_command = fence(&prepared, &uuid(), 1);
    let fencing = fixture
        .journal
        .source_step(&principal(), &fence_command, Step::BeginFencing)
        .unwrap();
    let foreign = foreign_generation(&mut fixture.journal);
    let error = fixture
        .journal
        .source_step(
            &principal(),
            &fence_command,
            Step::ConfirmFenced {
                generation: foreign.clone(),
            },
        )
        .unwrap_err()
        .to_string();
    assert!(error.contains("HANDOFF_OWNER_CHANGED"), "{error}");
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), fencing);
    assert!(!closed(&fixture.journal, &foreign));
    assert!(!closed(&fixture.journal, &fixture.generation));
    // The bound original generation still completes.
    let fenced = fixture
        .journal
        .source_step(
            &principal(),
            &fence_command,
            Step::ConfirmFenced {
                generation: fixture.generation.clone(),
            },
        )
        .unwrap();
    assert_eq!(fenced.phase, Phase::SourceFenced);
}

#[test]
fn source_stale_receipt_cannot_advance_or_rewind_a_later_phase() {
    let mut fixture = Fixture::new();
    let (prepared, _) = fixture.prepared();
    let fence_id = uuid();
    let fence_command = fence(&prepared, &fence_id, 1);
    let fencing = fixture
        .journal
        .source_step(&principal(), &fence_command, Step::BeginFencing)
        .unwrap();
    let fenced = fixture
        .journal
        .source_step(
            &principal(),
            &fence_command,
            Step::ConfirmFenced {
                generation: fixture.generation.clone(),
            },
        )
        .unwrap();
    // Simulate a receipt row left behind by an earlier step of the same request.
    assert_eq!(
        fixture
            .journal
            .conn
            .execute(
                "UPDATE owner_handoff_receipts SET result_json=?1 WHERE request_id=?2",
                params![model::encode(&fencing).unwrap(), &fence_id],
            )
            .unwrap(),
        1
    );
    let error = fixture
        .journal
        .source_step(&principal(), &fence_command, Step::BeginFencing)
        .unwrap_err()
        .to_string();
    assert!(error.contains("HANDOFF_STALE_REVISION"), "{error}");
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), fenced);
    let source_generation = fixture.generation.clone();
    assert!(closed(&fixture.journal, &source_generation));
    // A fresh request cannot skip the durable phase from the same revision.
    let skip = fence(&prepared, &uuid(), fenced.revision as u64);
    let error = fixture
        .journal
        .source_step(&principal(), &skip, Step::BeginFencing)
        .unwrap_err()
        .to_string();
    assert!(error.contains("HANDOFF_INVALID_TRANSITION"), "{error}");
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), fenced);
    // The stale row stays a read-only observation.
    assert_eq!(
        fixture
            .journal
            .source_receipt(&principal(), &fence_command)
            .unwrap(),
        Some(fencing)
    );
    assert_eq!(fixture.journal.transfer(&prepared.id).unwrap(), fenced);
}
