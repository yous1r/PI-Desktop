//! Retained intervention receipts: replay safety, authorization fences,
//! lifecycle ledger and the durable parent notification.

use super::goal::{self, GoalCommit};
use super::limits::ReceiptError;
use super::notification::{self, NotificationState};
use super::payload::InterventionIntent;
use super::receipt::{self, ReceiptTransition};
use super::reservation::{self, ReservationRequest};
use super::state::{Operation, ReceiptStatus, ReservationState};
use super::tests::*;

/// The frozen canonical payload fingerprint from
/// `packages/shared/test/fixtures/command-center-control.json`.
const FIXTURE_FINGERPRINT: &str =
    "cfa2ae39ace9ef06c93907866b0f1c33e3f887599cc5b75c43a1f1d9febe911c";

#[test]
fn recording_the_fixture_intervention_is_idempotent() {
    let conn = database();
    fixture_scene(&conn);

    let first = receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW)
        .expect("record the fixture intervention");
    assert!(!first.replayed);
    assert_eq!(first.receipt.operation, Operation::ReviseGoal);
    assert_eq!(first.receipt.status, ReceiptStatus::Recorded);
    assert_eq!(first.receipt.revision, 1);
    assert_eq!(first.receipt.desired_revision, 5);
    assert_eq!(first.receipt.effective_revision, 4);
    assert_eq!(first.receipt.membership_revision, 7);
    assert_eq!(first.receipt.workspace_id, WORKSPACE);
    assert_eq!(first.receipt.owner_epoch, EPOCH);
    assert_eq!(first.receipt.target, fixture_execution());
    assert_eq!(first.receipt.fingerprint, FIXTURE_FINGERPRINT);
    assert!(first.receipt.error.is_none());

    let replay =
        receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW + 1)
            .expect("replay the same request");
    assert!(replay.replayed);
    assert_eq!(replay.receipt.sequence, first.receipt.sequence);
    assert_eq!(replay.receipt.revision, 1, "a replay is not a new attempt");
    assert_eq!(replay.receipt.created_at, first.receipt.created_at);
    assert_eq!(receipt_count(&conn), 1);
    assert_eq!(
        goal_revision_count(&conn),
        5,
        "revisions 1..4 are seeded, 5 is committed"
    );
}

#[test]
fn a_changed_payload_under_the_same_request_id_is_refused() {
    let conn = database();
    fixture_scene(&conn);
    receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW)
        .expect("record");

    let mut changed = fixture_request();
    changed.intent = InterventionIntent::ReviseGoal {
        objective: "A different objective".to_owned(),
        constraints: Vec::new(),
    };
    expect_error(
        receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &changed, NOW + 1),
        "CC_IDEMPOTENCY_CONFLICT",
    );

    assert_eq!(receipt_count(&conn), 1);
    assert_eq!(
        goal_revision_count(&conn),
        5,
        "a refused replay must not commit a second revision"
    );
    assert_eq!(
        goal::goal_head(&conn, &fixture_task())
            .expect("read head")
            .expect("head exists")
            .desired_revision,
        5
    );
}

#[test]
fn stop_skips_the_goal_fence_but_keeps_execution_authority() {
    let conn = database();
    fixture_scene(&conn);
    for (expected, request) in [(4, REQUEST_ID), (5, OTHER_REQUEST_ID)] {
        goal::commit_revision(
            &conn,
            &GoalCommit {
                target: fixture_task(),
                expected_desired_revision: expected,
                objective: format!("Later intent {expected}"),
                constraints: Vec::new(),
                actor: PRINCIPAL.to_owned(),
                request_id: request.to_owned(),
                now: NOW,
            },
        )
        .expect("advance the desired revision");
    }

    // The desired revision has moved twice; a cancellation still lands.
    let stop = receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_stop(), NOW + 1)
        .expect("stop is never blocked by a goal revision");
    assert_eq!(stop.receipt.operation, Operation::Stop);
    assert_eq!(stop.receipt.status, ReceiptStatus::Recorded);
    assert_eq!(stop.receipt.desired_revision, 6);
    assert_eq!(stop.receipt.effective_revision, 4);

    // Stop still has to name the live execution owner.
    let mut stale_epoch = fixture_stop();
    stale_epoch.request_id = OTHER_REQUEST_ID.to_owned();
    stale_epoch.expected_host_epoch = STALE_EPOCH.to_owned();
    expect_error(
        receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &stale_epoch, NOW + 2),
        "CC_EPOCH_CONFLICT",
    );
    assert_eq!(receipt_count(&conn), 1);
}

