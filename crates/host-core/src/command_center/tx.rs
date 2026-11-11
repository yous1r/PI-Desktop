//! Caller-owned transaction composition for the command-center repositories.
//!
//! A `*_in` function assumes the caller already holds an immediate transaction
//! on this connection and never starts one of its own, so the Host can compose
//! several repositories in one atomic step (receipt + goal head + history +
//! parent notification). The plain function is the standalone convenience
//! wrapper and refuses to nest.

use anyhow::{anyhow, Result};
use rusqlite::{Connection, Transaction, TransactionBehavior};

/// Run `operation` inside one immediate transaction on an existing connection.
///
/// `Connection` is not `&mut` here because the Host owns a shared `Database`
/// and already serializes writers; `BEGIN IMMEDIATE` makes the write lock
/// explicit instead of trusting the caller's later statements to upgrade.
pub(crate) fn immediate<T>(
    conn: &Connection,
    operation: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    let transaction =
        Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|error| {
            anyhow!(
                "CC_TRANSACTION: cannot begin an immediate command-center transaction ({error}); \
                 use the matching *_in function inside an existing transaction"
            )
        })?;
    let value = operation(&transaction)?;
    transaction.commit()?;
    Ok(value)
}
