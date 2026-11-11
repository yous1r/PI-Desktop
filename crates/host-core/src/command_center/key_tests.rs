//! Tuple-key encoding, parsing and boundary regressions.
//!
//! The shared contract encodes task and execution identity as JSON tuples
//! (`commandCenterTaskKey` / `commandCenterExecutionKey`). Delimiter joining
//! aliased distinct opaque identifiers, so these tests pin the tuple shape, the
//! component-derived length bound and the exact rejection of any key the shared
//! encoder would not produce.

use super::identity::{
    parse_execution_key, parse_task_key, validate_execution_key, validate_task_key,
    ExecutionTarget, TaskTarget, MAX_EXECUTION_KEY_CHARS, MAX_TASK_KEY_CHARS,
};
use super::limits::{MAX_CANONICAL_ID_CHARS, MAX_REVISION};
use super::notification::{self, PendingNotification};
use super::receipt;
use super::reservation::{self, ReservationRequest};
use super::tests::*;

/// Fill one component up to the canonical identifier bound without aliasing
/// the component boundary.
fn bounded(filler: char) -> String {
    filler.to_string().repeat(MAX_CANONICAL_ID_CHARS)
}

#[test]
fn keys_are_the_shared_json_tuples() {
    assert_eq!(
        TaskTarget::session("sess-main-1").key(),
        "[\"session\",\"sess-main-1\"]"
    );
    assert_eq!(
        TaskTarget::delegation("sess-parent-1", "del-chain-7").key(),
        "[\"delegation\",\"sess-parent-1\",\"del-chain-7\"]"
    );
    assert_eq!(
        ExecutionTarget::session("sess-main-1", "turn-main-4").key(),
        "[\"session\",\"sess-main-1\",\"turn-main-4\"]"
    );
    assert_eq!(
        ExecutionTarget::delegation("sess-parent-1", "turn-parent-3", "del-chain-7", 2).key(),
        "[\"delegation\",\"sess-parent-1\",\"turn-parent-3\",\"del-chain-7\",2]"
    );
    // The shared harness addresses the same vectors through the same tuples.
    assert_eq!(
        fixture_task().key(),
        "[\"delegation\",\"sess-parent-1\",\"del-chain-7\"]"
    );
    assert_eq!(
        fixture_execution().key(),
        "[\"delegation\",\"sess-parent-1\",\"turn-parent-3\",\"del-chain-7\",2]"
    );
}

#[test]
fn quoting_inside_an_identifier_survives_the_round_trip() {
    let target = TaskTarget::session("sess \"quoted\" \\ slash");
    let key = target.key();
    // Same escaping as `JSON.stringify`: quotes and backslashes, nothing else.
    assert_eq!(key, "[\"session\",\"sess \\\"quoted\\\" \\\\ slash\"]");
    assert_eq!(parse_task_key(&key).expect("the key must parse"), target);
    // The escaped spelling is accepted, a re-escaped look-alike is not.
    expect_error(
        validate_task_key("[\"session\",\"sess \\u0022quoted\\u0022\"]"),
        "CC_INVALID_IDENTITY",
    );
}

#[test]
fn opaque_component_boundaries_do_not_collide() {
    let joined = TaskTarget::delegation("parent:part", "child");
    let split = TaskTarget::delegation("parent", "part:child");
    assert_eq!(joined.key(), "[\"delegation\",\"parent:part\",\"child\"]");
    assert_eq!(split.key(), "[\"delegation\",\"parent\",\"part:child\"]");
    assert_ne!(
        joined.key(),
        split.key(),
        "a colon join made these two owners identical"
    );

    let session = ExecutionTarget::session("session:part", "turn");
    let other = ExecutionTarget::session("session", "part:turn");
    assert_ne!(session.key(), other.key());
    let child = ExecutionTarget::delegation("parent:part", "turn", "child", 1);
    let other_child = ExecutionTarget::delegation("parent", "part:turn", "child", 1);
    assert_ne!(child.key(), other_child.key());

    // Kind, turn and generation stay part of the identity too.
    assert_ne!(TaskTarget::session("parent:part").key(), joined.key());
    assert_ne!(
        ExecutionTarget::delegation("parent:part", "turn", "child", 1).key(),
        ExecutionTarget::delegation("parent:part", "turn", "child", 2).key()
    );
    assert_ne!(
        ExecutionTarget::delegation("parent:part", "turn", "child", 1).key(),
        ExecutionTarget::delegation("parent:part", "turn:2", "child", 1).key()
    );
}

