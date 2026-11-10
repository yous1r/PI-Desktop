//! Recovery after refused commits, uncertain holds and native fencing failures.
use super::*;

#[tokio::test]
async fn stop_failure_is_durable_and_the_same_command_resumes_without_a_second_seal() {
    let fixture = Fixture::new();
    fixture
        .probe
        .0
        .faults
        .stop_failures
        .store(1, Ordering::SeqCst);
    let mut controller = fixture.controller();
    let prepared = controller
        .execute(&fixture.prepare(&uuid()), &fixture.requester)
        .await
        .unwrap();
    let fence = fixture.fence(&uuid(), revision(&prepared));
    let error = controller
        .execute(&fence, &fixture.requester)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "HANDOFF_FENCE_UNCONFIRMED");
    let failed = fixture.probe.durable().unwrap();
    assert_eq!((failed.phase, failed.revision), (Phase::SourceFencing, 3));
    assert_eq!(
        failed.last_failure.as_deref(),
        Some("HANDOFF_FENCE_UNCONFIRMED")
    );
    assert!(fixture.probe.generation_open());
    assert_eq!(fixture.probe.phase(), Some(Phase::SourceFencing));
    let fenced = controller
        .execute(&fence, &fixture.requester)
        .await
        .unwrap();
    assert_eq!((fenced.phase, fenced.revision), (Phase::SourceFenced, 4));
    assert!(!fixture.probe.generation_open());
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Hold { .. })),
        1
    );
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Seal { .. })),
        1,
        "a resumed fence must not seal Desktop twice"
    );
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Stop { .. })),
        2,
        "the native stop is retried after the unconfirmed attempt"
    );
}

#[tokio::test]
async fn refused_seal_is_durable_and_never_stops_an_unconfirmed_desktop_gate() {
    let fixture = Fixture::new();
    fixture
        .probe
        .0
        .faults
        .unavailable_seals
        .store(1, Ordering::SeqCst);
    let mut controller = fixture.controller();
    let prepared = controller
        .execute(&fixture.prepare(&uuid()), &fixture.requester)
        .await
        .unwrap();
    let fence = fixture.fence(&uuid(), revision(&prepared));
    assert_eq!(
        controller
            .execute(&fence, &fixture.requester)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_FENCE_UNCONFIRMED"
    );
    let failed = fixture.probe.durable().unwrap();
    assert_eq!((failed.phase, failed.revision), (Phase::SourceFencing, 3));
    assert_eq!(
        failed.last_failure.as_deref(),
        Some("HANDOFF_FENCE_UNCONFIRMED")
    );
    assert!(fixture.probe.generation_open());
    // An unconfirmed Desktop seal must not terminate the original generation.
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Stop { .. })),
        0
    );
    let fenced = controller
        .execute(&fence, &fixture.requester)
        .await
        .unwrap();
    assert_eq!((fenced.phase, fenced.revision), (Phase::SourceFenced, 4));
    assert!(!fixture.probe.generation_open());
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Seal { .. })),
        2,
        "the retry re-seals Desktop after the refusal"
    );
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Stop { .. })),
        1
    );
}

#[tokio::test]
async fn uncommitted_confirm_keeps_the_generation_open_and_the_retry_sends_no_exchange() {
    let fixture = Fixture::new();
    let mut controller = fixture.controller();
    let prepared = controller
        .execute(&fixture.prepare(&uuid()), &fixture.requester)
        .await
        .unwrap();
    let fence = fixture.fence(&uuid(), revision(&prepared));
    fixture.probe.sql(
        "CREATE TRIGGER refuse_confirm BEFORE UPDATE OF phase ON owner_handoffs
         WHEN NEW.phase = 'source_fenced'
         BEGIN SELECT RAISE(ABORT, 'fixture unavailable'); END;",
    );
    assert!(controller
        .execute(&fence, &fixture.requester)
        .await
        .is_err());
    // The generation close and phase receipt share one transaction.
    assert_eq!(fixture.probe.phase(), Some(Phase::SourceFencing));
    assert!(fixture.probe.generation_open());
    let intermediate = fixture
        .probe
        .receipt(&fixture.requester.sid, &fence)
        .expect("begin-fencing receipt");
    assert_eq!(
        (intermediate.phase, intermediate.revision),
        (Phase::SourceFencing, 2)
    );
    let effects = fixture.probe.effects();
    fixture.probe.sql("DROP TRIGGER refuse_confirm;");
    let fenced = controller
        .execute(&fence, &fixture.requester)
        .await
        .unwrap();
    assert_eq!(
        (fenced.phase, fenced.revision),
        (Phase::SourceFenced, prepared.revision + 2)
    );
    assert!(!fixture.probe.generation_open());
    assert_eq!(
        fixture.probe.effects(),
        effects,
        "after the native stop only the retained owner may act; no Desktop exchange"
    );
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Stop { .. })),
        2
    );
}

