//! Desired versus effective goal revisions: a compare-and-swap commit, an
//! immutable history, and an effective revision that only a concrete execution
//! acknowledgement may advance.

use super::goal::{self, GoalCommit, GoalHead};
use super::payload::Consumption;
use super::receipt::{self, ReceiptTransition};
use super::state::ReceiptStatus;
use super::tests::*;

fn commit(objective: &str, expected_desired_revision: i64) -> GoalCommit {
    GoalCommit {
        target: fixture_task(),
        expected_desired_revision,
        objective: objective.to_owned(),
        constraints: vec!["Bound the change".to_owned()],
        actor: PRINCIPAL.to_owned(),
        request_id: REQUEST_ID.to_owned(),
        now: NOW,
    }
}

fn consumption_of(target: super::identity::ExecutionTarget, revision: i64) -> Consumption {
    Consumption {
        request_id: REQUEST_ID.to_owned(),
        target,
        consumed_revision: revision,
        boundary: "model_step".to_owned(),
    }
}

#[test]
fn commit_is_a_compare_and_swap_on_the_desired_revision() {
    let conn = database();
    let target = fixture_task();

    let first = goal::commit_revision(&conn, &commit("First objective", 0)).expect("first commit");
    assert_eq!(first.desired_revision, 1);
    assert_eq!(
        first.effective_revision, 0,
        "acceptance is not effectiveness"
    );

    expect_error(
        goal::commit_revision(&conn, &commit("Racing objective", 0)),
        "CC_GOAL_CONFLICT",
    );

    let second =
        goal::commit_revision(&conn, &commit("Second objective", 1)).expect("second commit");
    assert_eq!(second.desired_revision, 2);

    let stored = goal::goal_revision(&conn, &target, 2)
        .expect("read revision")
        .expect("revision exists");
    assert_eq!(stored.objective, "Second objective");
    assert_eq!(stored.parent_revision, Some(1));
    assert_eq!(stored.constraints, vec!["Bound the change".to_owned()]);
    assert_eq!(stored.actor, PRINCIPAL);

    let first_revision = goal::goal_revision(&conn, &target, 1)
        .expect("read revision")
        .expect("revision exists");
    assert_eq!(first_revision.parent_revision, None);
    assert_eq!(goal_revision_count(&conn), 2);
}

#[test]
fn a_first_commit_cannot_claim_a_revision_that_does_not_exist() {
    let conn = database();
    expect_error(
        goal::commit_revision(&conn, &commit("Skipped history", 1)),
        "CC_GOAL_CONFLICT",
    );
    assert_eq!(goal_revision_count(&conn), 0);
}

#[test]
fn consumption_applies_ahead_stale_and_duplicate_rules() {
    let head = GoalHead {
        target: fixture_task(),
        desired_revision: 5,
        effective_revision: 4,
        updated_at: NOW,
    };
    assert_eq!(
        goal::apply_consumption(&head, 5)
            .expect("consume the current desired revision")
            .effective_revision,
        5
    );
    expect_error(goal::apply_consumption(&head, 6), "CC_CONSUMPTION_AHEAD");

    let caught_up = GoalHead {
        effective_revision: 5,
        ..head
    };
    expect_error(
        goal::apply_consumption(&caught_up, 4),
        "CC_CONSUMPTION_STALE",
    );
    // A duplicate acknowledgement is idempotent, not stale.
    assert_eq!(
        goal::apply_consumption(&caught_up, 5)
            .expect("duplicate acknowledgement")
            .effective_revision,
        5
    );
}

#[test]
fn effective_revision_moves_only_on_the_acknowledgement() {
    let conn = database();
    fixture_scene(&conn);

    let outcome = receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW)
        .expect("record the fixture intervention");
    assert_eq!(outcome.receipt.status, ReceiptStatus::Recorded);
    assert_eq!(outcome.receipt.desired_revision, 5);
    assert_eq!(outcome.receipt.effective_revision, 4);

    let head = goal::goal_head(&conn, &fixture_task())
        .expect("read head")
        .expect("head exists");
    assert_eq!(head.desired_revision, 5);
    assert_eq!(head.effective_revision, 4);

    receipt::transition_receipt(
        &conn,
        &ReceiptTransition {
            sequence: outcome.receipt.sequence,
            expected_revision: 1,
            to: ReceiptStatus::Accepted,
            error: None,
            now: NOW + 1,
        },
    )
    .expect("accept the intervention");
    assert_eq!(
        goal::goal_head(&conn, &fixture_task())
            .expect("read head")
            .expect("head exists")
            .effective_revision,
        4,
        "acceptance still does not make a revision effective"
    );

    let acknowledged = goal::acknowledge_consumption(
        &conn,
        HOST_ID,
        PRINCIPAL,
        &consumption_of(fixture_execution(), 5),
        NOW + 2,
    )
    .expect("acknowledge consumption");
    assert_eq!(acknowledged.desired_revision, 5);
    assert_eq!(acknowledged.effective_revision, 5);

    let stored = receipt::receipt(&conn, HOST_ID, PRINCIPAL, REQUEST_ID)
        .expect("read receipt")
        .expect("receipt exists");
    assert_eq!(stored.status, ReceiptStatus::Consumed);
    assert_eq!(stored.effective_revision, 5);
    assert_eq!(stored.revision, 3);
}

