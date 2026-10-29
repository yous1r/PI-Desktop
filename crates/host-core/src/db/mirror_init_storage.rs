//! Durable state for a mirror project's initialization (spec 23 §3.2, §4, §8).
//!
//! Initialization is a blocking, resumable sequence of ten steps. Two kinds of
//! state make a resume possible without repeating work: the current state row,
//! and one receipt per completed step. A retry skips a step whose receipt is
//! still valid, so the receipts — not a flag — are what make the sequence
//! re-entrant.
//!
//! The state row is a single row per project group, keyed by group id. A project
//! group is a `kv(projectGroups)` record rather than a table, so there is no
//! foreign key to cascade through: group-owned rows are removed by
//! [`Database::delete_project_group_record`] in the same transaction that drops
//! the group record, exactly like the mirror baseline and the breakpoints.
//!
//! Every write validates its input first. A row that no later reader could
//! interpret — an unknown step id, a receipt that is not a JSON object, a state
//! that contradicts its own step or error — must never become durable state, or
//! the next resume would have to guess.

use super::*;

/// Upper bound on one stored receipt. A receipt records what a step observed
/// (a version, a digest, a list of installed adapters), so it is small by
/// construction; a larger blob is a caller bug, and refusing it keeps one write
/// from holding the single writer for an unbounded time.
pub const MAX_MIRROR_INIT_RECEIPT_BYTES: usize = 64 * 1024;

const MAX_MIRROR_PROJECT_ID_CHARS: usize = 200;
const MAX_MIRROR_FAILURE_CODE_BYTES: usize = 64;
const MAX_MIRROR_FAILURE_MESSAGE_BYTES: usize = 512;

/// Where a project sits relative to its mirror environment.
///
/// The wire form is kebab-case because the same identifiers cross the
/// host RPC boundary and the renderer's shared types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MirrorInitState {
    /// Absence of a run. Carries neither a step nor an error.
    NeedsInit,
    /// A run is in flight and `step` is where it is.
    Initializing,
    /// Every step produced a valid receipt.
    Ready,
    /// A run stopped at `step`; the error says why.
    InitFailed,
}

impl MirrorInitState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NeedsInit => "needs-init",
            Self::Initializing => "initializing",
            Self::Ready => "ready",
            Self::InitFailed => "init-failed",
        }
    }

    /// Reads a wire identifier. An identifier this build does not know is
    /// `None`, never a silent default.
    pub fn from_id(value: &str) -> Option<Self> {
        match value {
            "needs-init" => Some(Self::NeedsInit),
            "initializing" => Some(Self::Initializing),
            "ready" => Some(Self::Ready),
            "init-failed" => Some(Self::InitFailed),
            _ => None,
        }
    }
}

/// The ten initialization steps, in execution order (spec 23 §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MirrorInitStep {
    Ssh,
    HelperDir,
    HelperDeploy,
    HelperStart,
    EnvVerify,
    AdapterInstall,
    AdapterProbe,
    ForwardSelfTest,
    LocalEnvironment,
    Manifest,
}

/// Execution order, and the only step identifiers this build accepts.
pub const MIRROR_INIT_STEP_ORDER: [MirrorInitStep; 10] = [
    MirrorInitStep::Ssh,
    MirrorInitStep::HelperDir,
    MirrorInitStep::HelperDeploy,
    MirrorInitStep::HelperStart,
    MirrorInitStep::EnvVerify,
    MirrorInitStep::AdapterInstall,
    MirrorInitStep::AdapterProbe,
    MirrorInitStep::ForwardSelfTest,
    MirrorInitStep::LocalEnvironment,
    MirrorInitStep::Manifest,
];

impl MirrorInitStep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ssh => "ssh",
            Self::HelperDir => "helper-dir",
            Self::HelperDeploy => "helper-deploy",
            Self::HelperStart => "helper-start",
            Self::EnvVerify => "env-verify",
            Self::AdapterInstall => "adapter-install",
            Self::AdapterProbe => "adapter-probe",
            Self::ForwardSelfTest => "forward-self-test",
            Self::LocalEnvironment => "local-environment",
            Self::Manifest => "manifest",
        }
    }

    pub fn from_id(value: &str) -> Option<Self> {
        MIRROR_INIT_STEP_ORDER
            .iter()
            .copied()
            .find(|step| step.as_str() == value)
    }

    /// Position in the sequence, used to store and read receipts in order.
    fn position(self) -> i64 {
        MIRROR_INIT_STEP_ORDER
            .iter()
            .position(|step| *step == self)
            .map(|index| index as i64)
            .unwrap_or(-1)
    }
}