#[tokio::test]
async fn uncommitted_cancel_keeps_admission_sealed_and_never_sends_desktop_cancel() {
    let fixture = Fixture::new();
    let mut controller = fixture.controller();
    let prepared = controller
        .execute(&fixture.prepare(&uuid()), &fixture.requester)
        .await
        .unwrap();
    let cancel = fixture.cancel(&uuid(), revision(&prepared));
    fixture.probe.sql(
        "CREATE TRIGGER refuse_cancel BEFORE UPDATE OF phase ON owner_handoffs
         WHEN NEW.phase = 'cancelled'
         BEGIN SELECT RAISE(ABORT, 'fixture unavailable'); END;",
    );
    assert!(controller
        .execute(&cancel, &fixture.requester)
        .await
        .is_err());
    // Refused cancellation cannot reopen Rust or reach Desktop completion.
    assert!(!fixture.probe.admitted());
    assert_eq!(fixture.probe.phase(), Some(Phase::Prepared));
    assert!(fixture
        .probe
        .receipt(&fixture.requester.sid, &cancel)
        .is_none());
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Cancel { .. })),
        0
    );
    fixture.probe.sql("DROP TRIGGER refuse_cancel;");
    let cancelled = controller
        .execute(&cancel, &fixture.requester)
        .await
        .unwrap();
    assert_eq!(cancelled.phase, Phase::Cancelled);
    assert!(fixture.probe.admitted());
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Cancel { .. })),
        1
    );
}

#[tokio::test]
async fn busy_idle_retains_the_hold_and_the_same_command_prepares_without_a_second_hold() {
    let fixture = Fixture::new();
    fixture
        .probe
        .0
        .faults
        .idle_failures
        .store(1, Ordering::SeqCst);
    let mut controller = fixture.controller();
    let prepare = fixture.prepare(&uuid());
    assert_eq!(
        controller
            .execute(&prepare, &fixture.requester)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_BUSY"
    );
    assert_eq!(fixture.probe.durable(), None);
    assert!(!fixture.probe.admitted());
    // Re-prove idle and reuse the retained Desktop hold before publishing.
    let prepared = controller
        .execute(&prepare, &fixture.requester)
        .await
        .unwrap();
    assert_eq!((prepared.phase, prepared.revision), (Phase::Prepared, 1));
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Hold { .. })),
        1,
        "the retained Desktop hold is reused, never re-taken"
    );
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Idle { .. })),
        2,
        "the retry re-proves idle before the journal step"
    );
    assert_eq!(fixture.probe.effects(), 1);
}

#[tokio::test]
async fn cancel_of_a_held_but_unprepared_transfer_commits_one_terminal_row_and_reopens() {
    let fixture = Fixture::new();
    fixture
        .probe
        .0
        .faults
        .idle_failures
        .store(1, Ordering::SeqCst);
    let mut controller = fixture.controller();
    let prepare = fixture.prepare(&uuid());
    assert_eq!(
        controller
            .execute(&prepare, &fixture.requester)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_BUSY"
    );
    assert_eq!(fixture.probe.durable(), None);
    assert!(!fixture.probe.admitted());
    // A cancel of an unpublished prepare must name its revision exactly.
    let stale = fixture.cancel(&uuid(), 2);
    assert_eq!(
        controller
            .execute(&stale, &fixture.requester)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_STALE_REVISION"
    );
    assert_eq!(fixture.probe.durable(), None);
    assert!(!fixture.probe.admitted());
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Cancel { .. })),
        0
    );
    // Only the terminal cancellation is visible from the atomic transaction.
    let cancel = fixture.cancel(&uuid(), 1);
    let cancelled = controller
        .execute(&cancel, &fixture.requester)
        .await
        .unwrap();
    assert_eq!((cancelled.phase, cancelled.revision), (Phase::Cancelled, 2));
    assert_eq!(fixture.probe.durable(), Some(cancelled.clone()));
    assert_eq!(
        fixture.probe.observed().last(),
        Some(&Observed::Cancel {
            durable: Some(Phase::Cancelled),
            admitted: true,
        })
    );
    assert!(fixture.probe.admitted());
    // The prepare never completed; only the cancel owns a receipt.
    assert!(fixture
        .probe
        .receipt(&fixture.requester.sid, &prepare)
        .is_none());
    assert_eq!(
        fixture.probe.receipt(&fixture.requester.sid, &cancel),
        Some(cancelled)
    );
    assert_eq!(fixture.probe.effects(), 2);
}

