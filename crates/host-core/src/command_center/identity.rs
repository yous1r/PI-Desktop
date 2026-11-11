//! Task and execution identity.
//!
//! The two levels are deliberately different values. A stable task target names
//! the goal owner and survives settlements and continuations; a concrete
//! execution target adds the live turn or the native execution generation, so a
//! delayed control aimed at a replaced run cannot match the new one.
//!
//! Both levels encode as JSON tuples, the same encoding the shared contract
//! exports. A delimiter join aliased distinct opaque identifiers, so the tuple
//! is part of the contract rather than a storage detail.

use anyhow::{bail, Result};
use serde_json::Value;

use super::limits::{
    validate_canonical_id, validate_revision, MAX_CANONICAL_ID_CHARS, MAX_REVISION,
};
use super::payload::push_json_string;

/// Stable goal owner: a canonical session, or the canonical delegation-chain
/// root (parent session plus chain identity). It carries no live turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TaskTarget {
    Session {
        session_id: String,
    },
    Delegation {
        parent_session_id: String,
        delegation_id: String,
    },
}

impl TaskTarget {
    pub(crate) fn session(session_id: &str) -> Self {
        Self::Session {
            session_id: session_id.to_owned(),
        }
    }

    pub(crate) fn delegation(parent_session_id: &str, delegation_id: &str) -> Self {
        Self::Delegation {
            parent_session_id: parent_session_id.to_owned(),
            delegation_id: delegation_id.to_owned(),
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        match self {
            Self::Session { session_id } => validate_canonical_id(session_id, "sessionId"),
            Self::Delegation {
                parent_session_id,
                delegation_id,
            } => {
                validate_canonical_id(parent_session_id, "parentSessionId")?;
                validate_canonical_id(delegation_id, "delegationId")
            }
        }
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Session { .. } => "session",
            Self::Delegation { .. } => "delegation",
        }
    }

    /// Stable goal-owner key: ignores turn and native generation.
    ///
    /// The encoding is the shared JSON tuple from `commandCenterTaskKey`, not a
    /// delimiter join: canonical identifiers may contain any non-NUL character,
    /// so only an explicit tuple keeps component boundaries unambiguous.
    pub(crate) fn key(&self) -> String {
        let mut key = String::with_capacity(64);
        key.push('[');
        match self {
            Self::Session { session_id } => {
                key.push_str("\"session\",");
                push_json_string(&mut key, session_id);
            }
            Self::Delegation {
                parent_session_id,
                delegation_id,
            } => {
                key.push_str("\"delegation\",");
                push_json_string(&mut key, parent_session_id);
                key.push(',');
                push_json_string(&mut key, delegation_id);
            }
        }
        key.push(']');
        key
    }

    /// Session whose workspace membership governs this task.
    pub(crate) fn membership_session(&self) -> &str {
        match self {
            Self::Session { session_id } => session_id,
            Self::Delegation {
                parent_session_id, ..
            } => parent_session_id,
        }
    }

    pub(crate) fn session_id(&self) -> Option<&str> {
        match self {
            Self::Session { session_id } => Some(session_id),
            Self::Delegation { .. } => None,
        }
    }

    pub(crate) fn parent_session_id(&self) -> Option<&str> {
        match self {
            Self::Session { .. } => None,
            Self::Delegation {
                parent_session_id, ..
            } => Some(parent_session_id),
        }
    }

    pub(crate) fn delegation_id(&self) -> Option<&str> {
        match self {
            Self::Session { .. } => None,
            Self::Delegation { delegation_id, .. } => Some(delegation_id),
        }
    }

    /// Rebuild a task from stored columns, rejecting an inconsistent row.
    pub(crate) fn from_parts(
        kind: &str,
        session_id: Option<&str>,
        parent_session_id: Option<&str>,
        delegation_id: Option<&str>,
    ) -> Result<Self> {
        match (kind, session_id, parent_session_id, delegation_id) {
            ("session", Some(session_id), None, None) => Ok(Self::session(session_id)),
            ("delegation", None, Some(parent_session_id), Some(delegation_id)) => {
                Ok(Self::delegation(parent_session_id, delegation_id))
            }
            _ => bail!("CC_CORRUPT_STORAGE: task target columns disagree with {kind}"),
        }
    }
}