#[test]
fn a_stale_fence_has_no_effect() {
    let conn = database();
    fixture_scene(&conn);

    let mut stale_epoch = fixture_request();
    stale_epoch.expected_host_epoch = STALE_EPOCH.to_owned();
    expect_error(
        receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &stale_epoch, NOW),
        "CC_EPOCH_CONFLICT",
    );

    let mut stale_membership = fixture_request();
    stale_membership.expected_membership_revision = 6;
    expect_error(
        receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &stale_membership, NOW),
        "CC_MEMBERSHIP_CONFLICT",
    );

    let mut wrong_workspace = fixture_request();
    wrong_workspace.command_workspace_id = WORKSPACE_B.to_owned();
    expect_error(
        receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &wrong_workspace, NOW),
        "CC_MEMBERSHIP_CONFLICT",
    );

    let mut stale_goal = fixture_request();
    stale_goal.expected_goal_revision = Some(3);
    expect_error(
        receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &stale_goal, NOW),
        "CC_GOAL_CONFLICT",
    );

    assert_eq!(
        receipt_count(&conn),
        0,
        "a refused request leaves no receipt"
    );
    assert_eq!(goal_revision_count(&conn), 4);
    assert_eq!(
        goal::goal_head(&conn, &fixture_task())
            .expect("read head")
            .expect("head exists")
            .desired_revision,
        4
    );
}

#[test]
fn a_replaced_generation_is_not_addressable() {
    let conn = database();
    fixture_scene(&conn);

    let mut replacement = fixture_request();
    replacement.target = child_execution(REPLACEMENT_TURN, DELEGATION, 3);
    expect_error(
        receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &replacement, NOW),
        "CC_TARGET_NOT_FOUND",
    );
    assert_eq!(receipt_count(&conn), 0);
}

#[test]
fn a_settled_execution_refuses_new_control() {
    let conn = database();
    fixture_scene(&conn);
    transition(
        &conn,
        &fixture_execution(),
        ReservationState::Reserved,
        ReservationState::Failed,
        "launch_failed:spawn",
    )
    .expect("settle the execution");

    expect_error(
        receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_stop(), NOW),
        "CC_TARGET_SETTLED",
    );
    assert_eq!(receipt_count(&conn), 0);
}

#[test]
fn receipt_lifecycle_moves_are_fenced() {
    let conn = database();
    fixture_scene(&conn);
    let recorded = receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW)
        .expect("record")
        .receipt;

    // A bare status write may not fake consumption.
    expect_error(
        receipt::transition_receipt(
            &conn,
            &ReceiptTransition {
                sequence: recorded.sequence,
                expected_revision: 1,
                to: ReceiptStatus::Consumed,
                error: None,
                now: NOW + 1,
            },
        ),
        "CC_TRANSITION_INVALID",
    );

    let accepted = receipt::transition_receipt(
        &conn,
        &ReceiptTransition {
            sequence: recorded.sequence,
            expected_revision: 1,
            to: ReceiptStatus::Accepted,
            error: None,
            now: NOW + 1,
        },
    )
    .expect("accept");
    assert_eq!(accepted.revision, 2);

    // A stale observation is refused rather than applied twice.
    expect_error(
        receipt::transition_receipt(
            &conn,
            &ReceiptTransition {
                sequence: recorded.sequence,
                expected_revision: 1,
                to: ReceiptStatus::Rejected,
                error: Some(
                    ReceiptError::new("CONFLICT", "host epoch changed before dispatch")
                        .expect("error"),
                ),
                now: NOW + 2,
            },
        ),
        "CC_TRANSITION_CONFLICT",
    );

    // A failed status must name its error.
    expect_error(
        receipt::transition_receipt(
            &conn,
            &ReceiptTransition {
                sequence: recorded.sequence,
                expected_revision: 2,
                to: ReceiptStatus::Rejected,
                error: None,
                now: NOW + 2,
            },
        ),
        "CC_INVALID_ARGUMENT",
    );

    // `accepted` cannot become `conflicted` in the frozen shared table, so the
    // Host refuses the transition instead of widening the contract.
    expect_error(
        receipt::transition_receipt(
            &conn,
            &ReceiptTransition {
                sequence: recorded.sequence,
                expected_revision: 2,
                to: ReceiptStatus::Conflicted,
                error: Some(
                    ReceiptError::new("CONFLICT", "host epoch changed before dispatch")
                        .expect("error"),
                ),
                now: NOW + 2,
            },
        ),
        "CC_TRANSITION_INVALID",
    );
    assert_eq!(receipt_count(&conn), 1, "the ledger row is retained");
}