#[test]
fn valid_long_identifiers_fit_the_tuple_keys() {
    let parent = bounded('p');
    let delegation = bounded('d');
    let turn = bounded('t');

    let task = TaskTarget::delegation(&parent, &delegation);
    let key = task.key();
    assert!(
        key.chars().count() <= MAX_TASK_KEY_CHARS,
        "a fully bounded task key must fit its own bound"
    );
    assert_eq!(parse_task_key(&key).expect("bounded task key"), task);

    let execution = ExecutionTarget::delegation(&parent, &turn, &delegation, MAX_REVISION);
    let key = execution.key();
    assert!(
        key.chars().count() <= MAX_EXECUTION_KEY_CHARS,
        "a fully bounded execution key must fit its own bound"
    );
    assert_eq!(
        parse_execution_key(&key).expect("bounded execution key"),
        execution
    );

    // Worst case for the bound: every component is a C0 control, which the
    // shared encoder renders as six characters each.
    let escaped = "\u{1}".repeat(MAX_CANONICAL_ID_CHARS);
    let worst = ExecutionTarget::delegation(&escaped, &escaped, &escaped, MAX_REVISION);
    let key = worst.key();
    assert!(
        key.chars().count() <= MAX_EXECUTION_KEY_CHARS,
        "the derived bound must cover worst-case escaping"
    );
    assert_eq!(parse_execution_key(&key).expect("escaped key"), worst);

    // One character over the component bound is still refused.
    let over = TaskTarget::session(&"x".repeat(MAX_CANONICAL_ID_CHARS + 1));
    expect_error(validate_task_key(&over.key()), "CC_INVALID_IDENTITY");
}

#[test]
fn malformed_task_keys_are_rejected() {
    for key in [
        "",
        "sess-main-1",
        "session:sess-main-1",
        "[\"session\"]",
        "[\"session\",\"sess-main-1\",\"turn-main-4\"]",
        "[\"delegation\",\"sess-main-1\"]",
        "[\"delegation\",\"sess-main-1\",\"del-1\",\"extra\"]",
        "[\"session\",1]",
        "[\"session\",null]",
        "[\"bogus\",\"sess-main-1\"]",
        "[\"session\",\"sess-main-1\"] ",
        "[\"session\",\"sess-main-1\"]x",
        "[{\"session\":\"sess-main-1\"}]",
        "[\"session\",\"sess\\/main-1\"]",
        "[\"session\",\"sess\\u0000main-1\"]",
        "[\"session\",\"\"]",
    ] {
        expect_error(validate_task_key(key), "CC_INVALID_IDENTITY");
    }

    // An unbounded raw value is refused before it is decoded.
    let unbounded = format!("[\"session\",\"{}\"]", "x".repeat(5_000));
    expect_error(validate_task_key(&unbounded), "CC_INVALID_IDENTITY");
}

#[test]
fn malformed_execution_keys_are_rejected() {
    for key in [
        "[\"session\",\"sess-main-1\"]",
        "[\"session\",\"sess-main-1\",\"turn-main-4\",\"extra\"]",
        "[\"delegation\",\"parent\",\"turn\",\"child\"]",
        "[\"delegation\",\"parent\",\"turn\",\"child\",1,\"extra\"]",
        "[\"delegation\",\"parent\",\"turn\",\"child\",0]",
        "[\"delegation\",\"parent\",\"turn\",\"child\",-1]",
        "[\"delegation\",\"parent\",\"turn\",\"child\",1.0]",
        "[\"delegation\",\"parent\",\"turn\",\"child\",1e0]",
        "[\"delegation\",\"parent\",\"turn\",\"child\",\"1\"]",
        "[\"delegation\",\"parent\",\"turn\",\"child\",9007199254740992]",
        "[\"delegation\",\"parent\",\"turn\",\"child\",01]",
        "[\"child\",\"parent\",\"turn\",\"child\",1]",
    ] {
        expect_error(validate_execution_key(key), "CC_INVALID_IDENTITY");
    }

    let unbounded = format!("[\"session\",\"sess\",\"{}\"]", "t".repeat(5_000));
    expect_error(validate_execution_key(&unbounded), "CC_INVALID_IDENTITY");
}

