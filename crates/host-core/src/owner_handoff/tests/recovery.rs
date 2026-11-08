use super::*;
use crate::owner_handoff::service::{execute, Command, ContextIdentity};

fn released(journal: &mut Journal, source: &Owner) -> Transfer {
    let (mut record, _) = prepared(journal, source);
    for phase in [
        Phase::SourceFencing,
        Phase::SourceFenced,
        Phase::ReleasePending,
    ] {
        record = journal
            .mutate(
                &source.host.sid,
                &request(&record, Mutation::Advance { phase }),
            )
            .unwrap();
    }
    record
}
fn context(record: &Transfer) -> ContextIdentity {
    let mut target = owner();
    target.profile = record.profile.clone();
    target.host.pid = 21;
    ContextIdentity {
        owner: target,
        build: record.target_build.clone(),
    }
}
fn recovery(record: &Transfer, capability: &str) -> Command {
    Command::Recover {
        version: VERSION,
        request_id: id(),
        transfer_id: record.id.clone(),
        source_epoch: record.source_epoch.clone(),
        expected_revision: record.revision,
        target_epoch: id(),
        capability: capability.into(),
    }
}
fn claim(record: &Transfer, capability: &str) -> Command {
    Command::Claim {
        version: VERSION,
        request_id: id(),
        transfer_id: record.id.clone(),
        source_epoch: record.source_epoch.clone(),
        expected_revision: record.revision,
        target_epoch: record.target_epoch.clone(),
        capability: capability.into(),
    }
}
fn snapshot(journal: &Journal) -> String {
    let mut values = Vec::new();
    for query in [
        "SELECT quote(epoch)||quote(retired)||quote(record_json) FROM execution_owners ORDER BY sequence",
        "SELECT quote(record_json) FROM execution_generations ORDER BY sequence",
        "SELECT quote(record_json) FROM owner_handoffs ORDER BY sequence",
        "SELECT quote(result_json) FROM owner_handoff_receipts ORDER BY sequence",
    ] {
        let mut statement = journal.conn.prepare(query).unwrap();
        values.extend(statement.query_map([], |row| row.get::<_, String>(0)).unwrap().map(Result::unwrap));
    }
    values.join("\n")
}

#[test]
fn atomic_claim_rollback_retains_source_and_success_registers_target_with_receipt() {
    let (_directory, mut journal, source) = fixture();
    let record = released(&mut journal, &source);
    let change = request(&record, phase_mutation(&record, Phase::TargetClaimed));
    // Force a write failure after source retirement and before the final commit.
    journal.conn.execute_batch("CREATE TEMP TRIGGER reject_claim BEFORE INSERT ON execution_owners BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    let before = snapshot(&journal);
    assert!(journal.mutate(&source.host.sid, &change).is_err());
    assert_eq!(snapshot(&journal), before);
    journal
        .conn
        .execute_batch("DROP TRIGGER reject_claim;")
        .unwrap();
    let result = journal.mutate(&source.host.sid, &change).unwrap();
    assert_eq!(result.phase, Phase::TargetClaimed);
    assert_eq!(
        journal.active_owners().unwrap()[0].epoch,
        record.target_epoch
    );
    assert_eq!(journal.mutate(&source.host.sid, &change).unwrap(), result);
    assert!(journal.register_generation(&generation(&source)).is_err());
    let target = journal.owner(&record.target_epoch).unwrap().unwrap();
    assert!(journal.register_generation(&generation(&target)).is_err());
}

#[test]
fn two_claimants_have_one_atomic_owner_and_keep_both_request_identities_distinct() {
    let (directory, mut journal, source) = fixture();
    let record = released(&mut journal, &source);
    drop(journal);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = [31, 32]
        .into_iter()
        .map(|pid| {
            let path = directory.path().join("pi.sqlite");
            let principal = source.host.sid.clone();
            let mut target = context(&record).owner;
            target.epoch = record.target_epoch.clone();
            target.host.pid = pid;
            let request = request(&record, Mutation::Claim { owner: target });
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut journal = Journal::open(&path, false).unwrap();
                barrier.wait();
                journal.mutate(&principal, &request)
            })
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .filter(|handle| handle.thread().id() != std::thread::current().id())
            .map(|handle| handle.join().unwrap())
            .filter(Result::is_ok)
            .count(),
        1
    );
    let journal = Journal::open(&directory.path().join("pi.sqlite"), true).unwrap();
    assert_eq!(journal.active_owners().unwrap().len(), 1);
    assert_eq!(
        journal.transfer(&record.id).unwrap().phase,
        Phase::TargetClaimed
    );
}