#[test]
fn deleting_a_receipt_is_refused() {
    let conn = database();
    fixture_scene(&conn);
    receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW)
        .expect("record");

    let delete = conn
        .execute("DELETE FROM cc_intervention_receipts", [])
        .map(|_| ())
        .map_err(anyhow::Error::from);
    expect_error(delete, "CC_RECEIPT_RETAINED");
    assert_eq!(receipt_count(&conn), 1);
}

#[test]
fn the_ledger_is_scoped_to_the_authenticated_principal() {
    let conn = database();
    fixture_scene(&conn);
    receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW)
        .expect("record");

    let mut other = fixture_stop();
    other.request_id = OTHER_REQUEST_ID.to_owned();
    receipt::record_intervention(&conn, HOST_ID, OTHER_PRINCIPAL, &other, NOW + 1)
        .expect("a second authenticated principal");

    let mine = receipt::receipts_page(&conn, HOST_ID, PRINCIPAL, 0, 10).expect("page");
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].request_id, REQUEST_ID);
    assert_eq!(mine[0].principal, PRINCIPAL);

    let theirs = receipt::receipts_page(&conn, HOST_ID, OTHER_PRINCIPAL, 0, 10).expect("page");
    assert_eq!(theirs.len(), 1);
    assert_eq!(theirs[0].request_id, OTHER_REQUEST_ID);
    assert!(
        receipt::receipt(&conn, HOST_ID, OTHER_PRINCIPAL, REQUEST_ID)
            .expect("read")
            .is_none()
    );
    expect_error(
        receipt::receipts_page(&conn, HOST_ID, PRINCIPAL, 0, 0),
        "CC_INVALID_ARGUMENT",
    );
}

#[test]
fn the_parent_is_notified_once_per_child_revision() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    seed_membership(&conn, PARENT_SESSION, WORKSPACE, 7);
    seed_goal_head(&conn, &fixture_task(), 4, 4);
    seed_goal_history(&conn, &fixture_task(), 4);
    // The parent owner is trusted admission data, never a request field.
    reservation::reserve(
        &conn,
        &ReservationRequest {
            target: fixture_execution(),
            workspace_id: WORKSPACE.to_owned(),
            expected_membership_revision: 7,
            owner_epoch: EPOCH.to_owned(),
            parent_key: Some(parent_task().key()),
            now: NOW,
        },
    )
    .expect("admit with a parent owner");

    receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW)
        .expect("record");
    let pending = notification::notification(&conn, &fixture_task().key(), 5)
        .expect("read notification")
        .expect("notification exists");
    assert_eq!(pending.parent_task_key, parent_task().key());
    assert_eq!(pending.state, NotificationState::Pending);
    assert_eq!(pending.execution_key, fixture_execution().key());
    assert_eq!(pending.request_id, REQUEST_ID);
    assert_eq!(pending.principal, PRINCIPAL);

    let delivered = notification::deliver_notification(&conn, &fixture_task().key(), 5, NOW + 1)
        .expect("deliver");
    assert_eq!(delivered.state, NotificationState::Delivered);
    let again = notification::deliver_notification(&conn, &fixture_task().key(), 5, NOW + 2)
        .expect("deliver twice");
    assert_eq!(again.state, NotificationState::Delivered);
    assert_eq!(again.updated_at, delivered.updated_at);

    // A replay of the intervention must not queue a second notification.
    receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW + 3)
        .expect("replay");
    assert_eq!(notification_count(&conn), 1);

    let open = notification::pending_for_parent(&conn, &parent_task().key(), 10)
        .expect("page notifications");
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].child_revision, 5);
}