/// Concrete live execution. Main and Worker runs reuse their real session and
/// turn identity; a native child adds the parent turn, the delegation identity
/// and the concrete execution generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ExecutionTarget {
    Session {
        session_id: String,
        turn_id: String,
    },
    Delegation {
        parent_session_id: String,
        parent_turn_id: String,
        delegation_id: String,
        generation: i64,
    },
}

impl ExecutionTarget {
    pub(crate) fn session(session_id: &str, turn_id: &str) -> Self {
        Self::Session {
            session_id: session_id.to_owned(),
            turn_id: turn_id.to_owned(),
        }
    }

    pub(crate) fn delegation(
        parent_session_id: &str,
        parent_turn_id: &str,
        delegation_id: &str,
        generation: i64,
    ) -> Self {
        Self::Delegation {
            parent_session_id: parent_session_id.to_owned(),
            parent_turn_id: parent_turn_id.to_owned(),
            delegation_id: delegation_id.to_owned(),
            generation,
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        match self {
            Self::Session {
                session_id,
                turn_id,
            } => {
                validate_canonical_id(session_id, "sessionId")?;
                validate_canonical_id(turn_id, "turnId")
            }
            Self::Delegation {
                parent_session_id,
                parent_turn_id,
                delegation_id,
                generation,
            } => {
                validate_canonical_id(parent_session_id, "parentSessionId")?;
                validate_canonical_id(parent_turn_id, "parentTurnId")?;
                validate_canonical_id(delegation_id, "delegationId")?;
                validate_revision(*generation, 1)
            }
        }
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Session { .. } => "session",
            Self::Delegation { .. } => "delegation",
        }
    }

    /// Concrete execution key: includes turn and native generation.
    ///
    /// Same shared JSON tuple encoding as the task key, plus the components
    /// that distinguish one run from its replacement.
    pub(crate) fn key(&self) -> String {
        let mut key = String::with_capacity(96);
        key.push('[');
        match self {
            Self::Session {
                session_id,
                turn_id,
            } => {
                key.push_str("\"session\",");
                push_json_string(&mut key, session_id);
                key.push(',');
                push_json_string(&mut key, turn_id);
            }
            Self::Delegation {
                parent_session_id,
                parent_turn_id,
                delegation_id,
                generation,
            } => {
                key.push_str("\"delegation\",");
                push_json_string(&mut key, parent_session_id);
                key.push(',');
                push_json_string(&mut key, parent_turn_id);
                key.push(',');
                push_json_string(&mut key, delegation_id);
                key.push(',');
                key.push_str(&generation.to_string());
            }
        }
        key.push(']');
        key
    }

    pub(crate) fn task(&self) -> TaskTarget {
        match self {
            Self::Session { session_id, .. } => TaskTarget::session(session_id),
            Self::Delegation {
                parent_session_id,
                delegation_id,
                ..
            } => TaskTarget::delegation(parent_session_id, delegation_id),
        }
    }

    pub(crate) fn membership_session(&self) -> &str {
        match self {
            Self::Session { session_id, .. } => session_id,
            Self::Delegation {
                parent_session_id, ..
            } => parent_session_id,
        }
    }

    pub(crate) fn session_id(&self) -> Option<&str> {
        match self {
            Self::Session { session_id, .. } => Some(session_id),
            Self::Delegation { .. } => None,
        }
    }

    pub(crate) fn turn_id(&self) -> Option<&str> {
        match self {
            Self::Session { turn_id, .. } => Some(turn_id),
            Self::Delegation { .. } => None,
        }
    }

    pub(crate) fn parent_session_id(&self) -> Option<&str> {
        match self {
            Self::Session { .. } => None,
            Self::Delegation {
                parent_session_id, ..
            } => Some(parent_session_id),
        }
    }