#[test]
fn a_long_parent_and_child_key_stay_readable_in_storage() {
    let conn = database();
    let parent = TaskTarget::session(&bounded('p'));
    let parent_key = parent.key();
    let long_delegation = bounded('d');
    let long_parent = bounded('q');
    let child = TaskTarget::delegation(&long_parent, &long_delegation);
    let execution =
        ExecutionTarget::delegation(&long_parent, &bounded('t'), &long_delegation, MAX_REVISION);

    let stored = notification::record_pending(
        &conn,
        &PendingNotification {
            child_task_key: child.key(),
            parent_task_key: parent_key.clone(),
            child_revision: 12,
            execution_key: execution.key(),
            host_id: HOST_ID.to_owned(),
            principal: PRINCIPAL.to_owned(),
            request_id: REQUEST_ID.to_owned(),
            now: NOW,
        },
    )
    .expect("a fully bounded notification must be storable");

    assert_eq!(stored.parent_task_key, parent_key);
    assert_eq!(stored.execution_key, execution.key());
    let open = notification::pending_for_parent(&conn, &parent_key, 10).expect("page");
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].child_task_key, child.key());

    // The same access path refuses a key that is not a canonical tuple.
    expect_error(
        notification::pending_for_parent(&conn, "session:sess-parent-1", 10),
        "CC_INVALID_IDENTITY",
    );
}

#[test]
fn admission_rejects_a_parent_key_that_is_not_a_canonical_task_key() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    seed_membership(&conn, PARENT_SESSION, WORKSPACE, 7);
    let request = |parent_key: String| ReservationRequest {
        target: fixture_execution(),
        workspace_id: WORKSPACE.to_owned(),
        expected_membership_revision: 7,
        owner_epoch: EPOCH.to_owned(),
        parent_key: Some(parent_key),
        now: NOW,
    };

    // Admission data is trusted for authorization, not for encoding.
    expect_error(
        reservation::reserve(&conn, &request("session:sess-parent-1".to_owned())),
        "CC_INVALID_IDENTITY",
    );
    expect_error(
        reservation::reserve(
            &conn,
            &request(format!("[\"session\",\"{}\"]", "x".repeat(5_000))),
        ),
        "CC_INVALID_IDENTITY",
    );
    expect_error(
        reservation::reserve(&conn, &request(String::new())),
        "CC_INVALID_IDENTITY",
    );

    let expected = parent_task().key();
    let admitted =
        reservation::reserve(&conn, &request(parent_task().key())).expect("canonical parent key");
    assert_eq!(admitted.parent_key.as_deref(), Some(expected.as_str()));
    assert_eq!(admitted.task_key, fixture_task().key());
}

#[test]
fn a_replaced_execution_cannot_be_reached_through_the_old_key() {
    let conn = database();
    fixture_scene(&conn);
    let live = fixture_execution();
    let replacement = ExecutionTarget::delegation(PARENT_SESSION, REPLACEMENT_TURN, DELEGATION, 3);

    assert_ne!(live.key(), replacement.key());
    assert_eq!(parse_execution_key(&live.key()).expect("live"), live);
    assert_eq!(
        parse_execution_key(&replacement.key()).expect("replacement"),
        replacement
    );
    assert!(reservation::reservation(&conn, &live.key())
        .expect("lookup")
        .is_some());
    assert!(
        reservation::reservation(&conn, &replacement.key())
            .expect("lookup")
            .is_none(),
        "the replacement run was never admitted under the old identity"
    );

    // A control aimed at the replacement cannot borrow the live reservation.
    let mut request = fixture_request();
    request.target = replacement.clone();
    expect_error(
        receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &request, NOW),
        "CC_TARGET_NOT_FOUND",
    );
    assert_eq!(receipt_count(&conn), 0);

    // The stable owner is unchanged, which is why the goal follows the task and
    // not the run.
    assert_eq!(replacement.task(), live.task());
    assert_eq!(live.task().key(), fixture_task().key());
}

#[test]
fn a_notification_must_name_its_own_execution() {
    let conn = database();
    let child = fixture_task();
    let pending = |child_task_key: String, execution_key: String| PendingNotification {
        child_task_key,
        parent_task_key: parent_task().key(),
        child_revision: 1,
        execution_key,
        host_id: HOST_ID.to_owned(),
        principal: PRINCIPAL.to_owned(),
        request_id: REQUEST_ID.to_owned(),
        now: NOW,
    };

    notification::record_pending(&conn, &pending(child.key(), fixture_execution().key()))
        .expect("the fixture execution belongs to the fixture task");

    // A well-formed key of another owner is still the wrong execution.
    let other = TaskTarget::session(MAIN_SESSION);
    expect_error(
        notification::record_pending(&conn, &pending(other.key(), fixture_execution().key())),
        "CC_INVALID_ARGUMENT",
    );
}
