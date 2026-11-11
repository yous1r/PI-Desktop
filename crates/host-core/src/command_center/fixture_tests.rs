//! Conformance against the frozen cross-language contract fixture.
//!
//! `packages/shared/test/fixtures/command-center-control.json` is produced by the
//! shared TypeScript package and is the one artefact both languages agree on.
//! Every vector below is read from that file instead of being restated in Rust,
//! so a divergence in canonical encoding, fingerprint, status vocabulary or
//! revision numbering fails here rather than at an RPC boundary.
//!
//! The fixture is consumed, never edited: a mismatch means this module is wrong.

use anyhow::{bail, Result};
use serde_json::Value;

use super::goal;
use super::identity::{
    parse_execution_key, parse_task_key, validate_execution_key, validate_task_key,
    ExecutionTarget, TaskTarget,
};
use super::limits::{self, ReceiptError};
use super::payload::{Consumption, InterventionIntent, InterventionRequest};
use super::receipt::{self, Receipt, ReceiptTransition};
use super::state::{Operation, ReceiptStatus, StopScope};
use super::tests::{
    database, expect_error, fixture_execution, fixture_request, fixture_scene, fixture_stop,
    fixture_task, goal_revision_count, receipt_count, HOST_ID, NOW, PRINCIPAL,
};

const FIXTURE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/shared/test/fixtures/command-center-control.json"
);

fn fixture() -> Value {
    let raw = std::fs::read_to_string(FIXTURE_PATH).unwrap_or_else(|error| {
        panic!("the frozen control fixture {FIXTURE_PATH} must be readable: {error}")
    });
    serde_json::from_str(&raw).expect("the frozen control fixture must be valid JSON")
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("fixture field {key} must be a string in {value}"))
        .to_owned()
}

fn number(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or_else(|| panic!("fixture field {key} must be an integer in {value}"))
}

fn execution_target(value: &Value) -> ExecutionTarget {
    match text(value, "kind").as_str() {
        "session" => ExecutionTarget::session(&text(value, "sessionId"), &text(value, "turnId")),
        "delegation" => ExecutionTarget::delegation(
            &text(value, "parentSessionId"),
            &text(value, "parentTurnId"),
            &text(value, "delegationId"),
            number(value, "executionGeneration"),
        ),
        other => panic!("fixture target kind {other} is not a concrete execution"),
    }
}

fn task_target(value: &Value) -> TaskTarget {
    match text(value, "kind").as_str() {
        "session" => TaskTarget::session(&text(value, "sessionId")),
        "delegation" => TaskTarget::delegation(
            &text(value, "parentSessionId"),
            &text(value, "delegationId"),
        ),
        other => panic!("fixture task kind {other} is not a goal-bearing target"),
    }
}

fn request_of(value: &Value) -> Result<InterventionRequest> {
    let intent = value
        .get("intent")
        .unwrap_or_else(|| panic!("fixture request must carry an intent: {value}"));
    let operation = text(intent, "kind");
    let intent = match operation.as_str() {
        "append" => InterventionIntent::Append {
            text: text(intent, "text"),
        },
        "steer" => InterventionIntent::Steer {
            text: text(intent, "text"),
        },
        "reviseGoal" => InterventionIntent::ReviseGoal {
            objective: text(intent, "objective"),
            constraints: intent
                .get("constraints")
                .and_then(Value::as_array)
                .unwrap_or_else(|| panic!("reviseGoal needs constraints: {intent}"))
                .iter()
                .map(|constraint| {
                    constraint
                        .as_str()
                        .expect("fixture constraints must be strings")
                        .to_owned()
                })
                .collect(),
        },
        "stop" => InterventionIntent::Stop {
            scope: StopScope::parse(&text(intent, "scope"))?,
        },
        other => bail!("fixture intent {other} is not a control operation"),
    };
    Ok(InterventionRequest {
        version: u32::try_from(number(value, "version")).expect("fixture version must fit u32"),
        request_id: text(value, "requestId"),
        host_id: text(value, "hostId"),
        expected_host_epoch: text(value, "expectedHostEpoch"),
        command_workspace_id: text(value, "commandWorkspaceId"),
        expected_membership_revision: number(value, "expectedMembershipRevision"),
        expected_goal_revision: value
            .get("expectedGoalRevision")
            .map(|_| number(value, "expectedGoalRevision")),
        target: execution_target(
            value
                .get("target")
                .unwrap_or_else(|| panic!("fixture request must name a target: {value}")),
        ),
        intent,
    })
}

