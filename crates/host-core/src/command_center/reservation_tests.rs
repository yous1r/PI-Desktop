//! Capacity authority: twelve live per workspace, thirty-six per Host, and a
//! slot released exactly once by an evidence-carrying terminal transition.

use super::reservation;
use super::state::ReservationState;
use super::tests::*;
use super::workspace;

#[test]
fn workspace_holds_twelve_live_executions() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    for slot in 0..12 {
        let session = format!("sess-slot-{slot}");
        seed_membership(&conn, &session, WORKSPACE, 1);
        admit(&conn, WORKSPACE, &session_execution(&session), 1).expect("admit a slot");
    }
    assert_eq!(
        reservation::live_for_workspace(&conn, WORKSPACE).expect("count workspace"),
        12
    );

    let overflow = "sess-overflow";
    seed_membership(&conn, overflow, WORKSPACE, 1);
    let error = expect_error(
        admit(&conn, WORKSPACE, &session_execution(overflow), 1),
        "CC_QUOTA_EXCEEDED",
    );
    assert!(error.contains("12"), "{error}");
    assert_eq!(reservation::live_counts(&conn).expect("counts").host, 12);
}

#[test]
fn host_capacity_is_thirty_six_across_three_workspaces() {
    let conn = database();
    let spaces = [WORKSPACE, WORKSPACE_B, WORKSPACE_C];
    for (index, space) in spaces.iter().enumerate() {
        create_workspace(&conn, space, &format!("Space {index}"));
    }
    for space in spaces {
        for slot in 0..12 {
            let session = format!("sess-{}-{slot}", &space[..8]);
            seed_membership(&conn, &session, space, 1);
            admit(&conn, space, &session_execution(&session), 1).expect("admit a slot");
        }
    }

    let counts = reservation::live_counts(&conn).expect("counts");
    assert_eq!(counts.host, 36);
    assert_eq!(counts.workspaces.len(), 3);

    // The Host cap is checked before the per-workspace cap, so an admission
    // into an existing enabled workspace is refused once thirty-six live
    // executions exist.
    let overflow = "sess-host-overflow";
    seed_membership(&conn, overflow, WORKSPACE, 1);
    let error = expect_error(
        admit(&conn, WORKSPACE, &session_execution(overflow), 1),
        "CC_QUOTA_EXCEEDED",
    );
    assert!(error.contains("36"), "{error}");

    // A fourth enabled workspace cannot exist under the frozen three-workspace
    // quota, which is why the Host cap can only be reached through three
    // twelve-slot workspaces.
    expect_error(
        workspace::create_workspace(&conn, WORKSPACE_D, "Delta", true, NOW),
        "CC_QUOTA_EXCEEDED",
    );
}

#[test]
fn capacity_is_released_exactly_once() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    seed_membership(&conn, MAIN_SESSION, WORKSPACE, 1);
    let target = session_execution(MAIN_SESSION);
    admit(&conn, WORKSPACE, &target, 1).expect("admit");

    let released = transition(
        &conn,
        &target,
        ReservationState::Reserved,
        ReservationState::Failed,
        "launch_failed:spawn",
    )
    .expect("release");
    assert_eq!(released.state, ReservationState::Failed);
    assert!(released.released_at.is_some());
    assert_eq!(reservation::live_counts(&conn).expect("counts").host, 0);

    let events = reservation::events(&conn, &target.key()).expect("events");
    assert_eq!(events.len(), 1, "release is proven by exactly one event");
    assert_eq!(events[0].from, ReservationState::Reserved);
    assert_eq!(events[0].to, ReservationState::Failed);
    assert_eq!(events[0].evidence, "launch_failed:spawn");

    // The state table forbids any continuation from a terminal state.
    expect_error(
        transition(
            &conn,
            &target,
            ReservationState::Failed,
            ReservationState::Completed,
            "late_settlement",
        ),
        "CC_TRANSITION_INVALID",
    );
    // And the row-level compare-and-set rejects a stale observation.
    expect_error(
        transition(
            &conn,
            &target,
            ReservationState::Reserved,
            ReservationState::Failed,
            "stale_observation",
        ),
        "CC_TRANSITION_CONFLICT",
    );
    assert_eq!(
        reservation::events(&conn, &target.key())
            .expect("events")
            .len(),
        1
    );
}