#[tokio::test]
async fn confirmed_busy_hold_leaves_no_rust_hold_and_the_retry_takes_it_once() {
    let fixture = Fixture::new();
    fixture.probe.0.faults.busy_holds.store(1, Ordering::SeqCst);
    let mut controller = fixture.controller();
    let prepare = fixture.prepare(&uuid());
    assert_eq!(
        controller
            .execute(&prepare, &fixture.requester)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_BUSY"
    );
    // A confirmed no-hold refusal must not close Rust admission.
    assert!(fixture.probe.admitted());
    assert_eq!(fixture.probe.durable(), None);
    let prepared = controller
        .execute(&prepare, &fixture.requester)
        .await
        .unwrap();
    assert_eq!(prepared.phase, Phase::Prepared);
    assert!(!fixture.probe.admitted());
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Hold { .. })),
        2
    );
}

#[tokio::test]
async fn ambiguous_hold_retains_admission_authority_for_explicit_reconciliation() {
    let fixture = Fixture::new();
    fixture
        .probe
        .0
        .faults
        .unavailable_holds
        .store(1, Ordering::SeqCst);
    let mut controller = fixture.controller();
    let prepare = fixture.prepare(&uuid());
    assert_eq!(
        controller
            .execute(&prepare, &fixture.requester)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_UNAVAILABLE"
    );
    // An ambiguous hold must never leave admission usable.
    assert!(!fixture.probe.admitted());
    assert_eq!(fixture.probe.durable(), None);
    let prepared = controller
        .execute(&prepare, &fixture.requester)
        .await
        .unwrap();
    assert_eq!(prepared.phase, Phase::Prepared);
    assert!(!fixture.probe.admitted());
    assert_eq!(fixture.probe.durable(), Some(prepared));
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Hold { .. })),
        2
    );
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Hold { admitted: false })),
        1,
        "the retry reconciles the original hold while Rust admission stays held"
    );
    let cancelled = controller
        .execute(&fixture.cancel(&uuid(), 1), &fixture.requester)
        .await
        .unwrap();
    assert_eq!(cancelled.phase, Phase::Cancelled);
    assert!(fixture.probe.admitted());
}

#[tokio::test]
async fn rejected_prepare_commit_keeps_the_hold_and_the_retry_repairs_the_journal() {
    let fixture = Fixture::new();
    let mut controller = fixture.controller();
    let prepare = fixture.prepare(&uuid());
    fixture.probe.sql(
        "CREATE TRIGGER refuse_prepare BEFORE INSERT ON owner_handoff_receipts
         WHEN EXISTS(SELECT 1 FROM owner_handoffs WHERE id = NEW.transfer_id)
         BEGIN SELECT RAISE(ABORT, 'fixture unavailable'); END;",
    );
    assert!(controller
        .execute(&prepare, &fixture.requester)
        .await
        .is_err());
    assert_eq!(fixture.probe.durable(), None);
    assert!(fixture
        .probe
        .receipt(&fixture.requester.sid, &prepare)
        .is_none());
    assert!(!fixture.probe.admitted());
    assert_eq!(fixture.probe.effects(), 1);
    fixture.probe.sql("DROP TRIGGER refuse_prepare;");
    let prepared = controller
        .execute(&prepare, &fixture.requester)
        .await
        .unwrap();
    assert_eq!((prepared.phase, prepared.revision), (Phase::Prepared, 1));
    assert_eq!(fixture.probe.effects(), 1);
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Idle { .. })),
        2,
        "the retry re-checks idle but reuses the retained hold"
    );
    assert_eq!(
        fixture.probe.receipt(&fixture.requester.sid, &prepare),
        Some(prepared)
    );
}
