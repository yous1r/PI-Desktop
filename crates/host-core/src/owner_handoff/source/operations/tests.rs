//! Owned-operation behaviour: one in-flight execution survives a lost RPC
//! waiter, the slot stays bounded and a panic is reported instead of wedging
//! the service. Work futures are gated with `Notify`, never with timers, so
//! every interleaving below is deterministic.
use super::super::protocol::{Body, Code, Failure};
use super::Operations;
use crate::owner_handoff::{model, model::VERSION};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Notify;

/// An operation result that is cheap to build and indistinguishable from a
/// refusal, so a test never has to fabricate a valid durable record.
fn unavailable() -> Body {
    Body::Failure {
        version: VERSION,
        error: Failure {
            code: Code::Unavailable,
        },
    }
}

fn encoded(body: &Body) -> String {
    model::encode(body).unwrap()
}

#[tokio::test]
async fn a_dropped_waiter_never_cancels_owned_work_and_close_joins_it() {
    let operations = Arc::new(Operations::default());
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let runs = Arc::new(AtomicUsize::new(0));
    let finished = Arc::new(AtomicUsize::new(0));
    let work = {
        let started = started.clone();
        let release = release.clone();
        let runs = runs.clone();
        let finished = finished.clone();
        async move {
            runs.fetch_add(1, Ordering::SeqCst);
            started.notify_one();
            release.notified().await;
            finished.fetch_add(1, Ordering::SeqCst);
            unavailable()
        }
    };
    let mut waiter =
        Box::pin(operations.run("S-1-5-21-1234", "request", "fingerprint".into(), work));
    tokio::select! {
        biased;
        _ = started.notified() => {}
        result = &mut waiter => panic!("owned work completed before it was released: {result:?}"),
    }
    // The external completion waiter disappears while the owned work is gated.
    drop(waiter);
    let closer = tokio::spawn({
        let operations = operations.clone();
        async move { operations.close().await }
    });
    release.notify_one();
    closer.await.unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(
        finished.load(Ordering::SeqCst),
        1,
        "close must join the owned work instead of dropping it"
    );
}

#[tokio::test]
async fn an_identical_pending_retry_shares_one_execution_and_one_result() {
    let operations = Arc::new(Operations::default());
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let runs = Arc::new(AtomicUsize::new(0));
    let second_runs = Arc::new(AtomicUsize::new(0));
    let work = {
        let started = started.clone();
        let release = release.clone();
        let runs = runs.clone();
        async move {
            runs.fetch_add(1, Ordering::SeqCst);
            started.notify_one();
            release.notified().await;
            unavailable()
        }
    };
    let mut first =
        Box::pin(operations.run("S-1-5-21-1234", "request", "fingerprint".into(), work));
    tokio::select! {
        biased;
        _ = started.notified() => {}
        result = &mut first => panic!("owned work completed before it was released: {result:?}"),
    }
    let retried = {
        let second_runs = second_runs.clone();
        async move {
            second_runs.fetch_add(1, Ordering::SeqCst);
            unavailable()
        }
    };
    let mut second =
        Box::pin(operations.run("S-1-5-21-1234", "request", "fingerprint".into(), retried));
    // Exactly one poll joins the pending flight and must stay pending.
    tokio::select! {
        biased;
        result = &mut second => panic!("shared retry returned early: {result:?}"),
        _ = std::future::ready(()) => {}
    }
    release.notify_one();
    let first = first.await.unwrap();
    let second = second.await.unwrap();
    assert_eq!(encoded(&first), encoded(&second));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(
        second_runs.load(Ordering::SeqCst),
        0,
        "a shared retry must not start a second execution"
    );
}

