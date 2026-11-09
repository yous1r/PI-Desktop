use super::model::*;
use super::repository::Journal;
use super::transitions::{Mutation, Request};
use crate::db::Database;

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn process(pid: u32) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        created_at: "134115649234567891".into(),
        sid: "S-1-5-21-1234".into(),
        image: "C:\\fixture\\host.exe".into(),
    }
}
fn owner() -> Owner {
    Owner {
        version: VERSION,
        epoch: id(),
        profile: digest(b"fixture profile"),
        host: process(11),
        coordinator: process(12),
    }
}
fn generation(owner: &Owner) -> Generation {
    let id = id();
    Generation {
        version: VERSION,
        job_name: Generation::job_name(&owner.profile, &owner.epoch, &id),
        id,
        owner_epoch: owner.epoch.clone(),
        profile: owner.profile.clone(),
        root: None,
    }
}
fn transfer(owner: &Owner) -> Transfer {
    let build = Build {
        sha256: digest(b"fixture build"),
        schema: crate::db::SCHEMA_VERSION as u32,
        protocol: VERSION,
    };
    Transfer {
        version: VERSION,
        id: id(),
        profile: owner.profile.clone(),
        source_epoch: owner.epoch.clone(),
        target_epoch: id(),
        source_build: build.clone(),
        target_build: build,
        requester: process(12),
        capability_hash: digest(b"private fixture capability"),
        revision: 1,
        phase: Phase::Prepared,
        recovery_attempt: 0,
        last_failure: None,
    }
}
fn request(record: &Transfer, mutation: Mutation) -> Request {
    Request {
        id: id(),
        transfer_id: record.id.clone(),
        source_epoch: record.source_epoch.clone(),
        expected_revision: record.revision,
        mutation,
    }
}
fn prepared(journal: &mut Journal, owner: &Owner) -> (Transfer, Request) {
    let record = transfer(owner);
    let mut request = request(
        &record,
        Mutation::Prepare {
            record: record.clone(),
        },
    );
    request.expected_revision = 0;
    assert_eq!(journal.mutate(&owner.host.sid, &request).unwrap(), record);
    (record, request)
}
fn fixture() -> (tempfile::TempDir, Journal, Owner) {
    let directory = tempfile::tempdir().unwrap();
    drop(Database::open_in_dir(directory.path()).unwrap());
    let mut journal = Journal::open(&directory.path().join("pi.sqlite"), false).unwrap();
    let owner = owner();
    journal.register_owner(&owner).unwrap();
    journal.register_generation(&generation(&owner)).unwrap();
    (directory, journal, owner)
}

