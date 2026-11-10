use super::*;

fn count(journal: &Journal, table: &str) -> i64 {
    journal
        .conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn explicit_source_path_preserves_requester_and_replays_without_executing_again() {
    let (directory, mut journal, owner) = fixture();
    let (mut record, prepare) = prepared(&mut journal, &owner);
    let requester = record.requester.clone();
    for (mutation, phase) in [
        (Mutation::BeginFencing, Phase::SourceFencing),
        (Mutation::ConfirmFenced, Phase::SourceFenced),
        (Mutation::Release, Phase::ReleasePending),
    ] {
        let request = request(&record, mutation);
        let revision = record.revision;
        record = journal.mutate(&owner.host.sid, &request).unwrap();
        assert_eq!((record.phase, record.revision), (phase, revision + 1));
        assert_eq!(record.requester, requester);
        drop(journal);
        journal = Journal::open(&directory.path().join("pi.sqlite"), false).unwrap();
        assert_eq!(journal.mutate(&owner.host.sid, &request).unwrap(), record);
        assert_eq!(count(&journal, "owner_handoff_receipts"), record.revision);
    }
    // A historic receipt is an observation, never a rewind or a new transition.
    let original = journal.receipt(&owner.host.sid, &prepare).unwrap().unwrap();
    assert_eq!((original.phase, original.revision), (Phase::Prepared, 1));
    assert_eq!(journal.transfer(&record.id).unwrap(), record);
}

#[test]
fn source_operations_reject_skips_and_cancel_only_before_fencing() {
    let (_directory, mut journal, owner) = fixture();
    let (record, _) = prepared(&mut journal, &owner);
    for mutation in [Mutation::ConfirmFenced, Mutation::Release] {
        assert!(journal
            .mutate(&owner.host.sid, &request(&record, mutation))
            .is_err());
        assert_eq!(journal.transfer(&record.id).unwrap(), record);
        assert_eq!(count(&journal, "owner_handoff_receipts"), 1);
    }
    let cancel = request(&record, Mutation::Cancel);
    let cancelled = journal.mutate(&owner.host.sid, &cancel).unwrap();
    assert_eq!((cancelled.phase, cancelled.revision), (Phase::Cancelled, 2));
    assert_eq!(journal.mutate(&owner.host.sid, &cancel).unwrap(), cancelled);
    assert!(journal
        .mutate(
            &owner.host.sid,
            &request(&cancelled, Mutation::BeginFencing)
        )
        .is_err());
    let (record, _) = prepared(&mut journal, &owner);
    let fencing = journal
        .mutate(&owner.host.sid, &request(&record, Mutation::BeginFencing))
        .unwrap();
    assert!(journal
        .mutate(&owner.host.sid, &request(&fencing, Mutation::Cancel))
        .is_err());
    assert!(journal
        .mutate(&owner.host.sid, &request(&fencing, Mutation::Release))
        .is_err());
    assert_eq!(journal.transfer(&fencing.id).unwrap(), fencing);
}

#[test]
fn source_step_requires_original_unretired_owner_and_exact_revision_principal() {
    let (_directory, mut journal, owner) = fixture();
    let (record, _) = prepared(&mut journal, &owner);
    let mut step = request(&record, Mutation::BeginFencing);
    assert!(journal.mutate("S-1-5-21-999", &step).is_err());
    step.expected_revision += 1;
    assert!(journal.mutate(&owner.host.sid, &step).is_err());
    step.expected_revision = record.revision;
    journal.retire_owner(&owner.epoch).unwrap();
    assert!(journal
        .mutate(&owner.host.sid, &step)
        .unwrap_err()
        .to_string()
        .contains("OWNER_CHANGED"));
    assert_eq!(journal.transfer(&record.id).unwrap(), record);
    assert_eq!(count(&journal, "owner_handoff_receipts"), 1);
}

#[test]
fn failed_receipt_commit_rolls_back_the_phase_and_same_request_can_retry() {
    let (_directory, mut journal, owner) = fixture();
    let (record, _) = prepared(&mut journal, &owner);
    let step = request(&record, Mutation::Cancel);
    journal.conn.execute_batch("CREATE TRIGGER refuse_receipt BEFORE INSERT ON owner_handoff_receipts BEGIN SELECT RAISE(ABORT, 'fixture unavailable'); END;").unwrap();
    assert!(journal.mutate(&owner.host.sid, &step).is_err());
    assert_eq!(journal.transfer(&record.id).unwrap(), record);
    assert!(journal.receipt(&owner.host.sid, &step).unwrap().is_none());
    journal
        .conn
        .execute_batch("DROP TRIGGER refuse_receipt;")
        .unwrap();
    let cancelled = journal.mutate(&owner.host.sid, &step).unwrap();
    assert_eq!(cancelled.phase, Phase::Cancelled);
    assert_eq!(cancelled.revision, 2);
    assert_eq!(count(&journal, "owner_handoff_receipts"), 2);
}