#[tokio::test]
async fn conflicting_id_principal_and_fingerprint_are_refused_while_pending() {
    let operations = Arc::new(Operations::default());
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let runs = Arc::new(AtomicUsize::new(0));
    let refused_runs = Arc::new(AtomicUsize::new(0));
    let refused = {
        let refused_runs = refused_runs.clone();
        move || {
            let refused_runs = refused_runs.clone();
            async move {
                refused_runs.fetch_add(1, Ordering::SeqCst);
                unavailable()
            }
        }
    };
    let work = {
        let started = started.clone();
        let release = release.clone();
        let runs = runs.clone();
        async move {
            runs.fetch_add(1, Ordering::SeqCst);
            started.notify_one();
            release.notified().await;
            unavailable()
        }
    };
    let mut first = Box::pin(operations.run("S-1-5-21-1234", "request", "hash-a".into(), work));
    tokio::select! {
        biased;
        _ = started.notified() => {}
        result = &mut first => panic!("owned work completed before it was released: {result:?}"),
    }
    assert_eq!(
        operations
            .run("S-1-5-21-1234", "request", "hash-b".into(), refused())
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_REQUEST_CONFLICT"
    );
    assert_eq!(
        operations
            .run("S-1-5-21-9999", "request", "hash-a".into(), refused())
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_BUSY"
    );
    assert_eq!(
        operations
            .run("S-1-5-21-1234", "other", "hash-a".into(), refused())
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_BUSY"
    );
    assert_eq!(
        refused_runs.load(Ordering::SeqCst),
        0,
        "a refused request never runs its work"
    );
    release.notify_one();
    assert!(matches!(first.await.unwrap(), Body::Failure { .. }));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn sealed_operations_refuse_new_work_without_running_it() {
    let operations = Operations::default();
    let runs = Arc::new(AtomicUsize::new(0));
    let work = {
        let runs = runs.clone();
        move || {
            let runs = runs.clone();
            async move {
                runs.fetch_add(1, Ordering::SeqCst);
                unavailable()
            }
        }
    };
    operations.seal();
    assert_eq!(
        operations
            .run("S-1-5-21-1234", "request", "fingerprint".into(), work())
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_UNAVAILABLE"
    );
    operations.close().await;
    assert_eq!(
        operations
            .run("S-1-5-21-1234", "request", "fingerprint".into(), work())
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_UNAVAILABLE"
    );
    assert_eq!(runs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_panicking_operation_is_reported_and_the_slot_stays_reusable() {
    let operations = Operations::default();
    let runs = Arc::new(AtomicUsize::new(0));
    let boom = {
        let runs = runs.clone();
        async move {
            runs.fetch_add(1, Ordering::SeqCst);
            panic!("fixture owned operation panic")
        }
    };
    let first = operations
        .run("S-1-5-21-1234", "boom", "fingerprint".into(), boom)
        .await;
    // A panicking owned future is a lost result, never a fabricated success.
    assert_eq!(first.unwrap_err().to_string(), "HANDOFF_UNAVAILABLE");
    assert_eq!(
        runs.load(Ordering::SeqCst),
        1,
        "the owned work ran and panicked instead of being skipped"
    );
    // A finished flight is replaceable; let the runtime record the panicked
    // task as complete, then reuse the same slot for fresh work.
    tokio::task::yield_now().await;
    let reused = Arc::new(AtomicUsize::new(0));
    let next = {
        let reused = reused.clone();
        async move {
            reused.fetch_add(1, Ordering::SeqCst);
            unavailable()
        }
    };
    assert!(matches!(
        operations
            .run("S-1-5-21-1234", "next", "fingerprint".into(), next)
            .await
            .unwrap(),
        Body::Failure { .. }
    ));
    assert_eq!(reused.load(Ordering::SeqCst), 1);
    // Closing joins the panicked task instead of hanging on it, and the slot
    // then refuses every later operation without running it.
    operations.close().await;
    let never = {
        let reused = reused.clone();
        async move {
            reused.fetch_add(1, Ordering::SeqCst);
            unavailable()
        }
    };
    assert_eq!(
        operations
            .run("S-1-5-21-1234", "next", "fingerprint".into(), never)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_UNAVAILABLE"
    );
    assert_eq!(reused.load(Ordering::SeqCst), 1);
}