fn consumption_of(value: &Value) -> Result<Consumption> {
    Ok(Consumption {
        request_id: text(value, "requestId"),
        target: execution_target(
            value
                .get("target")
                .unwrap_or_else(|| panic!("consumption must name a target: {value}")),
        ),
        consumed_revision: number(value, "consumedRevision"),
        boundary: text(value, "boundary"),
    })
}

/// Compare one stored receipt with a fixture projection of the same row.
fn assert_receipt_matches(actual: &Receipt, expected: &Value) {
    let status = text(expected, "status");
    assert_eq!(
        ReceiptStatus::parse(&status)
            .expect("every fixture status must be in the shared vocabulary")
            .as_str(),
        status.as_str()
    );
    let operation = text(expected, "operation");
    assert_eq!(
        Operation::parse(&operation)
            .expect("every fixture operation must be in the shared vocabulary")
            .as_str(),
        operation.as_str()
    );
    assert_eq!(actual.request_id, text(expected, "requestId"));
    assert_eq!(actual.fingerprint, text(expected, "fingerprint"));
    assert_eq!(actual.operation.as_str(), operation.as_str());
    assert_eq!(actual.status.as_str(), status.as_str());
    assert_eq!(actual.revision, number(expected, "revision"));
    assert_eq!(
        actual.desired_revision,
        number(expected, "desiredGoalRevision")
    );
    assert_eq!(
        actual.effective_revision,
        number(expected, "effectiveGoalRevision")
    );
    assert_eq!(
        actual.target.key(),
        execution_target(&expected["target"]).key()
    );
    assert!(
        actual.created_at <= actual.updated_at,
        "a receipt may never be updated before it was created"
    );
}

#[test]
fn fixture_version_and_capabilities_are_the_unadvertised_contract() {
    let fixture = fixture();
    assert_eq!(
        number(&fixture, "version"),
        i64::from(limits::VERSION),
        "Rust and the shared fixture disagree on the contract version"
    );
    let advertised = fixture["capabilities"]["advertised"]
        .as_object()
        .expect("capabilities.advertised must be an object");
    assert!(
        advertised.is_empty(),
        "storage must not advertise a capability it cannot execute: {advertised:?}"
    );
}

#[test]
fn revise_goal_request_reproduces_the_golden_canonical_payload() -> Result<()> {
    let fixture = fixture();
    let request = request_of(&fixture["request"])?;
    request.validate()?;
    assert_eq!(request.operation(), Operation::ReviseGoal);
    assert_eq!(request.expected_goal_revision, Some(4));
    assert_eq!(
        request.canonical_json()?,
        text(&fixture, "canonicalPayload"),
        "the Rust canonical encoder must reproduce the shared golden bytes"
    );
    assert_eq!(
        request.fingerprint()?,
        text(&fixture, "fingerprint"),
        "the idempotency key is the golden fingerprint"
    );
    assert_eq!(
        execution_target(&fixture["targets"]["execution"]),
        request.target
    );
    // The shared harness used by every other test must be this exact vector.
    assert_eq!(request.target, fixture_execution());
    assert_eq!(request, fixture_request());
    Ok(())
}

#[test]
fn stop_request_reproduces_the_golden_canonical_payload() -> Result<()> {
    let fixture = fixture();
    let request = request_of(&fixture["stopRequest"])?;
    request.validate()?;
    assert_eq!(request.operation(), Operation::Stop);
    assert_eq!(
        request.expected_goal_revision, None,
        "Stop must not carry a goal fence, or an advanced goal would block cancellation"
    );
    assert_eq!(
        request.canonical_json()?,
        text(&fixture, "stopCanonicalPayload")
    );
    assert_eq!(request.fingerprint()?, text(&fixture, "stopFingerprint"));
    assert_eq!(
        request.target,
        fixture_execution(),
        "Stop addresses the same concrete execution, including the generation"
    );
    assert_eq!(request, fixture_stop());
    Ok(())
}

#[test]
fn a_replaced_execution_is_a_different_target() {
    let fixture = fixture();
    let live = execution_target(&fixture["targets"]["execution"]);
    let replacement = execution_target(&fixture["targets"]["replacementExecution"]);
    assert_eq!(
        number(&fixture["targets"]["execution"], "executionGeneration"),
        2
    );
    assert_eq!(
        number(
            &fixture["targets"]["replacementExecution"],
            "executionGeneration"
        ),
        3
    );
    assert_ne!(
        live.key(),
        replacement.key(),
        "a replacement run must not be reachable through the old identity"
    );
    let session = execution_target(&fixture["targets"]["sessionExecution"]);
    assert!(matches!(session, ExecutionTarget::Session { .. }));
    assert_ne!(session.key(), live.key());
}

