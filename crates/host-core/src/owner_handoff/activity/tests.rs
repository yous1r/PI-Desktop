use super::*;

#[test]
fn reservations_precede_callbacks_and_finish_independently() {
    let activity = Activity::default();
    let request = activity.begin(Kind::Request);
    let background = activity.begin(Kind::Background);
    let write = activity.begin(Kind::Write);
    assert_eq!(
        activity.snapshot(),
        Snapshot {
            requests: 1,
            background_tasks: 1,
            writes: 1,
            uncertain: false,
        }
    );
    request.finish(true);
    assert_eq!(activity.snapshot().writes, 1);
    background.finish(true);
    write.finish(true);
    assert_eq!(activity.snapshot(), Snapshot::default());
}

#[test]
fn failed_or_abandoned_work_cannot_be_cleared_by_later_success() {
    for abandoned in [false, true] {
        let activity = Activity::default();
        let pending = activity.begin(Kind::Background);
        if abandoned {
            drop(pending);
        } else {
            pending.finish(false);
        }
        activity.begin(Kind::Background).finish(true);
        assert_eq!(
            activity.snapshot(),
            Snapshot {
                uncertain: true,
                ..Snapshot::default()
            }
        );
    }
}

#[tokio::test]
async fn cancelling_an_unpolled_task_retains_uncertainty() {
    let activity = Activity::default();
    let reserved = activity.begin(Kind::Background);
    let task = tokio::spawn(async move {
        std::future::pending::<()>().await;
        reserved.finish(true);
    });
    assert_eq!(activity.snapshot().background_tasks, 1);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(
        activity.snapshot(),
        Snapshot {
            uncertain: true,
            ..Snapshot::default()
        }
    );
}

#[tokio::test]
async fn scopes_preserve_the_original_owner_and_restore_the_parent() {
    let original = Activity::default();
    let replacement = Activity::default();
    original
        .scope(async {
            Activity::current().unwrap().mark_uncertain();
            replacement
                .scope(async {
                    assert!(!Activity::current().unwrap().snapshot().uncertain);
                })
                .await;
            assert!(Activity::current().unwrap().snapshot().uncertain);
            assert!(tokio::spawn(async { Activity::current().is_none() })
                .await
                .unwrap());
        })
        .await;
    assert!(Activity::current().is_none());
    assert!(original.snapshot().uncertain);
    assert!(!replacement.snapshot().uncertain);
}

#[test]
fn counter_overflow_refuses_without_wrapping_or_releasing_other_work() {
    let activity = Activity::default();
    activity.lock().snapshot.requests = MAX_COUNT;
    activity.begin(Kind::Request).finish(true);
    assert_eq!(activity.snapshot().requests, MAX_COUNT);
    assert!(activity.snapshot().uncertain);
}

#[test]
fn poisoned_state_stays_uncertain() {
    let activity = Activity::default();
    let owner = activity.clone();
    assert!(std::thread::spawn(move || {
        let _lock = owner.0.lock().unwrap();
        panic!("controlled owner failure");
    })
    .join()
    .is_err());
    activity.begin(Kind::Write).finish(true);
    assert!(activity.snapshot().uncertain);
    assert_eq!(activity.snapshot().writes, 0);
}

#[test]
fn a_hold_atomically_stops_ingress_but_preserves_admitted_continuations() {
    let activity = Activity::default();
    let request = activity.admit(Ingress::Request).unwrap();
    let held = activity.hold().unwrap();
    assert!(activity.clone().admit(Ingress::Request).is_err());
    assert!(activity.admit(Ingress::Background).is_err());
    assert!(activity.hold().is_err());
    let write = activity.begin(Kind::Write);
    let continuation = activity.begin(Kind::Background);
    request.finish(true);
    assert_eq!(activity.snapshot().writes, 1);
    assert_eq!(activity.snapshot().background_tasks, 1);
    continuation.finish(true);
    write.finish(true);
    assert_eq!(activity.snapshot(), Snapshot::default());
    held.reopen().unwrap();
    activity.admit(Ingress::Request).unwrap().finish(true);
}

#[test]
fn abandoning_a_hold_never_reopens_the_original_owner() {
    let original = Activity::default();
    drop(original.hold().unwrap());
    assert!(original.admit(Ingress::Request).is_err());
    assert!(original.hold().is_err());
    let replacement = Activity::default();
    replacement.admit(Ingress::Background).unwrap().finish(true);
    assert!(original.admit(Ingress::Background).is_err());
}

#[test]
fn sealing_or_invalidating_the_original_owner_is_irreversible() {
    for sealed in [true, false] {
        let activity = Activity::default();
        let held = activity.hold().unwrap();
        if sealed {
            held.seal().unwrap();
        } else {
            activity.close();
        }
        assert!(held.reopen().is_err());
        assert!(activity.admit(Ingress::Request).is_err());
        assert!(activity.admit(Ingress::Background).is_err());
        assert!(activity.hold().is_err());
    }
}

#[test]
fn racing_ingress_is_either_retained_before_the_hold_or_refused() {
    let activity = Activity::default();
    let owner = activity.clone();
    let start = Arc::new(std::sync::Barrier::new(2));
    let worker_start = start.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let task = std::thread::spawn(move || {
        worker_start.wait();
        send.send(owner.admit(Ingress::Background)).unwrap();
    });
    start.wait();
    let held = activity.hold().unwrap();
    let admitted = receive.recv().unwrap();
    task.join().unwrap();
    assert_eq!(
        activity.snapshot().background_tasks,
        u64::from(admitted.is_ok())
    );
    if let Ok(work) = admitted {
        work.finish(true);
    }
    assert_eq!(activity.snapshot(), Snapshot::default());
    assert!(activity.admit(Ingress::Background).is_err());
    held.reopen().unwrap();
}

#[test]
fn overflow_and_poison_refuse_fresh_admission_without_losing_continuations() {
    let activity = Activity::default();
    activity.lock().snapshot.requests = MAX_COUNT;
    assert!(activity.admit(Ingress::Request).is_err());
    assert_eq!(activity.snapshot().requests, MAX_COUNT);
    assert!(activity.snapshot().uncertain);
    let owner = activity.clone();
    assert!(std::thread::spawn(move || {
        let _lock = owner.0.lock().unwrap();
        panic!("controlled admission failure");
    })
    .join()
    .is_err());
    assert!(activity.admit(Ingress::Background).is_err());
    assert!(activity.hold().is_err());
    activity.begin(Kind::Write).finish(true);
    assert_eq!(activity.snapshot().writes, 0);
}

#[tokio::test]
async fn cancelled_serving_lifetime_closes_ingress_without_cancelling_admitted_work() {
    let activity = Activity::default();
    let lifetime = activity.lifetime();
    let work = activity.admit(Ingress::Request).unwrap();
    let held = activity.hold().unwrap();
    let serving = tokio::spawn(async move {
        let _lifetime = lifetime;
        std::future::pending::<()>().await;
    });
    serving.abort();
    assert!(serving.await.unwrap_err().is_cancelled());
    assert!(held.reopen().is_err());
    assert!(activity.admit(Ingress::Request).is_err());
    assert_eq!(activity.snapshot().requests, 1);
    work.finish(true);
    assert_eq!(activity.snapshot(), Snapshot::default());
}
