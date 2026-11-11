//! Authoritative Rust storage and domain rules for command-center control.
//!
//! Ownership: this module owns the durable facts, not the transport. The RPC
//! layer validates an envelope and supplies an authenticated principal; every
//! rule below is enforced again here, inside an immediate SQLite transaction,
//! because a client-side check is never authority.
//!
//! Invariants the module exists to keep:
//!
//! * **Capacity is Rust-owned.** [`reservation::reserve_in`] is the single
//!   admission decision: twelve live executions per command workspace,
//!   thirty-six per Host, three enabled workspaces. `interrupted` and
//!   `outcome_unknown` retain their slot until an evidence-carrying transition
//!   releases it, exactly once.
//! * **Membership is a fence, not a label.** A session belongs to one command
//!   workspace at one revision; moves, disables and deletes are refused while a
//!   live execution would be stranded.
//! * **Desired and effective goals are different facts.** A committed intent
//!   advances `desired`; only a concrete runtime consumption acknowledgement
//!   for that exact execution advances `effective`.
//! * **Execution identity is exact.** A control request names the concrete
//!   execution, including the native generation, so a delayed control can never
//!   act on a replacement run.
//! * **Receipts and goal revisions are retained.** Idempotency evidence and
//!   history outlive the request; storage triggers refuse deletion.
//!
//! Transaction shape: every write exists twice. `*_in` assumes the caller
//! already holds the immediate transaction, and the unsuffixed function opens
//! one. Composition (receipt + goal revision + parent notification + caller
//! history) belongs in one `*_in` chain so a partial effect cannot commit.
//!
//! Not modelled here on purpose: dispatch, provider calls, model selection and
//! capability advertisement. This module records authority; the runtime
//! executes it.
#![allow(dead_code)] // The RPC surface that consumes these APIs lands separately.

pub(crate) mod api;
pub(crate) mod goal;
pub(crate) mod identity;
pub(crate) mod limits;
pub(crate) mod notification;
pub(crate) mod payload;
pub(crate) mod receipt;
pub(crate) mod reservation;
pub(crate) mod schema;
pub(crate) mod state;
pub(crate) mod tx;
pub(crate) mod workspace;

#[cfg(test)]
mod fixture_tests;
#[cfg(test)]
mod goal_tests;
#[cfg(test)]
mod key_tests;
#[cfg(test)]
mod receipt_tests;
#[cfg(test)]
mod reservation_tests;
#[cfg(test)]
mod tests;

/// Single DDL definition, shared by fresh create and the additive upgrade.
pub(crate) const SCHEMA_DDL: &str = schema::DDL;

/// Tables that must exist before any control operation may run.
pub(crate) const SCHEMA_TABLES: [&str; 8] = schema::TABLES;

/// Fail closed when the additive migration has not run for this database.
pub(crate) fn ensure_schema(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    schema::ensure(conn)
}

/// Compare live storage objects with the definition in [`SCHEMA_DDL`].
pub(crate) fn validate_schema(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    schema::validate(conn)
}

pub(crate) use goal::{GoalCommit, GoalHead, GoalRevision};
pub(crate) use identity::{parse_execution_key, parse_task_key, ExecutionTarget, TaskTarget};
pub(crate) use limits::ReceiptError;
pub(crate) use notification::{NotificationState, ParentNotification, PendingNotification};
pub(crate) use payload::{Consumption, InterventionIntent, InterventionRequest};
pub(crate) use receipt::{InterventionOutcome, Receipt, ReceiptTransition};
pub(crate) use reservation::{
    CapacityCounts, Reservation, ReservationEvent, ReservationRequest, ReservationTransition,
};
pub(crate) use state::{Operation, ReceiptStatus, ReservationState, StopScope};
pub(crate) use workspace::{BindSession, Membership, Workspace};