#[test]
fn journal_user_path_reopens_every_phase_and_returns_original_receipt() {
    let (directory, mut journal, owner) = fixture();
    let (mut record, prepare) = prepared(&mut journal, &owner);
    for phase in [
        Phase::SourceFencing,
        Phase::SourceFenced,
        Phase::ReleasePending,
        Phase::TargetClaimed,
        Phase::Ready,
    ] {
        let expected = record.clone();
        drop(journal);
        journal = Journal::open(&directory.path().join("pi.sqlite"), false).unwrap();
        assert_eq!(journal.transfer(&record.id).unwrap(), expected);
        let change = request(&record, phase_mutation(&record, phase));
        record = journal.mutate(&owner.host.sid, &change).unwrap();
        assert_eq!(record.revision, expected.revision + 1);
        assert_eq!(journal.mutate(&owner.host.sid, &change).unwrap(), record);
    }
    assert!(journal.active_transfer(&owner.profile).unwrap().is_none());
    let original = journal.mutate(&owner.host.sid, &prepare).unwrap();
    assert_eq!(original.phase, Phase::Prepared);
    assert_eq!(original.revision, 1);
    assert_eq!(journal.transfer(&record.id).unwrap().phase, Phase::Ready);
    journal.conn.execute_batch("DELETE FROM sessions;").unwrap();
    let receipts: i64 = journal
        .conn
        .query_row("SELECT count(*) FROM owner_handoff_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(receipts, 6);
    let sync: i64 = journal
        .conn
        .query_row("PRAGMA synchronous", [], |row| row.get(0))
        .unwrap();
    assert_eq!(sync, 2);
}

#[test]
fn journal_duplicate_fingerprint_revision_principal_and_phase_conflicts_do_not_mutate() {
    let (_directory, mut journal, owner) = fixture();
    let (record, mut prepare) = prepared(&mut journal, &owner);
    prepare.mutation = Mutation::Advance {
        phase: Phase::SourceFencing,
    };
    assert!(journal
        .mutate(&owner.host.sid, &prepare)
        .unwrap_err()
        .to_string()
        .contains("REQUEST_CONFLICT"));
    let skip = request(
        &record,
        Mutation::Advance {
            phase: Phase::Ready,
        },
    );
    assert!(journal.mutate(&owner.host.sid, &skip).is_err());
    let mut stale = request(
        &record,
        Mutation::Advance {
            phase: Phase::SourceFencing,
        },
    );
    stale.expected_revision = 0;
    assert!(journal.mutate(&owner.host.sid, &stale).is_err());
    stale.expected_revision = 1;
    stale.source_epoch = id();
    assert!(journal.mutate(&owner.host.sid, &stale).is_err());
    assert!(journal.mutate("S-1-5-21-other", &skip).is_err());
    let mut second = transfer(&owner);
    second.id = id();
    let mut new_prepare = request(
        &second,
        Mutation::Prepare {
            record: second.clone(),
        },
    );
    new_prepare.expected_revision = 0;
    assert!(journal.mutate(&owner.host.sid, &new_prepare).is_err());
    assert_eq!(journal.transfer(&record.id).unwrap(), record);
    assert!(journal.register_generation(&generation(&owner)).is_err());
}

#[test]
fn journal_cancel_and_fence_cas_have_one_winner_across_connections() {
    let (directory, mut journal, owner) = fixture();
    let (record, _) = prepared(&mut journal, &owner);
    drop(journal);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = [Phase::Cancelled, Phase::SourceFencing]
        .into_iter()
        .map(|phase| {
            let path = directory.path().join("pi.sqlite");
            let principal = owner.host.sid.clone();
            let request = request(&record, Mutation::Advance { phase });
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut journal = Journal::open(&path, false).unwrap();
                barrier.wait();
                journal.mutate(&principal, &request)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let journal = Journal::open(&directory.path().join("pi.sqlite"), true).unwrap();
    let settled = journal.transfer(&record.id).unwrap();
    assert_eq!(settled.revision, 2);
    assert!(matches!(
        settled.phase,
        Phase::Cancelled | Phase::SourceFencing
    ));
}

#[test]
fn journal_failure_stays_blocked_and_explicit_recovery_rotates_target() {
    let (_directory, mut journal, owner) = fixture();
    let (record, _) = prepared(&mut journal, &owner);
    let failure = request(
        &record,
        Mutation::Failure {
            code: "EXIT_UNCONFIRMED".into(),
        },
    );
    let failed = journal.mutate(&owner.host.sid, &failure).unwrap();
    assert_eq!(failed.phase, Phase::Prepared);
    assert_eq!(failed.last_failure.as_deref(), Some("EXIT_UNCONFIRMED"));
    let new_epoch = id();
    let new_hash = digest(b"replacement capability");
    let recovery = request(
        &failed,
        Mutation::Recover {
            target_epoch: new_epoch.clone(),
            capability_hash: new_hash.clone(),
        },
    );
    let recovered = journal.mutate(&owner.host.sid, &recovery).unwrap();
    assert_eq!(recovered.phase, Phase::ReleasePending);
    assert_eq!(recovered.target_epoch, new_epoch);
    assert_eq!(recovered.capability_hash, new_hash);
    assert_eq!(recovered.recovery_attempt, 1);
    assert_eq!(
        journal.mutate(&owner.host.sid, &recovery).unwrap(),
        recovered
    );
    assert!(journal
        .mutate(
            &owner.host.sid,
            &request(
                &recovered,
                Mutation::Advance {
                    phase: Phase::Cancelled
                }
            )
        )
        .is_err());
}

#[test]
fn journal_registration_is_unique_bounded_and_keeps_prior_generations() {
    let (directory, mut journal, owner) = fixture();
    let initial = journal.generations(&owner.epoch, 0).unwrap().remove(0).1;
    journal.bind_root(&initial.id, &process(13)).unwrap();
    assert!(journal.bind_root(&initial.id, &process(14)).is_err());
    assert!(journal.register_generation(&generation(&owner)).is_err());
    journal.close_generation(&initial.id).unwrap();
    for _ in 0..101 {
        let generation = generation(&owner);
        journal.register_generation(&generation).unwrap();
        journal.close_generation(&generation.id).unwrap();
    }
    let first = journal.generations(&owner.epoch, 0).unwrap();
    assert_eq!(first.len(), PAGE_SIZE);
    let second = journal
        .generations(&owner.epoch, first.last().unwrap().0)
        .unwrap();
    assert_eq!(second.len(), 2);
    journal.retire_owner(&owner.epoch).unwrap();
    assert!(journal.active_owners().unwrap().is_empty());
    assert!(journal.register_generation(&generation(&owner)).is_err());
    drop(journal);
    let reopened = Journal::open(&directory.path().join("pi.sqlite"), true).unwrap();
    assert_eq!(
        reopened.generations(&owner.epoch, 0).unwrap()[0].1.root,
        Some(process(13))
    );
}

#[test]
fn journal_missing_generation_and_invalid_records_refuse_without_partial_receipt() {
    let directory = tempfile::tempdir().unwrap();
    drop(Database::open_in_dir(directory.path()).unwrap());
    let mut journal = Journal::open(&directory.path().join("pi.sqlite"), false).unwrap();
    let owner = owner();
    journal.register_owner(&owner).unwrap();
    let record = transfer(&owner);
    let mut prepare = request(
        &record,
        Mutation::Prepare {
            record: record.clone(),
        },
    );
    prepare.expected_revision = 0;
    assert!(journal
        .mutate(&owner.host.sid, &prepare)
        .unwrap_err()
        .to_string()
        .contains("SOURCE_UNSUPPORTED"));
    assert!(journal.active_transfer(&owner.profile).unwrap().is_none());
    let mut invalid = generation(&owner);
    invalid.job_name = "arbitrary job".into();
    assert!(journal.register_generation(&invalid).is_err());
    let mut invalid = owner.clone();
    invalid.host.created_at = "0134115649234567891".into();
    assert!(invalid.validate().is_err());
    let mut raw = serde_json::to_value(&owner).unwrap();
    raw["adoptPid"] = serde_json::json!(123);
    assert!(serde_json::from_value::<Owner>(raw).is_err());
    assert!(decode::<Owner>(&" ".repeat(MAX_RECORD_BYTES + 1)).is_err());
}

#[derive(Default)]
struct ProofProbe {
    fail: bool,
    owners: usize,
    generations: usize,
}
impl super::startup::NativeProof for ProofProbe {
    fn owner_ended(&mut self, _: &Owner) -> anyhow::Result<()> {
        self.owners += 1;
        if self.fail {
            anyhow::bail!("NATIVE_PROOF_UNAVAILABLE");
        }
        Ok(())
    }
    fn generation_ended(&mut self, _: &Generation) -> anyhow::Result<()> {
        self.generations += 1;
        if self.fail {
            anyhow::bail!("NATIVE_PROOF_UNAVAILABLE");
        }
        Ok(())
    }
}

#[test]
fn startup_refuses_every_unfinished_phase_before_recovery_or_owner_mutation() {
    let (directory, mut journal, owner) = fixture();
    let (mut record, _) = prepared(&mut journal, &owner);
    journal.conn.execute_batch("INSERT INTO sessions(id,title,created_at,updated_at) VALUES('kept','Keep',1,1);
        INSERT INTO turns(id,session_id,status,started_at) VALUES('running-turn','kept','running',1);").unwrap();
    for next in [
        Some(Phase::SourceFencing),
        Some(Phase::SourceFenced),
        Some(Phase::ReleasePending),
        Some(Phase::TargetClaimed),
        None,
    ] {
        let mut proof = ProofProbe::default();
        let error = super::startup::inspect(
            &directory.path().join("pi.sqlite"),
            Some(&owner.profile),
            &mut proof,
        )
        .unwrap_err();
        assert!(error.to_string().contains("RECOVERY_REQUIRED"));
        assert_eq!(proof.owners, 0);
        assert_eq!(journal.active_owners().unwrap().len(), 1);
        let status: String = journal
            .conn
            .query_row(
                "SELECT status FROM turns WHERE id='running-turn'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "running");
        if let Some(phase) = next {
            record = journal
                .mutate(
                    &owner.host.sid,
                    &request(&record, phase_mutation(&record, phase)),
                )
                .unwrap();
        }
    }
}

#[test]
fn startup_requires_native_proof_even_without_transfer_and_preserves_failure() {
    let (directory, journal, owner) = fixture();
    let path = directory.path().join("pi.sqlite");
    let mut denied = ProofProbe {
        fail: true,
        ..ProofProbe::default()
    };
    assert!(super::startup::inspect(&path, Some(&owner.profile), &mut denied).is_err());
    assert_eq!(journal.active_owners().unwrap(), vec![owner.clone()]);
    let mut proof = ProofProbe::default();
    assert!(super::startup::inspect(&path, Some(&digest(b"other profile")), &mut proof).is_err());
    assert_eq!(proof.owners, 0);
    assert_eq!(
        super::startup::inspect(&path, Some(&owner.profile), &mut proof).unwrap(),
        vec![owner.epoch.clone()]
    );
    assert_eq!((proof.owners, proof.generations), (1, 1));
    assert_eq!(journal.active_owners().unwrap().len(), 1);
}

#[test]
fn startup_rejects_unknown_downgraded_and_corrupted_metadata_without_writes() {
    let (directory, journal, owner) = fixture();
    let path = directory.path().join("pi.sqlite");
    for version in [crate::db::SCHEMA_VERSION + 1, 27] {
        journal
            .conn
            .pragma_update(None, "user_version", version)
            .unwrap();
        assert!(
            super::startup::inspect(&path, Some(&owner.profile), &mut ProofProbe::default())
                .is_err()
        );
        let actual: i64 = journal
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(actual, version);
    }
    journal
        .conn
        .pragma_update(None, "user_version", crate::db::SCHEMA_VERSION)
        .unwrap();
    journal
        .conn
        .execute("UPDATE execution_owners SET record_json='{}'", [])
        .unwrap();
    assert!(
        super::startup::inspect(&path, Some(&owner.profile), &mut ProofProbe::default()).is_err()
    );
    let raw: String = journal
        .conn
        .query_row("SELECT record_json FROM execution_owners", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(raw, "{}");
}

#[cfg(windows)]
#[test]
fn native_recovery_refuses_live_and_reused_process_identity() {
    let identity = crate::owner_control::identity::Identity::current().unwrap();
    let mut recorded = super::native::record(std::process::id(), &identity);
    assert!(super::native::process_ended(&recorded)
        .unwrap_err()
        .to_string()
        .contains("PROCESS_ALIVE"));
    recorded.created_at = (identity.created_at - 1).to_string();
    assert!(super::native::process_ended(&recorded)
        .unwrap_err()
        .to_string()
        .contains("IDENTITY_CHANGED"));
}

#[test]
fn journal_pending_root_cannot_bind_after_transfer_or_owner_retirement() {
    for retired in [false, true] {
        let (_directory, mut journal, owner) = fixture();
        let generation = journal.generations(&owner.epoch, 0).unwrap().remove(0).1;
        if retired {
            journal.retire_owner(&owner.epoch).unwrap();
        } else {
            prepared(&mut journal, &owner);
        }
        assert!(journal.bind_root(&generation.id, &process(13)).is_err());
        assert!(journal.generations(&owner.epoch, 0).unwrap()[0]
            .1
            .root
            .is_none());
    }
}

#[test]
fn journal_generic_advance_cannot_claim_without_target_identity() {
    let (_directory, mut journal, owner) = fixture();
    let (mut record, _) = prepared(&mut journal, &owner);
    for phase in [
        Phase::SourceFencing,
        Phase::SourceFenced,
        Phase::ReleasePending,
    ] {
        record = journal
            .mutate(
                &owner.host.sid,
                &request(&record, Mutation::Advance { phase }),
            )
            .unwrap();
    }
    let change = request(
        &record,
        Mutation::Advance {
            phase: Phase::TargetClaimed,
        },
    );
    assert!(journal.mutate(&owner.host.sid, &change).is_err());
    assert_eq!(journal.transfer(&record.id).unwrap(), record);
    assert_eq!(journal.active_owners().unwrap(), vec![owner]);
}

fn phase_mutation(record: &Transfer, phase: Phase) -> Mutation {
    if phase != Phase::TargetClaimed {
        return Mutation::Advance { phase };
    }
    let mut target = owner();
    target.epoch = record.target_epoch.clone();
    target.profile = record.profile.clone();
    target.host.pid = 21;
    Mutation::Claim { owner: target }
}

mod recovery;

#[test]
fn journal_shared_wire_fixture_preserves_native_identity_and_bootstrap_commands() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/shared/test/fixtures/owner-handoff.json"
    ))
    .unwrap();
    let record: Transfer = serde_json::from_value(fixture["response"]["record"].clone()).unwrap();
    record.validate().unwrap();
    assert_eq!(record.requester.created_at, "134115649234567891");
    assert_eq!(
        serde_json::to_value(&record).unwrap(),
        fixture["response"]["record"]
    );
    for value in fixture["bootstrap"].as_array().unwrap() {
        let command: super::service::Command = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(command).unwrap(), *value);
    }
    for field in ["counts", "idle", "adopt_pid", "path"] {
        let mut invalid = fixture["bootstrap"][1].clone();
        invalid[field] = serde_json::json!(true);
        assert!(serde_json::from_value::<super::service::Command>(invalid).is_err());
    }
    let mut invalid = fixture["bootstrap"][1].clone();
    invalid["operation"] = serde_json::json!("ready");
    assert!(serde_json::from_value::<super::service::Command>(invalid).is_err());
    let mut invalid = record.clone();
    invalid.requester.created_at = "18446744073709551616".into();
    assert!(invalid.validate().is_err());
    invalid = record;
    invalid.target_epoch.clone_from(&invalid.source_epoch);
    assert!(invalid.validate().is_err());
}

#[test]
fn legacy_journal_startup_requires_proof_and_does_not_enable_old_writes() {
    let (directory, journal, owner) = fixture();
    let path = directory.path().join("pi.sqlite");
    for version in [28, 29] {
        journal
            .conn
            .pragma_update(None, "user_version", version)
            .unwrap();
        let mut denied = ProofProbe {
            fail: true,
            ..ProofProbe::default()
        };
        assert!(super::startup::inspect(&path, Some(&owner.profile), &mut denied).is_err());
        assert_eq!(
            super::startup::inspect(&path, Some(&owner.profile), &mut ProofProbe::default())
                .unwrap(),
            vec![owner.epoch.clone()]
        );
        assert!(Journal::open(&path, false).is_err());
        assert_eq!(journal.active_owners().unwrap(), vec![owner.clone()]);
        let actual: i64 = journal
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(actual, version);
    }
}

#[test]
fn legacy_unfinished_handoff_still_refuses_normal_startup() {
    let (directory, mut journal, owner) = fixture();
    let (record, _) = prepared(&mut journal, &owner);
    let path = directory.path().join("pi.sqlite");
    journal
        .conn
        .pragma_update(None, "user_version", 28)
        .unwrap();
    let mut proof = ProofProbe::default();
    assert!(super::startup::inspect(&path, Some(&owner.profile), &mut proof).is_err());
    assert_eq!(proof.owners, 0);
    assert_eq!(journal.transfer(&record.id).unwrap(), record);
}

#[test]
fn upstream_schema_without_owner_tables_can_reach_additive_migration() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pi.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE fixture_data(value TEXT); INSERT INTO fixture_data VALUES('kept');",
    )
    .unwrap();
    for version in [27, 28, 29] {
        conn.pragma_update(None, "user_version", version).unwrap();
        assert!(
            super::startup::inspect(&path, None, &mut ProofProbe::default())
                .unwrap()
                .is_empty()
        );
        let actual: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(actual, version);
    }
    conn.pragma_update(None, "user_version", crate::db::SCHEMA_VERSION)
        .unwrap();
    assert!(super::startup::inspect(&path, None, &mut ProofProbe::default()).is_err());
}
