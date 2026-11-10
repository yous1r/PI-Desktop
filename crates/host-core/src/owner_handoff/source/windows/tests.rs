use super::*;
use crate::owner_handoff::source::{
    protocol::{Body, Code, Failure},
    tests::state,
};

#[tokio::test]
async fn native_source_queries_are_original_bound_and_leave_journal_unchanged() {
    let (directory, state, request) = state();
    let endpoint = Endpoint::claim(directory.path()).unwrap();
    assert!(Endpoint::claim(directory.path()).is_err());
    let mut source = endpoint
        .bind(Service::capture(state.clone()).unwrap().unwrap())
        .unwrap();
    for _ in 0..3 {
        assert!(matches!(
            query(directory.path(), &request).await.unwrap().result,
            Body::Preflight(_)
        ));
    }
    {
        let guard = state.lock().await;
        let reply = query(directory.path(), &request).await.unwrap();
        assert!(matches!(
            reply.result,
            Body::Failure {
                error: Failure {
                    code: Code::Unavailable
                },
                ..
            }
        ));
        let count: i64 = guard
            .db
            .conn()
            .query_row("SELECT COUNT(*) FROM owner_handoffs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        guard
            .db
            .conn()
            .execute("UPDATE execution_owners SET retired=1", [])
            .unwrap();
    }
    assert!(matches!(
        query(directory.path(), &request).await.unwrap().result,
        Body::Failure {
            error: Failure {
                code: Code::OwnerChanged
            },
            ..
        }
    ));
    source.close().await;
    assert!(query(directory.path(), &request).await.is_err());
    assert!(Endpoint::claim(directory.path()).is_ok());
}
#[tokio::test]
async fn malformed_truncated_oversized_and_idle_clients_cannot_consume_the_source() {
    let (directory, state, request) = state();
    let mut source = Endpoint::claim(directory.path())
        .unwrap()
        .bind(Service::capture(state).unwrap().unwrap())
        .unwrap();
    let identity = Identity::current().unwrap();
    let name = address(&crate::owner_control::profile_id(directory.path()).unwrap());
    for bytes in [
        b"{bad".as_slice(),
        b"\xff",
        br#"{"protocol":"owner-transfer","version":1,"command":{"operation":"prepare"}}"#,
    ] {
        let (mut client, _peer) = connect(&name, &identity).await.unwrap();
        write_frame(&mut client, bytes).await.unwrap();
        assert!(
            tokio::time::timeout(BUDGET + Duration::from_secs(1), read_frame(&mut client))
                .await
                .unwrap()
                .is_err()
        );
    }
    let (mut huge, _peer) = connect(&name, &identity).await.unwrap();
    huge.write_u32_le(16385).await.unwrap();
    assert!(read_frame(&mut huge).await.is_err());
    drop(huge);
    let (mut partial, _peer) = connect(&name, &identity).await.unwrap();
    partial.write_u32_le(100).await.unwrap();
    partial.write_all(b"{").await.unwrap();
    drop(partial);
    assert!(query(directory.path(), &request).await.is_ok());
    let (mut idle, _peer) = connect(&name, &identity).await.unwrap();
    assert!(
        tokio::time::timeout(BUDGET + Duration::from_secs(1), read_frame(&mut idle))
            .await
            .unwrap()
            .is_err()
    );
    drop(idle);
    assert!(Endpoint::claim(directory.path()).is_err());
    assert!(query(directory.path(), &request).await.is_ok());
    source.close().await;
}
#[tokio::test]
async fn native_source_rejects_unexpected_server_image_before_writing_request() {
    let directory = tempfile::tempdir().unwrap();
    let identity = Identity::current().unwrap();
    let name = address(&crate::owner_control::profile_id(directory.path()).unwrap());
    let mut server = listener(&name, &identity, true).unwrap();
    let mut wrong = identity.clone();
    wrong.image = std::path::PathBuf::from("C:/wrong-host.exe");
    let client = tokio::spawn(async move { connect(&name, &wrong).await });
    server.connect().await.unwrap();
    assert!(client.await.unwrap().is_err());
    assert!(server.read_u8().await.is_err());
}
#[tokio::test]
async fn source_close_joins_an_idle_exchange_and_releases_endpoint() {
    let (directory, state, _request) = state();
    let mut source = Endpoint::claim(directory.path())
        .unwrap()
        .bind(Service::capture(state).unwrap().unwrap())
        .unwrap();
    let identity = Identity::current().unwrap();
    let name = address(&crate::owner_control::profile_id(directory.path()).unwrap());
    let (mut client, _peer) = connect(&name, &identity).await.unwrap();
    tokio::time::timeout(BUDGET, source.close())
        .await
        .expect("source close must join the idle listener");
    assert!(source.task.is_finished());
    assert!(tokio::time::timeout(BUDGET, read_frame(&mut client))
        .await
        .expect("closed source must disconnect the client")
        .is_err());
    drop(client);
    assert!(Endpoint::claim(directory.path()).is_ok());
}