/// Why an initialization run stopped. `code` is one of the registered error
/// codes, so the renderer can localize it; `message` is a short explanation that
/// never carries raw SSH output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorInitFailure {
    pub code: String,
    pub message: String,
    pub step: MirrorInitStep,
}

/// One completed step's evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorInitReceipt {
    pub step: MirrorInitStep,
    /// The step's own JSON object, stored verbatim.
    pub receipt: String,
    pub updated_at: i64,
}

/// The state row for one project group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorInitRecord {
    pub state: MirrorInitState,
    pub step: Option<MirrorInitStep>,
    pub error: Option<MirrorInitFailure>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Shared verbatim by the fresh schema and the v28 -> v29 migration;
/// `IF NOT EXISTS` keeps a second run harmless.
///
/// The CHECK constraints are defense in depth behind the Rust validation below:
/// the repository layer is the real gate, and a constraint failure here means
/// the two drifted apart.
pub(crate) const MIRROR_INIT_STORAGE_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS mirror_init (
  project_id    TEXT NOT NULL PRIMARY KEY,
  state         TEXT NOT NULL CHECK (
                  state IN ('needs-init', 'initializing', 'ready', 'init-failed')
                ),
  step          TEXT CHECK (
                  step IS NULL
                  OR step IN (
                    'ssh', 'helper-dir', 'helper-deploy', 'helper-start',
                    'env-verify', 'adapter-install', 'adapter-probe',
                    'forward-self-test', 'local-environment', 'manifest'
                  )
                ),
  error_code    TEXT,
  error_message TEXT,
  error_step    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- A failure is a whole fact: a code without its step would report an error
  -- that no reader could attribute.
  CHECK (
    (error_code IS NULL AND error_message IS NULL AND error_step IS NULL)
    OR (error_code IS NOT NULL AND error_message IS NOT NULL AND error_step IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS mirror_init_receipt (
  project_id   TEXT NOT NULL,
  step         TEXT NOT NULL CHECK (
                 step IN (
                   'ssh', 'helper-dir', 'helper-deploy', 'helper-start',
                   'env-verify', 'adapter-install', 'adapter-probe',
                   'forward-self-test', 'local-environment', 'manifest'
                 )
               ),
  receipt_json TEXT NOT NULL CHECK (
                 length(receipt_json) > 0 AND instr(receipt_json, char(0)) = 0
               ),
  position     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, step)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_mirror_init_receipt_project
  ON mirror_init_receipt(project_id);
"#;

fn validate_mirror_project_id(project_id: &str) -> Result<&str> {
    if project_id.trim().is_empty()
        || project_id.trim() != project_id
        || project_id.chars().count() > MAX_MIRROR_PROJECT_ID_CHARS
        || project_id.chars().any(char::is_control)
    {
        return Err(anyhow!("mirror init project id is invalid"));
    }
    Ok(project_id)
}

/// A failure code is a registered identifier, not a diagnostic. A raw SSH line
/// would be neither localizable nor safe to show, so a code that is not a plain
/// identifier is refused instead of stored.
fn validate_failure_code(code: &str) -> Result<()> {
    if code.is_empty() || code.len() > MAX_MIRROR_FAILURE_CODE_BYTES {
        return Err(anyhow!("mirror init failure code is invalid"));
    }
    if !code
        .bytes()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(anyhow!("mirror init failure code is not an error code"));
    }
    Ok(())
}

/// `state`, `step` and `error` describe one transition, so they must agree.
///
/// This is the rule the RPC layer calls before storing, and it is also applied
/// when a stored row is read back, so a hand-edited database cannot make the
/// next resume guess.
pub(crate) fn validate_mirror_init_state(
    state: MirrorInitState,
    step: Option<MirrorInitStep>,
    error: Option<&MirrorInitFailure>,
) -> Result<()> {
    if let Some(failure) = error {
        validate_failure_code(&failure.code)?;
        if failure.message.trim().is_empty() {
            return Err(anyhow!("mirror init failure message must not be blank"));
        }
        if failure.message.len() > MAX_MIRROR_FAILURE_MESSAGE_BYTES {
            return Err(anyhow!(
                "mirror init failure message exceeds {MAX_MIRROR_FAILURE_MESSAGE_BYTES} bytes"
            ));
        }
    }
    match state {
        MirrorInitState::NeedsInit => {
            if step.is_some() || error.is_some() {
                return Err(anyhow!(
                    "mirror init needs-init carries neither a step nor an error"
                ));
            }
        }
        MirrorInitState::Initializing => {
            if step.is_none() {
                return Err(anyhow!(
                    "mirror init initializing requires the running step"
                ));
            }
            if error.is_some() {
                return Err(anyhow!("mirror init initializing carries no error"));
            }
        }
        MirrorInitState::Ready => {
            if error.is_some() {
                return Err(anyhow!("mirror init ready carries no error"));
            }
        }
        MirrorInitState::InitFailed => {
            let Some(step) = step else {
                return Err(anyhow!("mirror init init-failed requires the failing step"));
            };
            let Some(failure) = error else {
                return Err(anyhow!("mirror init init-failed requires the failure"));
            };
            if failure.step != step {
                return Err(anyhow!(
                    "mirror init failure names a different step than the failing step"
                ));
            }
        }
    }
    Ok(())
}

fn validate_receipt(step: MirrorInitStep, receipt: &str) -> Result<()> {
    if receipt.is_empty() || receipt.len() > MAX_MIRROR_INIT_RECEIPT_BYTES {
        return Err(anyhow!(
            "mirror init receipt must be 1..={MAX_MIRROR_INIT_RECEIPT_BYTES} bytes"
        ));
    }
    if receipt.contains('\0') {
        return Err(anyhow!("mirror init receipt must not contain NUL"));
    }
    let parsed: Value = serde_json::from_str(receipt)
        .map_err(|_| anyhow!("mirror init receipt for {} is not JSON", step.as_str()))?;
    // The wire contract says a receipt is an object; an array or a bare string
    // would leave the reader with nothing to look a field up in.
    if !parsed.is_object() {
        return Err(anyhow!(
            "mirror init receipt for {} must be a JSON object",
            step.as_str()
        ));
    }
    Ok(())
}

/// Remove every initialization row owned by `project_id`. Takes a connection
/// instead of opening a transaction so the group deletion can commit it together
/// with the group record and its kv siblings.
pub(crate) fn delete_mirror_init_rows(conn: &Connection, project_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM mirror_init_receipt WHERE project_id = ?1",
        params![project_id],
    )?;
    conn.execute(
        "DELETE FROM mirror_init WHERE project_id = ?1",
        params![project_id],
    )?;
    Ok(())
}

/// v29 is additive: it adds the initialization state row and its receipts.
/// No existing row changes, so the step only creates tables and indexes.
fn migrate_v28_to_v29_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    tx.execute_batch(MIRROR_INIT_STORAGE_DDL)?;
    tx.pragma_update(None, "user_version", 29i64)?;
    Ok(())
}

