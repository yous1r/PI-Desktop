//! Versioned bounds and validators shared by every command-center module.
//!
//! The numbers mirror the frozen C1 contract
//! (`packages/shared/src/command-center/primitives.ts`), so a Rust admission,
//! receipt or goal transaction cannot accept a value the shared consumers would
//! reject. Each failure carries an internal machine code that the C3 adapter
//! maps onto an already registered wire error family.

use anyhow::{bail, Result};

/// Contract version. An incompatible wire change needs a new literal here and
/// in the shared schema set.
pub(crate) const VERSION: u32 = 1;

/// Enabled operational groups per Host (first release).
pub(crate) const MAX_ENABLED_WORKSPACES: i64 = 3;
/// Live Agent slots per command workspace.
pub(crate) const MAX_LIVE_PER_WORKSPACE: i64 = 12;
/// Live Agent slots per Host, shared by every client and admission source.
pub(crate) const MAX_LIVE_PER_HOST: i64 = 36;
/// Saved operational groups, matching the shared list bound.
pub(crate) const MAX_WORKSPACES: i64 = 100;
/// Largest revision or count representable by the shared contract.
pub(crate) const MAX_REVISION: i64 = 9_007_199_254_740_991;
/// Byte cap for one canonical intervention payload.
pub(crate) const MAX_REQUEST_BYTES: usize = 256 * 1024;
/// Byte cap for one stored constraints array.
pub(crate) const MAX_CONSTRAINTS_JSON_BYTES: usize = 4 * 1024;
/// Bounded page for durable receipt and notification reads.
pub(crate) const PAGE_SIZE: i64 = 100;
pub(crate) const MAX_LABEL_CHARS: usize = 256;
pub(crate) const MAX_CANONICAL_ID_CHARS: usize = 128;
pub(crate) const MAX_HOST_ID_CHARS: usize = 128;
pub(crate) const MAX_PRINCIPAL_CHARS: usize = 256;
pub(crate) const MAX_CONSTRAINTS: usize = 16;
pub(crate) const MAX_CONSTRAINT_CHARS: usize = 1_024;
pub(crate) const MAX_ERROR_CODE_CHARS: usize = 64;
pub(crate) const MAX_ERROR_MESSAGE_CHARS: usize = 512;
pub(crate) const MAX_EVIDENCE_CHARS: usize = 128;
pub(crate) const MAX_BOUNDARY_CHARS: usize = 64;

pub(crate) fn validate_uuid(value: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| anyhow::anyhow!("CC_INVALID_IDENTITY: not a canonical UUID"))?;
    if parsed.is_nil() || parsed.to_string() != value {
        bail!("CC_INVALID_IDENTITY: not a canonical non-nil UUID");
    }
    Ok(())
}

/// Opaque existing identifier (session, turn or delegation) resolved by Host
/// registries; the contract must not impose a new format on durable records.
pub(crate) fn validate_canonical_id(value: &str, label: &str) -> Result<()> {
    if value.is_empty() || value.contains('\0') {
        bail!("CC_INVALID_IDENTITY: {label} must be non-empty and NUL-free");
    }
    if value.chars().count() > MAX_CANONICAL_ID_CHARS {
        bail!("CC_INVALID_IDENTITY: {label} exceeds {MAX_CANONICAL_ID_CHARS} characters");
    }
    Ok(())
}

pub(crate) fn validate_label(value: &str) -> Result<()> {
    if value.is_empty() || value.contains('\0') {
        bail!("CC_INVALID_ARGUMENT: label must be non-empty and NUL-free");
    }
    if value.chars().count() > MAX_LABEL_CHARS {
        bail!("CC_INVALID_ARGUMENT: label exceeds {MAX_LABEL_CHARS} characters");
    }
    Ok(())
}

pub(crate) fn validate_host_id(value: &str) -> Result<()> {
    if value.is_empty() || value.chars().count() > MAX_HOST_ID_CHARS {
        bail!("CC_INVALID_IDENTITY: hostId must be 1..={MAX_HOST_ID_CHARS} characters");
    }
    if value.chars().any(|character| {
        character == '\0' || character.is_whitespace() || character == '/' || character == '\\'
    }) {
        bail!("CC_INVALID_IDENTITY: hostId must not contain whitespace, NUL or path separators");
    }
    Ok(())
}