#[test]
fn restricted_recovery_claim_restart_and_rotation_never_recover_turns_or_replay() {
    let (directory, mut journal, source) = fixture();
    let (record, _) = prepared(&mut journal, &source);
    journal.conn.execute_batch("INSERT INTO sessions(id,title,created_at,updated_at) VALUES('kept','Keep',1,1); INSERT INTO turns(id,session_id,status,started_at) VALUES('running','kept','running',1);").unwrap();
    let path = directory.path().join("pi.sqlite");
    let context = context(&record);
    let capability = id();
    let recovery = recovery(&record, &capability);
    let mut proof = ProofProbe::default();
    let recovered = execute(&path, &context, &recovery, &mut proof).unwrap();
    assert_eq!((proof.owners, proof.generations), (1, 1));
    assert!(journal.active_owners().unwrap().is_empty());
    assert_eq!(
        execute(
            &path,
            &context,
            &recovery,
            &mut ProofProbe {
                fail: true,
                ..Default::default()
            }
        )
        .unwrap(),
        recovered
    );
    let claiming = claim(&recovered, &capability);
    let claimed = execute(&path, &context, &claiming, &mut ProofProbe::default()).unwrap();
    assert_eq!(claimed.phase, Phase::TargetClaimed);
    assert_eq!(journal.active_owners().unwrap()[0].host, context.owner.host);
    assert_eq!(
        execute(
            &path,
            &context,
            &claiming,
            &mut ProofProbe {
                fail: true,
                ..Default::default()
            }
        )
        .unwrap(),
        claimed
    );
    let mut other_process = context;
    other_process.owner.host.pid = 22;
    assert!(
        execute(&path, &other_process, &claiming, &mut ProofProbe::default())
            .unwrap_err()
            .to_string()
            .contains("REQUEST_CONFLICT")
    );
    let replacement = recovery_command(&claimed);
    let mut proof = ProofProbe::default();
    let rotated = execute(&path, &other_process, &replacement, &mut proof).unwrap();
    assert_eq!((proof.owners, proof.generations), (2, 1));
    assert!(journal.active_owners().unwrap().is_empty());
    assert!(journal.owner(&claimed.target_epoch).unwrap().is_some());
    assert_eq!(rotated.recovery_attempt, 2);
    assert!(
        execute(&path, &other_process, &claiming, &mut ProofProbe::default())
            .unwrap_err()
            .to_string()
            .contains("CAPABILITY_MISMATCH")
    );
    assert_eq!(
        journal
            .conn
            .query_row("SELECT status FROM turns WHERE id='running'", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "running"
    );
    assert!(crate::owner_handoff::startup::inspect(
        &path,
        Some(&source.profile),
        &mut ProofProbe::default()
    )
    .is_err());
}
fn recovery_command(record: &Transfer) -> Command {
    recovery(record, &id())
}

#[test]
fn restricted_failed_native_proof_build_capability_and_identity_checks_leave_journal_unchanged() {
    let (directory, mut journal, source) = fixture();
    let record = released(&mut journal, &source);
    let path = directory.path().join("pi.sqlite");
    let before = snapshot(&journal);
    let mut context = context(&record);
    let command = recovery(&record, &id());
    assert!(execute(
        &path,
        &context,
        &command,
        &mut ProofProbe {
            fail: true,
            ..Default::default()
        }
    )
    .is_err());
    context.build.sha256 = digest(b"other executable");
    assert!(execute(&path, &context, &command, &mut ProofProbe::default()).is_err());
    context.build = record.target_build.clone();
    context.owner.profile = digest(b"copied directory");
    assert!(execute(&path, &context, &command, &mut ProofProbe::default()).is_err());
    context.owner.profile = record.profile.clone();
    assert!(execute(
        &path,
        &context,
        &claim(&record, &id()),
        &mut ProofProbe::default()
    )
    .is_err());
    assert_eq!(snapshot(&journal), before);
    let raw = serde_json::json!({"operation":"recover", "version":1, "request_id":id(), "transfer_id":record.id, "source_epoch":source.epoch, "expected_revision":record.revision, "target_epoch":id(), "capability":id(), "adopt_pid":42});
    assert!(serde_json::from_value::<Command>(raw).is_err());
}

#[test]
fn restricted_recovery_requires_prior_target_proof_before_any_retirement() {
    let (directory, mut journal, source) = fixture();
    let record = released(&mut journal, &source);
    let claimed = journal
        .mutate(
            &source.host.sid,
            &request(&record, phase_mutation(&record, Phase::TargetClaimed)),
        )
        .unwrap();
    struct TargetAlive;
    impl crate::owner_handoff::startup::NativeProof for TargetAlive {
        fn owner_ended(&mut self, owner: &Owner) -> anyhow::Result<()> {
            if owner.host.pid == 21 {
                anyhow::bail!("HANDOFF_PREVIOUS_PROCESS_ALIVE");
            }
            Ok(())
        }
        fn generation_ended(&mut self, _: &Generation) -> anyhow::Result<()> {
            Ok(())
        }
    }
    let before = snapshot(&journal);
    assert!(execute(
        &directory.path().join("pi.sqlite"),
        &context(&claimed),
        &recovery_command(&claimed),
        &mut TargetAlive
    )
    .is_err());
    assert_eq!(snapshot(&journal), before);
}

#[cfg(windows)]
#[test]
fn native_recovery_confirms_exited_process_with_original_handle_retained() {
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};
    let mut child = Command::new("cmd.exe")
        .args(["/d", "/q"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let identity =
        crate::owner_control::identity::Identity::from_process(child.as_raw_handle()).unwrap();
    let recorded = crate::owner_handoff::native::record(child.id(), &identity);
    child.kill().unwrap();
    child.wait().unwrap();
    crate::owner_handoff::native::process_ended(&recorded).unwrap();
}