#[test]
fn consumption_acknowledgement_matches_the_fixture() -> Result<()> {
    let fixture = fixture();
    let request = request_of(&fixture["request"])?;
    let consumption = consumption_of(&fixture["consumption"])?;
    consumption.validate()?;
    assert_eq!(consumption.request_id, request.request_id);
    assert_eq!(
        consumption.target, request.target,
        "an acknowledgement must name the receipt's own execution"
    );
    assert_eq!(consumption.consumed_revision, 5);
    assert_eq!(consumption.boundary, "model_step");
    limits::validate_boundary(&consumption.boundary)?;
    // The boundary vocabulary is shared, so a look-alike spelling is rejected.
    expect_error(
        limits::validate_boundary("Model_Step"),
        "CC_INVALID_CONSUMPTION",
    );

    // A goal head is a task, not an execution: it drops the turn and generation
    // so a replacement run inherits the committed goal.
    let head = &fixture["goalHead"];
    assert_eq!(number(head, "desiredRevision"), 5);
    assert_eq!(
        number(head, "effectiveRevision"),
        4,
        "desired acceptance is not effective until a runtime consumes it"
    );
    assert_eq!(task_target(&head["target"]), fixture_task());
    assert_eq!(task_target(&head["target"]), request.target.task());
    Ok(())
}

#[test]
fn recorded_accepted_consumed_and_completed_match_the_fixture_vectors() -> Result<()> {
    let fixture = fixture();
    let request = request_of(&fixture["request"])?;
    let conn = database();
    fixture_scene(&conn);

    let recorded = receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &request, NOW)?;
    assert!(!recorded.replayed, "first filing is not a replay");
    assert_receipt_matches(&recorded.receipt, &fixture["receipt"]);
    assert!(recorded.receipt.error.is_none());

    let accepted = receipt::transition_receipt(
        &conn,
        &ReceiptTransition {
            sequence: recorded.receipt.sequence,
            expected_revision: recorded.receipt.revision,
            to: ReceiptStatus::Accepted,
            error: None,
            now: NOW + 1,
        },
    )?;
    assert_receipt_matches(&accepted, &fixture["receipts"]["accepted"]);
    assert!(accepted.awaits_consumption());

    // `consumed` is not a status write: only a concrete runtime
    // acknowledgement for this exact execution may advance effective.
    let head = goal::acknowledge_consumption(
        &conn,
        HOST_ID,
        PRINCIPAL,
        &consumption_of(&fixture["consumption"])?,
        NOW + 2,
    )?;
    assert_eq!((head.desired_revision, head.effective_revision), (5, 5));
    let consumed = receipt::receipt_by_sequence(&conn, recorded.receipt.sequence)?
        .expect("receipts are retained");
    assert_receipt_matches(&consumed, &fixture["receipts"]["consumed"]);
    assert!(!consumed.awaits_consumption());

    let completed = receipt::transition_receipt(
        &conn,
        &ReceiptTransition {
            sequence: recorded.receipt.sequence,
            expected_revision: consumed.revision,
            to: ReceiptStatus::Completed,
            error: None,
            now: NOW + 3,
        },
    )?;
    assert_receipt_matches(&completed, &fixture["receipts"]["completed"]);
    assert_eq!(
        receipt_count(&conn),
        1,
        "completion never deletes the receipt"
    );
    Ok(())
}

#[test]
fn conflicted_receipt_matches_the_fixture_error_vector() -> Result<()> {
    let fixture = fixture();
    let request = request_of(&fixture["request"])?;
    let conn = database();
    fixture_scene(&conn);
    let recorded = receipt::record_intervention(&conn, HOST_ID, PRINCIPAL, &request, NOW)?;

    let vector = &fixture["receipts"]["conflicted"];
    let evidence = &vector["error"];
    let conflicted = receipt::transition_receipt(
        &conn,
        &ReceiptTransition {
            sequence: recorded.receipt.sequence,
            expected_revision: recorded.receipt.revision,
            to: ReceiptStatus::Conflicted,
            error: Some(ReceiptError::new(
                &text(evidence, "code"),
                &text(evidence, "message"),
            )?),
            now: NOW + 1,
        },
    )?;
    assert_receipt_matches(&conflicted, vector);
    let stored = conflicted.error.clone().expect("conflicts carry evidence");
    assert_eq!(stored.code, "CONFLICT");
    assert_eq!(stored.message, "host epoch changed before dispatch");

    // A conflict is the absence of an effect: desired advanced, effective did not.
    let head = goal::goal_head(&conn, &fixture_task())?.expect("goal head");
    assert_eq!((head.desired_revision, head.effective_revision), (5, 4));
    Ok(())
}

