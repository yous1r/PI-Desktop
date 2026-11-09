use super::*;

fn identity() -> Value {
    json!({"version":1,"requestId":uuid::Uuid::new_v4().to_string()})
}
#[test]
fn queries_are_strict_bounded_and_canonical() {
    let valid = identity();
    assert!(Request::parse(IDENTITY, valid.clone()).is_ok());
    for (key, value) in [
        ("version", json!(2)),
        ("idle", json!(true)),
        ("sourceEpoch", json!(uuid::Uuid::new_v4().to_string())),
        ("requestId", json!("00000000-0000-0000-0000-000000000000")),
        ("requestId", json!("x".repeat(model::MAX_RECORD_BYTES))),
    ] {
        let mut invalid = valid.clone();
        invalid[key] = value;
        assert!(Request::parse(IDENTITY, invalid).is_err());
    }
    let mut transfer = valid;
    transfer["sourceEpoch"] = json!(uuid::Uuid::new_v4().to_string());
    transfer["transferId"] = json!(uuid::Uuid::new_v4().to_string());
    transfer["profileId"] = json!("a".repeat(64));
    assert!(Request::parse(TRANSFER, transfer.clone()).is_ok());
    for key in ["sourceEpoch", "transferId", "profileId"] {
        let mut bad = transfer.clone();
        bad[key] = json!("invalid");
        assert!(Request::parse(TRANSFER, bad).is_err());
    }
    assert!(Request::parse("ownerHandoff.other", transfer).is_err());
}

#[cfg(windows)]
#[tokio::test]
async fn identity_before_generation_requires_original_registered_owner_and_available_state() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = AppState::open(directory.path()).unwrap();
    let mut registry = crate::execution_fence::Registry::start(directory.path()).unwrap();
    assert!(registry.read_source(None).is_err());
    registry.bind_journal(directory.path()).unwrap();
    let epoch = registry.epoch().to_string();
    state.execution_fence = Some(registry);
    let state = Arc::new(Mutex::new(state));
    let request = identity();
    let value = handle(state.clone(), IDENTITY, request.clone())
        .await
        .unwrap();
    assert_eq!(
        value,
        json!({"version":1,"requestId":request["requestId"],"sourceEpoch":epoch,
        "profileId":crate::owner_control::profile_id(directory.path()).unwrap()})
    );
    {
        let guard = state.lock().await;
        assert!(handle(state.clone(), IDENTITY, request.clone())
            .await
            .is_err());
        guard
            .db
            .conn()
            .execute(
                "UPDATE execution_owners SET retired=1 WHERE epoch=?1",
                [&epoch],
            )
            .unwrap();
    }
    assert!(handle(state.clone(), IDENTITY, request.clone())
        .await
        .is_err());
    state.lock().await.execution_fence = None;
    assert!(handle(state, IDENTITY, request).await.is_err());
}