/// The principal comes from authenticated transport state; a request can never
/// supply or widen it.
pub(crate) fn validate_principal(value: &str) -> Result<()> {
    if value.is_empty() || value.contains('\0') {
        bail!("CC_INVALID_IDENTITY: principal must come from authenticated transport state");
    }
    if value.chars().count() > MAX_PRINCIPAL_CHARS {
        bail!("CC_INVALID_IDENTITY: principal exceeds {MAX_PRINCIPAL_CHARS} characters");
    }
    Ok(())
}

pub(crate) fn validate_revision(value: i64, minimum: i64) -> Result<()> {
    if value < minimum || value > MAX_REVISION {
        bail!("CC_INVALID_ARGUMENT: revision must be between {minimum} and {MAX_REVISION}");
    }
    Ok(())
}

pub(crate) fn validate_now(now: i64) -> Result<()> {
    if now < 0 {
        bail!("CC_INVALID_ARGUMENT: now must be a non-negative epoch millisecond value");
    }
    Ok(())
}

pub(crate) fn next_revision(current: i64) -> Result<i64> {
    current
        .checked_add(1)
        .filter(|value| *value <= MAX_REVISION)
        .ok_or_else(|| {
            anyhow::anyhow!("CC_REVISION_EXHAUSTED: revision exceeds the contract bound")
        })
}

/// Bounded user-authored text: non-empty after trimming and NUL-free.
pub(crate) fn validate_intent_text(value: &str, label: &str, max_chars: usize) -> Result<()> {
    if value.trim().is_empty() {
        bail!("CC_INVALID_REQUEST: {label} must not be blank");
    }
    if value.contains('\0') {
        bail!("CC_INVALID_REQUEST: {label} must be NUL-free");
    }
    if value.chars().count() > max_chars {
        bail!("CC_INVALID_REQUEST: {label} exceeds {max_chars} characters");
    }
    Ok(())
}

fn valid_error_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_ERROR_CODE_CHARS || !bytes[0].is_ascii_uppercase() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// Error evidence carried by a receipt. Codes come from already registered wire
/// families; the detail message stays bounded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReceiptError {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl ReceiptError {
    pub(crate) fn new(code: &str, message: &str) -> Result<Self> {
        if !valid_error_code(code) {
            bail!("CC_INVALID_ARGUMENT: error code must be an upper-case registered code");
        }
        if message.is_empty() || message.chars().count() > MAX_ERROR_MESSAGE_CHARS {
            bail!(
                "CC_INVALID_ARGUMENT: error message must be 1..={MAX_ERROR_MESSAGE_CHARS} characters"
            );
        }
        if message.contains('\0') {
            bail!("CC_INVALID_ARGUMENT: error message must be NUL-free");
        }
        Ok(Self {
            code: code.to_owned(),
            message: message.to_owned(),
        })
    }
}

/// Evidence token for a durable reservation transition.
///
/// A terminal transition releases capacity, so the caller must name the
/// observation that permits it. The token is bounded and never empty; the
/// authoritative proof (settlement record, fence journal entry, launch
/// acknowledgement) stays with the module that produced it.
pub(crate) fn validate_evidence(value: &str) -> Result<()> {
    if value.is_empty() || value.chars().count() > MAX_EVIDENCE_CHARS {
        bail!("CC_INVALID_ARGUMENT: evidence must be 1..={MAX_EVIDENCE_CHARS} characters");
    }
    if value.contains('\0') {
        bail!("CC_INVALID_ARGUMENT: evidence must be NUL-free");
    }
    Ok(())
}

/// Supported scheduling boundary for a goal consumption acknowledgement.
/// Mirrors the frozen `^[a-z][a-z0-9_.-]{0,63}$` shared pattern.
pub(crate) fn validate_boundary(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    let shaped = !bytes.is_empty()
        && bytes.len() <= MAX_BOUNDARY_CHARS
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-')
        });
    if !shaped {
        bail!("CC_INVALID_CONSUMPTION: boundary must match ^[a-z][a-z0-9_.-]{{0,63}}$");
    }
    Ok(())
}