#[test]
fn interrupted_and_outcome_unknown_retain_capacity() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    seed_membership(&conn, PARENT_SESSION, WORKSPACE, 1);
    let unknown = child_execution(PARENT_TURN, DELEGATION, 2);
    admit(&conn, WORKSPACE, &unknown, 1).expect("admit the child");

    transition(
        &conn,
        &unknown,
        ReservationState::Reserved,
        ReservationState::Starting,
        "launch_ack",
    )
    .expect("start");
    transition(
        &conn,
        &unknown,
        ReservationState::Starting,
        ReservationState::OutcomeUnknown,
        "owner_heartbeat_lost",
    )
    .expect("mark unknown");
    assert_eq!(
        reservation::live_counts(&conn).expect("counts").host,
        1,
        "an unproven outcome keeps its slot"
    );

    transition(
        &conn,
        &unknown,
        ReservationState::OutcomeUnknown,
        ReservationState::Failed,
        "journal:no_run_record",
    )
    .expect("release with evidence");
    assert_eq!(reservation::live_counts(&conn).expect("counts").host, 0);
}

#[test]
fn duplicate_admission_returns_the_existing_reservation() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    seed_membership(&conn, MAIN_SESSION, WORKSPACE, 1);
    let target = session_execution(MAIN_SESSION);
    let first = admit(&conn, WORKSPACE, &target, 1).expect("first admission");
    let second = admit(&conn, WORKSPACE, &target, 1).expect("duplicate admission");
    assert_eq!(first, second);
    assert_eq!(reservation::live_counts(&conn).expect("counts").host, 1);
}

#[test]
fn admission_rejects_a_mismatched_workspace_or_epoch() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    create_workspace(&conn, WORKSPACE_B, "Beta");
    seed_membership(&conn, MAIN_SESSION, WORKSPACE, 1);
    let target = session_execution(MAIN_SESSION);
    admit(&conn, WORKSPACE, &target, 1).expect("admit");

    expect_error(
        admit(&conn, WORKSPACE_B, &target, 1),
        "CC_MEMBERSHIP_CONFLICT",
    );

    let foreign_epoch = reservation::ReservationRequest {
        target: target.clone(),
        workspace_id: WORKSPACE.to_owned(),
        expected_membership_revision: 1,
        owner_epoch: STALE_EPOCH.to_owned(),
        parent_key: None,
        now: NOW,
    };
    expect_error(
        reservation::reserve(&conn, &foreign_epoch),
        "CC_EPOCH_CONFLICT",
    );
}

#[test]
fn epoch_interruption_retains_capacity_until_evidence_arrives() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    seed_membership(&conn, MAIN_SESSION, WORKSPACE, 1);
    let target = session_execution(MAIN_SESSION);
    admit(&conn, WORKSPACE, &target, 1).expect("admit");
    transition(
        &conn,
        &target,
        ReservationState::Reserved,
        ReservationState::Starting,
        "launch_ack",
    )
    .expect("start");

    let interrupted = reservation::interrupt_epoch(
        &conn,
        STALE_EPOCH,
        EPOCH,
        "fence:previous_owner_stopped",
        NOW + 2,
    )
    .expect("interrupt the replaced generation");
    assert_eq!(interrupted, 1);

    let retained = reservation::reservation(&conn, &target.key())
        .expect("read reservation")
        .expect("reservation exists");
    assert_eq!(retained.state, ReservationState::Interrupted);
    assert!(retained.released_at.is_none());
    assert_eq!(reservation::live_counts(&conn).expect("counts").host, 1);

    // Capacity only comes back with settlement evidence.
    let settled = transition(
        &conn,
        &target,
        ReservationState::Interrupted,
        ReservationState::Aborted,
        "settlement:owner_stopped_before_launch",
    )
    .expect("release the interrupted slot");
    assert!(settled.released_at.is_some());
    assert_eq!(reservation::live_counts(&conn).expect("counts").host, 0);
}

#[test]
fn native_children_each_take_their_own_slot() {
    let conn = database();
    create_workspace(&conn, WORKSPACE, "Alpha");
    seed_membership(&conn, PARENT_SESSION, WORKSPACE, 1);

    // The ten-child ceiling is a delegation-registry rule owned elsewhere;
    // every admitted child still consumes one command-workspace slot.
    for index in 0..10 {
        let child = child_execution(PARENT_TURN, &format!("del-chain-{index}"), 1);
        admit(&conn, WORKSPACE, &child, 1).expect("admit a child");
    }
    for session in [MAIN_SESSION, "sess-worker-2"] {
        seed_membership(&conn, session, WORKSPACE, 1);
        admit(&conn, WORKSPACE, &session_execution(session), 1).expect("admit a session");
    }
    assert_eq!(
        reservation::live_for_workspace(&conn, WORKSPACE).expect("count"),
        12
    );

    let extra_child = child_execution(PARENT_TURN, "del-chain-11", 1);
    let error = expect_error(
        admit(&conn, WORKSPACE, &extra_child, 1),
        "CC_QUOTA_EXCEEDED",
    );
    assert!(error.contains("12"), "{error}");
}
