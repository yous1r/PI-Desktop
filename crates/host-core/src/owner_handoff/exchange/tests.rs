use super::*;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../packages/shared/test/fixtures/owner-handoff-exchange.json"
    ))
    .unwrap()
}
fn notification() -> Notification {
    serde_json::from_value(fixture()["notification"].clone()).unwrap()
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(30)
}
fn complete_fixture(channel: &Exchange, value: Value) -> Result<Value> {
    let request = notification();
    channel.complete(value, &request.request.source_epoch, &request.profile_id)
}
#[test]
fn shared_contract_round_trips_and_requires_exact_outcome() {
    let fixture = fixture();
    let request = notification();
    request.validate().unwrap();
    for key in ["success", "refusal"] {
        let value: Completion = serde_json::from_value(fixture[key].clone()).unwrap();
        value.validate(&request).unwrap();
        assert_eq!(serde_json::to_value(value).unwrap(), fixture[key]);
    }
    for outcome in [
        json!({}),
        json!({"error":{"code":"secret/path"}}),
        json!({"error":{"code":"HANDOFF_BUSY","message":"secret"}}),
        json!({"report":fixture["success"]["outcome"]["report"],"error":{"code":"HANDOFF_BUSY"}}),
    ] {
        let mut value = fixture["success"].clone();
        value["outcome"] = outcome;
        assert!(serde_json::from_value::<Completion>(value).is_err());
    }
}
#[test]
fn request_rejects_null_hold_unknown_fields_and_unsafe_revision() {
    for (key, value) in [
        ("holdId", Value::Null),
        ("extra", json!(true)),
        ("revision", json!(-1)),
        ("revision", json!(9_007_199_254_740_992_u64)),
        ("operation", json!("seal")),
        ("version", json!(2)),
    ] {
        let mut raw = fixture()["notification"].clone();
        raw["request"][key] = value;
        assert!(serde_json::from_value::<Notification>(raw)
            .and_then(|value| value.validate().map_err(serde::de::Error::custom))
            .is_err());
    }
}
#[test]
fn completion_requires_all_safe_counts_and_exact_original_fields() {
    for (key, value) in [("profileId", json!("f".repeat(64))), ("version", json!(2))] {
        let mut raw = fixture()["success"].clone();
        raw[key] = value;
        assert!(serde_json::from_value::<Completion>(raw)
            .unwrap()
            .validate(&notification())
            .is_err());
    }
    for (key, value) in [
        ("revision", json!(2)),
        ("exchangeId", json!(uuid::Uuid::new_v4().to_string())),
        ("sourceEpoch", json!(uuid::Uuid::new_v4().to_string())),
        ("transferId", json!(uuid::Uuid::new_v4().to_string())),
    ] {
        let mut raw = fixture()["success"].clone();
        raw["request"][key] = value;
        assert!(serde_json::from_value::<Completion>(raw)
            .unwrap()
            .validate(&notification())
            .is_err());
    }
    for counts in [json!({}), json!({"writes":0}), json!({"writes":-1})] {
        let mut raw = fixture()["success"].clone();
        raw["outcome"]["report"]["counts"] = counts;
        assert!(serde_json::from_value::<Completion>(raw)
            .and_then(|value| value
                .validate(&notification())
                .map_err(serde::de::Error::custom))
            .is_err());
    }
    for value in [1, 9_007_199_254_740_992_u64] {
        let mut raw = fixture()["success"].clone();
        raw["outcome"]["report"]["counts"]["writes"] = json!(value);
        assert!(serde_json::from_value::<Completion>(raw)
            .unwrap()
            .validate(&notification())
            .is_err());
    }
}
#[tokio::test]
async fn real_exchange_completes_once_and_reserves_through_consumption() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let channel = Exchange::new(tx);
    let mut operation = Box::pin(channel.wait(notification(), deadline()));
    tokio::select! { biased; _ = &mut operation => panic!("completed without a report"), raw = rx.recv() => {
        let wire: Value = serde_json::from_str(&raw.unwrap()).unwrap(); assert_eq!(wire["params"], fixture()["notification"]);
    } }
    assert!(channel.wait(notification(), deadline()).await.is_err());
    let ack = complete_fixture(&channel, fixture()["success"].clone()).unwrap();
    assert_eq!(ack, fixture()["ack"]);
    assert!(complete_fixture(&channel, fixture()["success"].clone()).is_err());
    assert!(channel.wait(notification(), deadline()).await.is_err());
    assert!(matches!(operation.await.unwrap(), Outcome::Success { .. }));
    assert!(complete_fixture(&channel, fixture()["success"].clone()).is_err());
    let mut next = Box::pin(channel.wait(notification(), deadline()));
    tokio::select! { biased; _ = &mut next => panic!("completed without refusal"), _ = rx.recv() => {} }
    complete_fixture(&channel, fixture()["refusal"].clone()).unwrap();
    assert!(matches!(next.await.unwrap(), Outcome::Refusal { .. }));
}
#[tokio::test]
async fn invalid_completion_cannot_consume_original_waiter() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let channel = Exchange::new(tx);
    let mut operation = Box::pin(channel.wait(notification(), deadline()));
    tokio::select! { biased; _ = &mut operation => panic!("early completion"), _ = rx.recv() => {} }
    let mut wrong = fixture()["success"].clone();
    wrong["request"]["revision"] = json!(2);
    assert!(complete_fixture(&channel, wrong).is_err());
    assert!(complete_fixture(&channel, json!({"payload":"x".repeat(17000)})).is_err());
    complete_fixture(&channel, fixture()["success"].clone()).unwrap();
    operation.await.unwrap();
}
#[tokio::test]
async fn cancelled_waiter_poisoning_survives_late_reply() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let channel = Exchange::new(tx);
    let mut operation = Box::pin(channel.wait(notification(), deadline()));
    tokio::select! { biased; _ = &mut operation => panic!("early completion"), _ = rx.recv() => {} }
    drop(operation);
    assert!(complete_fixture(&channel, fixture()["success"].clone()).is_err());
    assert!(channel.wait(notification(), deadline()).await.is_err());
}
#[tokio::test]
async fn timeout_and_closed_output_never_reopen_exchange() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let channel = Exchange::new(tx);
    assert_eq!(
        channel
            .wait(notification(), Instant::now())
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_EXCHANGE_TIMEOUT"
    );
    assert!(complete_fixture(&channel, fixture()["success"].clone()).is_err());
    assert!(channel.wait(notification(), deadline()).await.is_err());
    let (tx, rx) = mpsc::unbounded_channel();
    drop(rx);
    let channel = Exchange::new(tx);
    assert!(channel.wait(notification(), deadline()).await.is_err());
    assert!(channel.state.lock().unwrap().closed);
}
#[tokio::test]
async fn closed_channel_or_changed_authority_rejects_original_waiter() {
    for changed in [false, true] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let channel = Exchange::new(tx);
        let mut operation = Box::pin(channel.wait(notification(), deadline()));
        tokio::select! { biased; _ = &mut operation => panic!("early completion"), _ = rx.recv() => {} }
        if changed {
            assert!(channel
                .complete(
                    fixture()["success"].clone(),
                    "changed",
                    &notification().profile_id
                )
                .is_err());
        } else {
            channel.close();
        }
        assert!(operation.await.is_err());
        assert!(channel.wait(notification(), deadline()).await.is_err());
    }
}
#[tokio::test]
async fn late_completion_rejects_even_before_waiter_gets_scheduled() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let channel = Exchange::new(tx);
    let mut operation = Box::pin(channel.wait(notification(), deadline()));
    tokio::select! { biased; _ = &mut operation => panic!("early completion"), _ = rx.recv() => {} }
    channel
        .state
        .lock()
        .unwrap()
        .pending
        .as_mut()
        .unwrap()
        .deadline = Instant::now();
    assert!(complete_fixture(&channel, fixture()["success"].clone()).is_err());
    assert!(operation.await.is_err());
}
#[tokio::test]
async fn public_request_uses_fresh_exchange_identity() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let channel = Exchange::new(tx);
    let original = notification();
    let mut operation = Box::pin(channel.request(&original.profile_id, original.request.clone()));
    tokio::select! { biased; _ = &mut operation => panic!("early completion"), raw = rx.recv() => {
        let wire: Value = serde_json::from_str(&raw.unwrap()).unwrap();
        assert_ne!(wire["params"]["request"]["exchangeId"], original.request.exchange_id);
        let mut completion = fixture()["refusal"].clone(); completion["request"] = wire["params"]["request"].clone();
        complete_fixture(&channel, completion).unwrap();
    } }
    operation.await.unwrap();
}

