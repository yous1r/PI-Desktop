use super::super::model;
use super::*;

#[test]
fn source_read_follows_original_journal_phases_without_writes() {
    let (_directory, mut journal, owner) = fixture();
    assert!(journal.inspect_source(&owner, None).unwrap().is_none());
    let (record, _) = prepared(&mut journal, &owner);
    let before = journal.conn.total_changes();
    journal.conn.execute_batch("PRAGMA query_only=ON").unwrap();
    assert_eq!(
        journal.inspect_source(&owner, Some(&record.id)).unwrap(),
        Some(record.clone())
    );
    assert_eq!(journal.conn.total_changes(), before);
    assert!(journal.inspect_source(&owner, Some(&id())).is_err());
    journal.conn.execute_batch("PRAGMA query_only=OFF").unwrap();
    let cancelled = journal
        .mutate(
            &owner.host.sid,
            &request(
                &record,
                Mutation::Advance {
                    phase: Phase::Cancelled,
                },
            ),
        )
        .unwrap();
    assert_eq!(
        journal.inspect_source(&owner, Some(&record.id)).unwrap(),
        Some(cancelled)
    );
    let timeout: u32 = journal
        .conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .unwrap();
    assert_eq!(timeout, 5000);
}

#[test]
fn source_read_refuses_replaced_retired_missing_and_corrupt_owners() {
    let (_directory, journal, owner) = fixture();
    for change in ["host", "coordinator", "profile", "epoch"] {
        let mut other = owner.clone();
        match change {
            "host" => other.host.created_at = "134115649234567892".into(),
            "coordinator" => other.coordinator.pid += 1,
            "profile" => other.profile = digest(b"other"),
            _ => other.epoch = id(),
        }
        assert!(journal.inspect_source(&other, None).is_err(), "{change}");
    }
    journal
        .conn
        .execute(
            "UPDATE execution_owners SET retired=1 WHERE epoch=?1",
            [&owner.epoch],
        )
        .unwrap();
    assert!(journal.inspect_source(&owner, None).is_err());
    journal
        .conn
        .execute(
            "UPDATE execution_owners SET retired=0,record_json='{}' WHERE epoch=?1",
            [&owner.epoch],
        )
        .unwrap();
    assert!(journal.inspect_source(&owner, None).is_err());
    assert!(journal.conn.is_autocommit());
}

#[test]
fn source_read_refuses_wrong_transfer_source_profile_principal_and_columns() {
    let (_directory, mut journal, owner) = fixture();
    let (record, _) = prepared(&mut journal, &owner);
    let mut other = owner.clone();
    other.epoch = id();
    other.profile = digest(b"other owner profile");
    journal.register_owner(&other).unwrap();
    for change in ["source", "profile", "principal", "revision"] {
        let mut bad = record.clone();
        match change {
            "source" => bad.source_epoch = other.epoch.clone(),
            "profile" => bad.profile = digest(b"other profile"),
            "principal" => bad.requester.sid = "S-1-5-21-other".into(),
            _ => bad.revision += 1,
        }
        journal
            .conn
            .execute(
                "UPDATE owner_handoffs SET source_epoch=?1,profile=?2,record_json=?3 WHERE id=?4",
                rusqlite::params![
                    bad.source_epoch,
                    bad.profile,
                    model::encode(&bad).unwrap(),
                    record.id
                ],
            )
            .unwrap();
        assert!(
            journal.inspect_source(&owner, Some(&record.id)).is_err(),
            "{change}"
        );
    }
    assert!(journal.conn.is_autocommit());
}