pub(crate) fn migrate_v28_to_v29(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 28)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v28_to_v29_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v28 to v29 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

fn init_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MirrorInitRecord> {
    let state: String = row.get("state")?;
    let step: Option<String> = row.get("step")?;
    let error_code: Option<String> = row.get("error_code")?;
    let error_message: Option<String> = row.get("error_message")?;
    let error_step: Option<String> = row.get("error_step")?;
    // A stored row this build cannot interpret is corruption, not a caller
    // error, so it surfaces as a read failure rather than a default.
    let state = MirrorInitState::from_id(&state).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(0, "state".into(), rusqlite::types::Type::Text)
    })?;
    let step = match step {
        Some(value) => Some(MirrorInitStep::from_id(&value).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(0, "step".into(), rusqlite::types::Type::Text)
        })?),
        None => None,
    };
    let error = match (error_code, error_message, error_step) {
        (Some(code), Some(message), Some(step)) => Some(MirrorInitFailure {
            code,
            message,
            step: MirrorInitStep::from_id(&step).ok_or_else(|| {
                rusqlite::Error::InvalidColumnType(
                    0,
                    "error_step".into(),
                    rusqlite::types::Type::Text,
                )
            })?,
        }),
        _ => None,
    };
    Ok(MirrorInitRecord {
        state,
        step,
        error,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl Database {
    /// The stored state row, or `None` when the project was never initialized.
    ///
    /// `None` is the `needs-init` state: a project that has no row has not been
    /// started, and inventing a stored default would hide that.
    pub fn get_mirror_init(&self, project_id: &str) -> Result<Option<MirrorInitRecord>> {
        let project_id = validate_mirror_project_id(project_id)?;
        let record = self
            .conn
            .query_row(
                "SELECT state, step, error_code, error_message, error_step, created_at, updated_at
                 FROM mirror_init WHERE project_id = ?1",
                params![project_id],
                init_record_from_row,
            )
            .optional()?;
        if let Some(record) = &record {
            validate_mirror_init_state(record.state, record.step, record.error.as_ref())?;
        }
        Ok(record)
    }

    /// Write the project's state.
    ///
    /// `created_at` is the first time this project entered initialization and is
    /// preserved across every later transition, so a resumed run keeps its
    /// original start time.
    pub fn set_mirror_init_state(
        &self,
        project_id: &str,
        state: MirrorInitState,
        step: Option<MirrorInitStep>,
        error: Option<&MirrorInitFailure>,
    ) -> Result<MirrorInitRecord> {
        let project_id = validate_mirror_project_id(project_id)?;
        validate_mirror_init_state(state, step, error)?;
        let now = now_ms();
        let error_code = error.map(|failure| failure.code.as_str());
        let error_message = error.map(|failure| failure.message.as_str());
        let error_step = error.map(|failure| failure.step.as_str());
        self.conn.execute(
            "INSERT INTO mirror_init
               (project_id, state, step, error_code, error_message, error_step,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(project_id) DO UPDATE SET
               state = excluded.state,
               step = excluded.step,
               error_code = excluded.error_code,
               error_message = excluded.error_message,
               error_step = excluded.error_step,
               updated_at = excluded.updated_at",
            params![
                project_id,
                state.as_str(),
                step.map(MirrorInitStep::as_str),
                error_code,
                error_message,
                error_step,
                now,
            ],
        )?;
        self.get_mirror_init(project_id)?
            .ok_or_else(|| anyhow!("mirror init state was not stored"))
    }

    /// The project's receipts in execution order, so a resume reads them as the
    /// sequence it must skip over.
    pub fn list_mirror_init_receipts(&self, project_id: &str) -> Result<Vec<MirrorInitReceipt>> {
        let project_id = validate_mirror_project_id(project_id)?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT step, receipt_json, updated_at FROM mirror_init_receipt
             WHERE project_id = ?1 ORDER BY position, step",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            let step: String = row.get("step")?;
            let step = MirrorInitStep::from_id(&step).ok_or_else(|| {
                rusqlite::Error::InvalidColumnType(0, "step".into(), rusqlite::types::Type::Text)
            })?;
            Ok(MirrorInitReceipt {
                step,
                receipt: row.get("receipt_json")?,
                updated_at: row.get("updated_at")?,
            })
        })?;
        rows.map(|row| row.map_err(anyhow::Error::from)).collect()
    }

    /// Record one completed step. A retry that reaches the same step replaces
    /// the evidence in place, so a stale receipt never survives next to the
    /// current one.
    pub fn upsert_mirror_init_receipt(
        &self,
        project_id: &str,
        step: MirrorInitStep,
        receipt: &str,
        updated_at: i64,
    ) -> Result<MirrorInitReceipt> {
        let project_id = validate_mirror_project_id(project_id)?;
        validate_receipt(step, receipt)?;
        self.conn.execute(
            "INSERT INTO mirror_init_receipt
               (project_id, step, receipt_json, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(project_id, step) DO UPDATE SET
               receipt_json = excluded.receipt_json,
               position = excluded.position,
               updated_at = excluded.updated_at",
            params![
                project_id,
                step.as_str(),
                receipt,
                step.position(),
                updated_at
            ],
        )?;
        Ok(MirrorInitReceipt {
            step,
            receipt: receipt.to_string(),
            updated_at,
        })
    }

    /// Drop one receipt so the step runs again. `false` means there was none.
    pub fn delete_mirror_init_receipt(
        &self,
        project_id: &str,
        step: MirrorInitStep,
    ) -> Result<bool> {
        let project_id = validate_mirror_project_id(project_id)?;
        let removed = self.conn.execute(
            "DELETE FROM mirror_init_receipt WHERE project_id = ?1 AND step = ?2",
            params![project_id, step.as_str()],
        )?;
        Ok(removed > 0)
    }

    /// Drop every receipt for the project, which forces a full re-run.
    pub fn clear_mirror_init_receipts(&self, project_id: &str) -> Result<usize> {
        let project_id = validate_mirror_project_id(project_id)?;
        Ok(self.conn.execute(
            "DELETE FROM mirror_init_receipt WHERE project_id = ?1",
            params![project_id],
        )?)
    }
}
