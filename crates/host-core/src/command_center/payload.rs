//! Canonical payload bytes and the validated intervention shapes.
//!
//! The idempotency fingerprint is the SHA-256 of a deterministic JSON encoding
//! of the validated request. It must reproduce the frozen C1 shared function
//! `commandCenterCanonicalPayload` byte for byte: object keys sorted, arrays in
//! order, absent optional fields omitted. `fixture_tests` pins the two shared
//! golden vectors, so a change here that the TypeScript consumers would not
//! reproduce fails immediately.
//!
//! A request never carries its own principal or role. Authorization stays with
//! the authenticated transport state, outside this module.

use anyhow::{bail, Result};
use sha2::{Digest, Sha256};

use super::identity::ExecutionTarget;
use super::limits::{
    validate_boundary, validate_host_id, validate_intent_text, validate_revision, validate_uuid,
    MAX_CONSTRAINTS, MAX_CONSTRAINTS_JSON_BYTES, MAX_CONSTRAINT_CHARS, MAX_REQUEST_BYTES, VERSION,
};
use super::state::{Operation, StopScope};

/// Append one JSON string literal with the shared escaping rules.
///
/// `JSON.stringify` keeps non-ASCII code points as they are and escapes only
/// quotes, backslashes and C0 controls, which is what the shared canonicalizer
/// does before hashing.
pub(crate) fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