#[test]
fn a_recorded_receipt_cannot_be_consumed_directly() {
    let conn = database();
    fixture_scene(&conn);
    receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW)
        .expect("record");

    expect_error(
        goal::acknowledge_consumption(
            &conn,
            HOST_ID,
            PRINCIPAL,
            &consumption_of(fixture_execution(), 5),
            NOW + 1,
        ),
        "CC_CONSUMPTION_CONFLICT",
    );
    assert_eq!(
        goal::goal_head(&conn, &fixture_task())
            .expect("read head")
            .expect("head exists")
            .effective_revision,
        4
    );
}

#[test]
fn a_repeated_acknowledgement_is_idempotent() {
    let conn = database();
    fixture_scene(&conn);
    let outcome = receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW)
        .expect("record");
    receipt::transition_receipt(
        &conn,
        &ReceiptTransition {
            sequence: outcome.receipt.sequence,
            expected_revision: 1,
            to: ReceiptStatus::Accepted,
            error: None,
            now: NOW + 1,
        },
    )
    .expect("accept");

    let first = goal::acknowledge_consumption(
        &conn,
        HOST_ID,
        PRINCIPAL,
        &consumption_of(fixture_execution(), 5),
        NOW + 2,
    )
    .expect("first acknowledgement");
    let second = goal::acknowledge_consumption(
        &conn,
        HOST_ID,
        PRINCIPAL,
        &consumption_of(fixture_execution(), 5),
        NOW + 3,
    )
    .expect("replayed acknowledgement");
    assert_eq!(first, second);
    assert_eq!(
        receipt::receipt(&conn, HOST_ID, PRINCIPAL, REQUEST_ID)
            .expect("read receipt")
            .expect("receipt exists")
            .revision,
        3,
        "a replay must not advance the receipt again"
    );
}

#[test]
fn an_acknowledgement_must_name_the_receipt_execution() {
    let conn = database();
    fixture_scene(&conn);
    let outcome = receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &fixture_request(), NOW)
        .expect("record");
    receipt::transition_receipt(
        &conn,
        &ReceiptTransition {
            sequence: outcome.receipt.sequence,
            expected_revision: 1,
            to: ReceiptStatus::Accepted,
            error: None,
            now: NOW + 1,
        },
    )
    .expect("accept");

    // Generation 3 is the replacement run: a delayed event from it must not make
    // the acknowledged generation 2 look consumed.
    let replacement = child_execution(REPLACEMENT_TURN, DELEGATION, 3);
    expect_error(
        goal::acknowledge_consumption(
            &conn,
            HOST_ID,
            PRINCIPAL,
            &consumption_of(replacement, 5),
            NOW + 2,
        ),
        "CC_CONSUMPTION_TARGET",
    );
    assert_eq!(
        goal::goal_head(&conn, &fixture_task())
            .expect("read head")
            .expect("head exists")
            .effective_revision,
        4
    );
}

#[test]
fn goal_revisions_are_immutable() {
    let conn = database();
    fixture_scene(&conn);
    let key = fixture_task().key();

    let update = conn
        .execute(
            "UPDATE cc_goal_revisions SET objective = 'rewritten' WHERE task_key = ?1",
            [&key],
        )
        .map(|_| ())
        .map_err(anyhow::Error::from);
    expect_error(update, "CC_GOAL_REVISION_IMMUTABLE");

    let delete = conn
        .execute("DELETE FROM cc_goal_revisions WHERE task_key = ?1", [&key])
        .map(|_| ())
        .map_err(anyhow::Error::from);
    expect_error(delete, "CC_GOAL_REVISION_IMMUTABLE");

    let stored = goal::goal_revision(&conn, &fixture_task(), 4)
        .expect("read revision")
        .expect("revision exists");
    assert_eq!(stored.objective, "Seeded objective 4");
    assert_eq!(goal_revision_count(&conn), 4);
}
