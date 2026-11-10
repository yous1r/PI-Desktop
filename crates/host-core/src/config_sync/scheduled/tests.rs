use super::super::{
    load_config, save_config,
    tests::{configure_test_device, run_in_isolated_process},
};
use super::*;
use crate::owner_handoff::activity::{Ingress, Snapshot};
use std::time::Duration;

#[tokio::test]
async fn a_closed_tick_has_no_local_effect_but_an_admitted_tick_finishes() -> anyhow::Result<()> {
    if run_in_isolated_process("config_sync::engine::scheduled::tests::a_closed_tick_has_no_local_effect_but_an_admitted_tick_finishes")? {
        return Ok(());
    }
    let fixture = crate::config_sync::transport::tests::fixture(false).await;
    let root = tempfile::tempdir()?;
    let state = configure_test_device(root.path(), &fixture.endpoint).await?;
    let scheduled = ScheduledSync::capture(state.clone()).await;
    let activity = scheduled.activity.clone();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let before = {
        let st = state.lock().await;
        let mut config = load_config(&st)?.unwrap();
        config.automatic_sync = true;
        config.last_local_digest = Some("changed".into());
        config.local_change_seen_at = None;
        save_config(&st, &config)?;
        serde_json::to_value(&config)?
    };
    let held = activity.hold().unwrap();
    // Even AppState contention cannot cause a closed tick to enter the engine.
    let st = state.lock().await;
    tokio::time::timeout(Duration::from_secs(2), scheduled.tick(tx.clone())).await?;
    assert_eq!(serde_json::to_value(load_config(&st)?.unwrap())?, before);
    assert!(rx.try_recv().is_err());
    assert_eq!(activity.snapshot(), Snapshot::default());
    drop(st);
    held.reopen().unwrap();

    let st = state.lock().await;
    let tick = tokio::spawn(async move { scheduled.tick(tx).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while activity.snapshot().background_tasks == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    let held = activity.hold().unwrap();
    assert!(activity.admit(Ingress::Background).is_err());
    drop(st);
    tick.await?;
    let st = state.lock().await;
    let after = load_config(&st)?.unwrap();
    assert!(after.local_change_seen_at.is_some());
    assert_eq!(
        after.last_revision_id,
        before["lastRevisionId"].as_str().map(str::to_owned)
    );
    assert_eq!(activity.snapshot(), Snapshot::default());
    held.reopen().unwrap();
    Ok(())
}

#[tokio::test]
async fn cancelling_an_admitted_tick_keeps_uncertainty_and_closure() {
    let root = tempfile::tempdir().unwrap();
    let state = Arc::new(Mutex::new(AppState::open(root.path()).unwrap()));
    let scheduled = ScheduledSync::capture(state.clone()).await;
    let activity = scheduled.activity.clone();
    let st = state.lock().await;
    let tick = tokio::spawn(async move { scheduled.tick(mpsc::unbounded_channel().0).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while activity.snapshot().background_tasks == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(activity.hold().unwrap());
    tick.abort();
    assert!(tick.await.unwrap_err().is_cancelled());
    drop(st);
    assert_eq!(
        activity.snapshot(),
        Snapshot {
            uncertain: true,
            ..Snapshot::default()
        }
    );
    assert!(activity.admit(Ingress::Background).is_err());
}