pub(crate) fn fingerprint_of(canonical: &str) -> String {
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

/// Canonical JSON array for the constraints column of a goal revision.
pub(crate) fn canonical_constraints(constraints: &[String]) -> Result<String> {
    let mut out = String::with_capacity(64);
    out.push('[');
    for (index, constraint) in constraints.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_json_string(&mut out, constraint);
    }
    out.push(']');
    if out.len() > MAX_CONSTRAINTS_JSON_BYTES {
        bail!(
            "CC_INVALID_REQUEST: constraints exceed {MAX_CONSTRAINTS_JSON_BYTES} canonical bytes"
        );
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Intervention intent
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum InterventionIntent {
    Append {
        text: String,
    },
    Steer {
        text: String,
    },
    ReviseGoal {
        objective: String,
        constraints: Vec<String>,
    },
    Stop {
        scope: StopScope,
    },
}

impl InterventionIntent {
    pub(crate) fn operation(&self) -> Operation {
        match self {
            Self::Append { .. } => Operation::Append,
            Self::Steer { .. } => Operation::Steer,
            Self::ReviseGoal { .. } => Operation::ReviseGoal,
            Self::Stop { .. } => Operation::Stop,
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        match self {
            Self::Append { text } | Self::Steer { text } => {
                validate_intent_text(text, "intent text", MAX_REQUEST_BYTES)
            }
            Self::ReviseGoal {
                objective,
                constraints,
            } => {
                validate_intent_text(objective, "objective", MAX_REQUEST_BYTES)?;
                if constraints.len() > MAX_CONSTRAINTS {
                    bail!("CC_INVALID_REQUEST: at most {MAX_CONSTRAINTS} constraints are accepted");
                }
                for constraint in constraints {
                    validate_intent_text(constraint, "constraint", MAX_CONSTRAINT_CHARS)?;
                }
                canonical_constraints(constraints)?;
                Ok(())
            }
            Self::Stop { .. } => Ok(()),
        }
    }

    /// Append the intent object with sorted keys. `reviseGoal` sorts
    /// `constraints` before `kind`, so the emission order is not the field
    /// declaration order.
    fn push_canonical(&self, out: &mut String) {
        out.push('{');
        match self {
            Self::Append { text } | Self::Steer { text } => {
                out.push_str("\"kind\":");
                push_json_string(out, self.operation().as_str());
                out.push_str(",\"text\":");
                push_json_string(out, text);
            }
            Self::ReviseGoal {
                objective,
                constraints,
            } => {
                out.push_str("\"constraints\":[");
                for (index, constraint) in constraints.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    push_json_string(out, constraint);
                }
                out.push_str("],\"kind\":\"reviseGoal\",\"objective\":");
                push_json_string(out, objective);
            }
            Self::Stop { scope } => {
                out.push_str("\"kind\":\"stop\",\"scope\":");
                push_json_string(out, scope.as_str());
            }
        }
        out.push('}');
    }
}

// ---------------------------------------------------------------------------
// Intervention request
// ---------------------------------------------------------------------------

/// One validated intervention attempt.
///
/// The principal is deliberately absent: it comes from authenticated transport
/// state and can never be supplied or widened by the payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InterventionRequest {
    pub(crate) version: u32,
    pub(crate) request_id: String,
    pub(crate) host_id: String,
    pub(crate) expected_host_epoch: String,
    pub(crate) command_workspace_id: String,
    pub(crate) expected_membership_revision: i64,
    /// Required for every non-stop intent and absent for Stop, so a goal
    /// revision that advanced never blocks cancellation.
    pub(crate) expected_goal_revision: Option<i64>,
    pub(crate) target: ExecutionTarget,
    pub(crate) intent: InterventionIntent,
}

impl InterventionRequest {
    pub(crate) fn operation(&self) -> Operation {
        self.intent.operation()
    }

    fn validate_shape(&self) -> Result<()> {
        if self.version != VERSION {
            bail!(
                "CC_INVALID_REQUEST: unsupported contract version {}",
                self.version
            );
        }
        validate_uuid(&self.request_id)?;
        validate_uuid(&self.expected_host_epoch)?;
        validate_uuid(&self.command_workspace_id)?;
        validate_host_id(&self.host_id)?;
        validate_revision(self.expected_membership_revision, 1)?;
        self.target.validate()?;
        self.intent.validate()?;
        match (self.operation(), self.expected_goal_revision) {
            (Operation::Stop, None) => Ok(()),
            (Operation::Stop, Some(_)) => {
                bail!("CC_INVALID_REQUEST: stop ignores the goal revision fence")
            }
            (_, Some(revision)) => validate_revision(revision, 0),
            (_, None) => bail!("CC_INVALID_REQUEST: expectedGoalRevision is required"),
        }
    }

    fn push_canonical(&self, out: &mut String) {
        out.push_str("{\"commandWorkspaceId\":");
        push_json_string(out, &self.command_workspace_id);
        if let Some(revision) = self.expected_goal_revision {
            out.push_str(",\"expectedGoalRevision\":");
            out.push_str(&revision.to_string());
        }
        out.push_str(",\"expectedHostEpoch\":");
        push_json_string(out, &self.expected_host_epoch);
        out.push_str(",\"expectedMembershipRevision\":");
        out.push_str(&self.expected_membership_revision.to_string());
        out.push_str(",\"hostId\":");
        push_json_string(out, &self.host_id);
        out.push_str(",\"intent\":");
        self.intent.push_canonical(out);
        out.push_str(",\"requestId\":");
        push_json_string(out, &self.request_id);
        out.push_str(",\"target\":");
        push_execution_target(out, &self.target);
        out.push_str(",\"version\":");
        out.push_str(&self.version.to_string());
        out.push('}');
    }

    pub(crate) fn canonical_json(&self) -> Result<String> {
        self.validate_shape()?;
        let mut out = String::with_capacity(512);
        self.push_canonical(&mut out);
        Ok(out)
    }

    /// Shape, size and intent validation. Authorization and target resolution
    /// stay with the Host; this proves only a bounded, unambiguous attempt.
    pub(crate) fn validate(&self) -> Result<()> {
        let canonical = self.canonical_json()?;
        if canonical.len() > MAX_REQUEST_BYTES {
            bail!("CC_PAYLOAD_TOO_LARGE: canonical payload exceeds {MAX_REQUEST_BYTES} bytes");
        }
        Ok(())
    }

    pub(crate) fn fingerprint(&self) -> Result<String> {
        Ok(fingerprint_of(&self.canonical_json()?))
    }
}

fn push_execution_target(out: &mut String, target: &ExecutionTarget) {
    out.push('{');
    match target {
        ExecutionTarget::Session {
            session_id,
            turn_id,
        } => {
            out.push_str("\"kind\":\"session\",\"sessionId\":");
            push_json_string(out, session_id);
            out.push_str(",\"turnId\":");
            push_json_string(out, turn_id);
        }
        ExecutionTarget::Delegation {
            parent_session_id,
            parent_turn_id,
            delegation_id,
            generation,
        } => {
            out.push_str("\"delegationId\":");
            push_json_string(out, delegation_id);
            out.push_str(",\"executionGeneration\":");
            out.push_str(&generation.to_string());
            out.push_str(",\"kind\":\"delegation\",\"parentSessionId\":");
            push_json_string(out, parent_session_id);
            out.push_str(",\"parentTurnId\":");
            push_json_string(out, parent_turn_id);
        }
    }
    out.push('}');
}

// ---------------------------------------------------------------------------
// Runtime consumption acknowledgement
// ---------------------------------------------------------------------------

/// Runtime acknowledgement that one concrete execution consumed a revision at
/// a supported scheduling boundary.
///
/// `agent.steer` returning `{ accepted: true }` is not this acknowledgement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Consumption {
    pub(crate) request_id: String,
    pub(crate) target: ExecutionTarget,
    pub(crate) consumed_revision: i64,
    pub(crate) boundary: String,
}

impl Consumption {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_uuid(&self.request_id)?;
        self.target.validate()?;
        validate_revision(self.consumed_revision, 1)?;
        validate_boundary(&self.boundary)
    }
}