#[tokio::test]
async fn stdio_scope_drop_closes_waiter_and_output_even_with_retained_state() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let channel = Arc::new(Exchange::new(tx));
    let lifetime = channel.lifetime();
    let mut operation = Box::pin(channel.wait(notification(), deadline()));
    tokio::select! { biased; _ = &mut operation => panic!("early completion"), _ = rx.recv() => {} }
    drop(lifetime);
    assert!(operation.await.is_err());
    assert!(rx.recv().await.is_none());
    assert!(channel.wait(notification(), deadline()).await.is_err());
}

#[cfg(windows)]
#[tokio::test]
async fn production_completion_requires_retained_registered_source_owner() {
    for retire in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let mut state = crate::state::AppState::open(directory.path()).unwrap();
        let mut registry = crate::execution_fence::Registry::start(directory.path()).unwrap();
        registry.bind_journal(directory.path()).unwrap();
        let (epoch, profile, _) = registry.read_source(None).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let channel = Arc::new(Exchange::new(tx));
        state.execution_fence = Some(registry);
        state.handoff_exchange = Some(channel.clone());
        let state = Arc::new(tokio::sync::Mutex::new(state));
        let mut request = notification();
        request.profile_id = profile;
        request.request.source_epoch = epoch.clone();
        let mut value = fixture()["refusal"].clone();
        value["profileId"] = json!(request.profile_id);
        value["request"] = serde_json::to_value(&request.request).unwrap();
        let mut operation = Box::pin(channel.wait(request, deadline()));
        tokio::select! { biased; _ = &mut operation => panic!("early completion"), _ = rx.recv() => {} }
        {
            let guard = state.lock().await;
            assert!(
                complete(state.clone(), value.clone()).await.is_err(),
                "contended state refuses"
            );
            if retire {
                guard
                    .db
                    .conn()
                    .execute(
                        "UPDATE execution_owners SET retired=1 WHERE epoch=?1",
                        [&epoch],
                    )
                    .unwrap();
            }
        }
        let result = complete(state.clone(), value).await;
        if retire {
            assert!(result.is_err());
            assert!(operation.await.is_err());
        } else {
            result.unwrap();
            assert!(matches!(operation.await.unwrap(), Outcome::Refusal { .. }));
        }
        state.lock().await.shutdown();
        assert!(rx.recv().await.is_none());
    }
}