    pub(crate) fn parent_turn_id(&self) -> Option<&str> {
        match self {
            Self::Session { .. } => None,
            Self::Delegation { parent_turn_id, .. } => Some(parent_turn_id),
        }
    }

    pub(crate) fn delegation_id(&self) -> Option<&str> {
        match self {
            Self::Session { .. } => None,
            Self::Delegation { delegation_id, .. } => Some(delegation_id),
        }
    }

    pub(crate) fn generation(&self) -> Option<i64> {
        match self {
            Self::Session { .. } => None,
            Self::Delegation { generation, .. } => Some(*generation),
        }
    }

    /// True only when the concrete execution addresses the same stable owner.
    /// A resumed child keeps its owner but changes its execution key.
    pub(crate) fn belongs_to(&self, task: &TaskTarget) -> bool {
        self.task() == *task
    }

    /// Rebuild an execution target from stored columns.
    pub(crate) fn from_parts(
        kind: &str,
        session_id: Option<&str>,
        turn_id: Option<&str>,
        parent_session_id: Option<&str>,
        parent_turn_id: Option<&str>,
        delegation_id: Option<&str>,
        generation: Option<i64>,
    ) -> Result<Self> {
        match (
            kind,
            session_id,
            turn_id,
            parent_session_id,
            parent_turn_id,
            delegation_id,
        ) {
            ("session", Some(session_id), Some(turn_id), None, None, None) => {
                Ok(Self::session(session_id, turn_id))
            }
            (
                "delegation",
                None,
                None,
                Some(parent_session_id),
                Some(parent_turn_id),
                Some(delegation_id),
            ) => {
                let generation = generation.ok_or_else(|| {
                    anyhow::anyhow!("CC_CORRUPT_STORAGE: delegation execution without generation")
                })?;
                Ok(Self::delegation(
                    parent_session_id,
                    parent_turn_id,
                    delegation_id,
                    generation,
                ))
            }
            _ => bail!("CC_CORRUPT_STORAGE: execution target columns disagree with {kind}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Canonical tuple keys
// ---------------------------------------------------------------------------

/// Worst-case JSON escape expansion of one canonical identifier: a C0 control
/// character becomes `\u00XX`, so a component can grow sixfold.
const MAX_ESCAPED_ID_CHARS: usize = MAX_CANONICAL_ID_CHARS * 6;
/// Widest decimal rendering of a generation, which is bounded by
/// [`super::limits::MAX_REVISION`].
const MAX_GENERATION_DIGITS: usize = 16;

/// Longest canonical task key: `["delegation","<id>","<id>"]`.
///
/// Derived from the component bound rather than guessed: a key measured against
/// the identifier limit alone would reject valid long composites.
pub(crate) const MAX_TASK_KEY_CHARS: usize =
    "[\"delegation\",".len() + (2 + MAX_ESCAPED_ID_CHARS) + 1 + (2 + MAX_ESCAPED_ID_CHARS) + 1;

/// Longest canonical execution key:
/// `["delegation","<id>","<id>","<id>",<generation>]`.
pub(crate) const MAX_EXECUTION_KEY_CHARS: usize = "[\"delegation\",".len()
    + (2 + MAX_ESCAPED_ID_CHARS)
    + 1
    + (2 + MAX_ESCAPED_ID_CHARS)
    + 1
    + (2 + MAX_ESCAPED_ID_CHARS)
    + 1
    + MAX_GENERATION_DIGITS
    + 1;

/// Read one key as a JSON array, rejecting anything longer than the derived
/// bound before it is decoded.
fn tuple(key: &str, max_chars: usize, label: &str) -> Result<Vec<Value>> {
    if key.chars().count() > max_chars {
        bail!("CC_INVALID_IDENTITY: {label} exceeds {max_chars} characters");
    }
    match serde_json::from_str::<Value>(key) {
        Ok(Value::Array(items)) => Ok(items),
        _ => bail!("CC_INVALID_IDENTITY: {label} is not a JSON tuple"),
    }
}

fn tuple_string(items: &[Value], index: usize, label: &str, id_label: &str) -> Result<String> {
    let text = items.get(index).and_then(Value::as_str).ok_or_else(|| {
        anyhow::anyhow!("CC_INVALID_IDENTITY: {label} position {index} must be a string")
    })?;
    validate_canonical_id(text, id_label)?;
    Ok(text.to_owned())
}

fn tuple_generation(items: &[Value], index: usize, label: &str) -> Result<i64> {
    let generation = items.get(index).and_then(Value::as_i64).ok_or_else(|| {
        anyhow::anyhow!("CC_INVALID_IDENTITY: {label} position {index} must be an integer")
    })?;
    if generation < 1 || generation > MAX_REVISION {
        bail!("CC_INVALID_IDENTITY: {label} execution generation is out of range");
    }
    Ok(generation)
}

/// Rebuild a stable goal owner from its canonical key.
///
/// The tuple must be exactly what [`TaskTarget::key`] produces: arity, kind,
/// component positions and the canonical JSON encoding are all checked, so a
/// malformed, aliased or merely look-alike key cannot address a goal.
pub(crate) fn parse_task_key(key: &str) -> Result<TaskTarget> {
    const LABEL: &str = "taskKey";
    let items = tuple(key, MAX_TASK_KEY_CHARS, LABEL)?;
    let target = match (items.first().and_then(Value::as_str), items.len()) {
        (Some("session"), 2) => TaskTarget::session(&tuple_string(&items, 1, LABEL, "sessionId")?),
        (Some("delegation"), 3) => TaskTarget::delegation(
            &tuple_string(&items, 1, LABEL, "parentSessionId")?,
            &tuple_string(&items, 2, LABEL, "delegationId")?,
        ),
        _ => bail!(
            "CC_INVALID_IDENTITY: taskKey must be [\"session\", sessionId] or \
             [\"delegation\", parentSessionId, delegationId]"
        ),
    };
    if target.key() != key {
        bail!("CC_INVALID_IDENTITY: taskKey is not the canonical tuple encoding");
    }
    Ok(target)
}

/// Fail closed on a value that does not name exactly one stable goal owner.
pub(crate) fn validate_task_key(key: &str) -> Result<()> {
    parse_task_key(key).map(|_| ())
}

/// Rebuild a concrete execution from its canonical key.
///
/// A key for a different turn or native generation is a different execution, so
/// a delayed control that arrives after a replacement cannot be folded back.
pub(crate) fn parse_execution_key(key: &str) -> Result<ExecutionTarget> {
    const LABEL: &str = "executionKey";
    let items = tuple(key, MAX_EXECUTION_KEY_CHARS, LABEL)?;
    let target = match (items.first().and_then(Value::as_str), items.len()) {
        (Some("session"), 3) => ExecutionTarget::session(
            &tuple_string(&items, 1, LABEL, "sessionId")?,
            &tuple_string(&items, 2, LABEL, "turnId")?,
        ),
        (Some("delegation"), 5) => ExecutionTarget::delegation(
            &tuple_string(&items, 1, LABEL, "parentSessionId")?,
            &tuple_string(&items, 2, LABEL, "parentTurnId")?,
            &tuple_string(&items, 3, LABEL, "delegationId")?,
            tuple_generation(&items, 4, LABEL)?,
        ),
        _ => bail!(
            "CC_INVALID_IDENTITY: executionKey must be [\"session\", sessionId, turnId] or \
             [\"delegation\", parentSessionId, parentTurnId, delegationId, executionGeneration]"
        ),
    };
    if target.key() != key {
        bail!("CC_INVALID_IDENTITY: executionKey is not the canonical tuple encoding");
    }
    Ok(target)
}

/// Fail closed on a value that does not name exactly one concrete execution.
pub(crate) fn validate_execution_key(key: &str) -> Result<()> {
    parse_execution_key(key).map(|_| ())
}
