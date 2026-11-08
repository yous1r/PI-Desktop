use super::*;
use crate::owner_control::protocol::{Failure, MAX_FRAME_BYTES};

async fn raw_request(name: &str, bytes: &[u8]) -> Response {
    let mut pipe = connect(name).await.unwrap();
    write_frame(&mut pipe, bytes).await.unwrap();
    let response = serde_json::from_slice(&read_frame(&mut pipe).await.unwrap()).unwrap();
    pipe.write_u8(0).await.unwrap();
    response
}

#[tokio::test]
async fn status_same_directory_alias_conflict_stale_epoch_and_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut control = Control::start(root.path()).unwrap();
    assert!(Control::start(root.path()).is_err());
    let current = query(root.path(), None).await.unwrap().status.unwrap();
    assert_eq!(current.process_id, std::process::id());
    assert_eq!(current.operations, ["status"]);
    assert!(query(root.path(), Some(current.owner_epoch.clone()))
        .await
        .unwrap()
        .error
        .is_none());
    for _ in 0..100 {
        assert_eq!(
            query(root.path(), None)
                .await
                .unwrap()
                .status
                .unwrap()
                .owner_epoch,
            current.owner_epoch
        );
    }
    assert_eq!(
        query(root.path(), Some("old".into())).await.unwrap().error,
        Some(Failure::StaleOwner)
    );
    let alias = root.path().join(".");
    assert_eq!(
        query(&alias, None)
            .await
            .unwrap()
            .status
            .unwrap()
            .profile_id,
        current.profile_id
    );
    let other = tempfile::tempdir().unwrap();
    let mut other_control = Control::start(other.path()).unwrap();
    assert_ne!(
        query(other.path(), None)
            .await
            .unwrap()
            .status
            .unwrap()
            .profile_id,
        current.profile_id
    );
    control.close().await;
    assert!(query(root.path(), None).await.is_err());
    let mut successor = Control::start(root.path()).unwrap();
    assert_ne!(
        query(root.path(), None)
            .await
            .unwrap()
            .status
            .unwrap()
            .owner_epoch,
        current.owner_epoch
    );
    successor.close().await;
    other_control.close().await;
}

#[tokio::test]
async fn version_malformed_oversized_and_truncated_clients_do_not_stop_listener() {
    let root = tempfile::tempdir().unwrap();
    let mut control = Control::start(root.path()).unwrap();
    let identity = Identity::current().unwrap();
    let (name, _) = address(root.path(), &identity).unwrap();
    let mut request = Request::status(None);
    request.version = 2;
    assert_eq!(
        raw_request(&name, &serde_json::to_vec(&request).unwrap())
            .await
            .error,
        Some(Failure::UnsupportedVersion)
    );
    for bytes in [
        b"{bad".as_slice(),
        br#"{"version":1,"requestId":"x","operation":"prepare"}"#,
        b"\xff",
    ] {
        let mut pipe = connect(&name).await.unwrap();
        write_frame(&mut pipe, bytes).await.unwrap();
        assert!(read_frame(&mut pipe).await.is_err());
    }
    let mut huge = connect(&name).await.unwrap();
    huge.write_u32_le(MAX_FRAME_BYTES as u32 + 1).await.unwrap();
    assert!(read_frame(&mut huge).await.is_err());
    drop(huge);
    let mut partial = connect(&name).await.unwrap();
    partial.write_u32_le(128).await.unwrap();
    partial.write_all(b"{").await.unwrap();
    drop(partial);
    assert!(query(root.path(), None).await.unwrap().status.is_some());
    control.close().await;
}

#[tokio::test]
async fn idle_client_expires_and_name_stays_owned_until_explicit_close() {
    let root = tempfile::tempdir().unwrap();
    let mut control = Control::start(root.path()).unwrap();
    let identity = Identity::current().unwrap();
    let (name, _) = address(root.path(), &identity).unwrap();
    let mut idle = connect(&name).await.unwrap();
    assert!(tokio::time::timeout(
        EXCHANGE_TIMEOUT + Duration::from_secs(1),
        read_frame(&mut idle)
    )
    .await
    .unwrap()
    .is_err());
    assert!(Control::start(root.path()).is_err());
    assert!(query(root.path(), None).await.unwrap().status.is_some());
    control.close().await;
}

#[path = "security_tests.rs"]
mod security_tests;
