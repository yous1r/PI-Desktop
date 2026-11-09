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
    activity.lock().requests = MAX_COUNT;
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