#[test]
fn stop_receipt_matches_the_fixture_vector_and_never_moves_the_goal() -> Result<()> {
    let fixture = fixture();
    let conn = database();
    fixture_scene(&conn);
    let revisions_before = goal_revision_count(&conn);
    receipt::record_intervention(
        &conn,
        HOST_ID,
        PRINCIPAL,
        &request_of(&fixture["request"])?,
        NOW,
    )?;
    assert_eq!(goal_revision_count(&conn), revisions_before + 1);

    // The fixture's Stop vector is filed after the goal commit, so the receipt
    // reports the advanced desired revision while effective stays behind.
    let recorded = receipt::record_intervention(
        &conn,
        HOST_ID,
        PRINCIPAL,
        &request_of(&fixture["stopRequest"])?,
        NOW + 1,
    )?;
    assert_eq!(recorded.receipt.operation, Operation::Stop);
    assert_eq!(recorded.receipt.status, ReceiptStatus::Recorded);
    assert_eq!(
        (
            recorded.receipt.desired_revision,
            recorded.receipt.effective_revision
        ),
        (5, 4)
    );
    assert!(
        !recorded.receipt.awaits_consumption(),
        "Stop never becomes consumed"
    );
    assert_eq!(
        goal_revision_count(&conn),
        revisions_before + 1,
        "cancellation must not commit a goal revision"
    );

    let accepted = receipt::transition_receipt(
        &conn,
        &ReceiptTransition {
            sequence: recorded.receipt.sequence,
            expected_revision: recorded.receipt.revision,
            to: ReceiptStatus::Accepted,
            error: None,
            now: NOW + 2,
        },
    )?;
    assert_receipt_matches(&accepted, &fixture["stopReceipt"]);
    assert!(accepted.error.is_none());
    let head = goal::goal_head(&conn, &fixture_task())?.expect("goal head");
    assert_eq!((head.desired_revision, head.effective_revision), (5, 4));
    assert_eq!(receipt_count(&conn), 2, "both receipts are retained");
    Ok(())
}

// ---------------------------------------------------------------------------
// Identity fixture
// ---------------------------------------------------------------------------

/// `command-center-identities.json` pins the tuple keys the shared encoder
/// produces. It exists because delimiter-joined identity aliased distinct
/// opaque identifiers, so this file is consumed rather than restated.
const IDENTITY_FIXTURE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/shared/test/fixtures/command-center-identities.json"
);

fn identity_fixture() -> Value {
    let raw = std::fs::read_to_string(IDENTITY_FIXTURE_PATH).unwrap_or_else(|error| {
        panic!("the frozen identity fixture {IDENTITY_FIXTURE_PATH} must be readable: {error}")
    });
    serde_json::from_str(&raw).expect("the frozen identity fixture must be valid JSON")
}

fn vectors<'a>(fixture: &'a Value, field: &str, expected: usize) -> &'a Vec<Value> {
    let vectors = fixture
        .get(field)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("identity fixture field {field} must be an array"));
    assert_eq!(
        vectors.len(),
        expected,
        "the shared identity fixture changed its {field} vectors"
    );
    vectors
}

#[test]
fn identity_fixture_pins_the_shared_tuple_encodings() -> Result<()> {
    let fixture = identity_fixture();
    assert_eq!(number(&fixture, "version"), i64::from(limits::VERSION));

    let mut seen = std::collections::BTreeSet::new();
    for vector in vectors(&fixture, "tasks", 3) {
        let target = task_target(&vector["target"]);
        let key = text(vector, "key");
        assert_eq!(
            target.key(),
            key,
            "a Rust task key must be the shared tuple, not the same words joined"
        );
        assert_eq!(
            parse_task_key(&key)?,
            target,
            "the key must rebuild its owner"
        );
        validate_task_key(&key)?;
        assert!(seen.insert(key), "task keys must stay distinct");
    }

    let mut seen = std::collections::BTreeSet::new();
    for vector in vectors(&fixture, "executions", 4) {
        let target = execution_target(&vector["target"]);
        let key = text(vector, "key");
        assert_eq!(
            target.key(),
            key,
            "a Rust execution key must be the shared tuple"
        );
        assert_eq!(
            parse_execution_key(&key)?,
            target,
            "the key must rebuild its execution, including turn and generation"
        );
        validate_execution_key(&key)?;
        assert!(seen.insert(key), "execution keys must stay distinct");
    }
    Ok(())
}
