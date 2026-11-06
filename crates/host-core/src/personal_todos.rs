//! Profile-global personal todo board, independent from session TodoWrite.

use std::collections::HashSet;

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::{now_ms, Database};

pub const MAX_PERSONAL_TODO_ITEMS: usize = 200;
pub const MAX_PERSONAL_TODO_TITLE_CHARS: usize = 2_000;
pub const MAX_PERSONAL_TODO_NOTE_CHARS: usize = 20_000;
pub const MAX_PERSONAL_TODO_DOCUMENT_BYTES: usize = 1_048_576;
pub const MAX_PERSONAL_TODO_ID_CHARS: usize = 128;
pub const MAX_PERSONAL_TODO_REVISION: i64 = 9_007_199_254_740_991;

const NAMESPACE: &str = "personalTodos";
const DOCUMENT_KEY: &str = "document";
const LAST_MUTATION_KEY: &str = "lastMutation";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersonalTodoItem {
    pub id: String,
    pub title: String,
    pub note: String,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersonalTodoDocument {
    pub schema_version: u32,
    pub revision: i64,
    pub updated_at: Option<i64>,
    pub items: Vec<PersonalTodoItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersonalTodoReplace {
    pub items: Vec<PersonalTodoItem>,
    pub expected_revision: i64,
    pub mutation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LastMutation {
    mutation_id: String,
    expected_revision: i64,
    request_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MutationFingerprint<'a> {
    expected_revision: i64,
    items: &'a [PersonalTodoItem],
}

#[derive(Debug)]
pub enum ReplaceError {
    InvalidArgument(String),
    LimitExceeded(&'static str),
    Conflict,
    IdempotencyConflict,
    Internal(anyhow::Error),
}

enum TxError {
    Rejected(ReplaceError),
    Storage(anyhow::Error),
}

impl PersonalTodoDocument {
    fn empty() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            updated_at: None,
            items: Vec::new(),
        }
    }
}

/// Return the profile board. Missing both versioned records means a new profile;
/// any partial, corrupt, unsupported, or invalid state fails closed.
pub fn get(db: &Database) -> Result<PersonalTodoDocument> {
    let connection = db.conn();
    connection.execute_batch("BEGIN DEFERRED")?;
    let mut guard = ReadTransactionGuard {
        connection,
        active: true,
    };
    let result = load(connection).map(|(document, _)| document);
    guard.finish()?;
    result
}

/// Compare-and-swap and atomically replace the entire ordered document.
pub fn replace(
    db: &Database,
    request: &PersonalTodoReplace,
) -> std::result::Result<PersonalTodoDocument, ReplaceError> {
    validate_request(request)?;
    let hash = mutation_hash(request).map_err(ReplaceError::Internal)?;
    match db.with_full_synchronous_immediate_transaction(|connection| match replace_in_transaction(
        connection, request, &hash,
    ) {
        Ok(document) => Ok(Ok(document)),
        Err(TxError::Rejected(error)) => Ok(Err(error)),
        Err(TxError::Storage(error)) => Err(error),
    }) {
        Ok(result) => result,
        Err(error) => Err(ReplaceError::Internal(error)),
    }
}

fn replace_in_transaction(
    connection: &Connection,
    request: &PersonalTodoReplace,
    request_hash: &str,
) -> std::result::Result<PersonalTodoDocument, TxError> {
    let (current, previous) = load(connection).map_err(TxError::Storage)?;
    if let Some(previous) = previous {
        if previous.mutation_id == request.mutation_id {
            if previous.expected_revision == request.expected_revision
                && previous.request_hash == request_hash
            {
                return Ok(current);
            }
            return Err(TxError::Rejected(ReplaceError::IdempotencyConflict));
        }
    }
    if current.revision != request.expected_revision {
        return Err(TxError::Rejected(ReplaceError::Conflict));
    }
    let revision = current
        .revision
        .checked_add(1)
        .filter(|value| *value <= MAX_PERSONAL_TODO_REVISION)
        .ok_or_else(|| TxError::Rejected(ReplaceError::LimitExceeded("revision limit exceeded")))?;
    let updated_at = now_ms();
    let document = PersonalTodoDocument {
        schema_version: 1,
        revision,
        updated_at: Some(updated_at),
        items: request.items.clone(),
    };
    validate_document(&document).map_err(TxError::Rejected)?;
    let document_json = serde_json::to_string(&document)
        .context("serialize personal todo document")
        .map_err(TxError::Storage)?;
    if document_json.len() > MAX_PERSONAL_TODO_DOCUMENT_BYTES {
        return Err(TxError::Rejected(ReplaceError::LimitExceeded(
            "serialized personal todo document exceeds 1 MiB",
        )));
    }
    let last_mutation = LastMutation {
        mutation_id: request.mutation_id.clone(),
        expected_revision: request.expected_revision,
        request_hash: request_hash.to_owned(),
    };
    let marker_json = serde_json::to_string(&last_mutation)
        .context("serialize personal todo mutation marker")
        .map_err(TxError::Storage)?;
    upsert(connection, DOCUMENT_KEY, &document_json, updated_at).map_err(TxError::Storage)?;
    upsert(connection, LAST_MUTATION_KEY, &marker_json, updated_at).map_err(TxError::Storage)?;
    Ok(document)
}

fn validate_request(request: &PersonalTodoReplace) -> std::result::Result<(), ReplaceError> {
    if request.expected_revision < 0 || request.expected_revision > MAX_PERSONAL_TODO_REVISION {
        return Err(ReplaceError::InvalidArgument(
            "expectedRevision must be a non-negative safe integer".into(),
        ));
    }
    validate_id(&request.mutation_id, "mutationId")?;
    validate_items(&request.items)
}

fn validate_items(items: &[PersonalTodoItem]) -> std::result::Result<(), ReplaceError> {
    if items.len() > MAX_PERSONAL_TODO_ITEMS {
        return Err(ReplaceError::LimitExceeded(
            "personal todo document accepts at most 200 items",
        ));
    }
    let mut ids = HashSet::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        validate_id(&item.id, "item id")?;
        if !ids.insert(item.id.as_str()) {
            return Err(ReplaceError::InvalidArgument(format!(
                "items[{index}].id must be unique"
            )));
        }
        if item.title.chars().count() > MAX_PERSONAL_TODO_TITLE_CHARS {
            return Err(ReplaceError::LimitExceeded(
                "personal todo title exceeds 2000 Unicode scalar values",
            ));
        }
        if item.note.chars().count() > MAX_PERSONAL_TODO_NOTE_CHARS {
            return Err(ReplaceError::LimitExceeded(
                "personal todo note exceeds 20000 Unicode scalar values",
            ));
        }
    }
    Ok(())
}

fn validate_id(id: &str, label: &str) -> std::result::Result<(), ReplaceError> {
    let length = id.chars().count();
    if length == 0 || id.contains('\0') {
        return Err(ReplaceError::InvalidArgument(format!(
            "{label} must be non-empty and NUL-free"
        )));
    }
    if length > MAX_PERSONAL_TODO_ID_CHARS {
        return Err(ReplaceError::LimitExceeded(
            "personal todo identifiers are limited to 128 Unicode scalar values",
        ));
    }
    Ok(())
}

fn validate_document(document: &PersonalTodoDocument) -> std::result::Result<(), ReplaceError> {
    if document.schema_version != 1 {
        return Err(ReplaceError::Internal(anyhow!(
            "unsupported personal todo schema version {}",
            document.schema_version
        )));
    }
    if document.revision < 0 || document.revision > MAX_PERSONAL_TODO_REVISION {
        return Err(ReplaceError::Internal(anyhow!(
            "invalid personal todo revision"
        )));
    }
    if document.revision == 0 {
        if document.updated_at.is_some() || !document.items.is_empty() {
            return Err(ReplaceError::Internal(anyhow!(
                "invalid initial personal todo document"
            )));
        }
    } else if document.updated_at.is_none_or(|value| value < 0) {
        return Err(ReplaceError::Internal(anyhow!(
            "invalid personal todo updatedAt"
        )));
    }
    validate_items(&document.items).map_err(|error| match error {
        ReplaceError::InvalidArgument(message) => {
            ReplaceError::Internal(anyhow!("corrupt personal todo document: {message}"))
        }
        ReplaceError::LimitExceeded(message) => {
            ReplaceError::Internal(anyhow!("corrupt personal todo document: {message}"))
        }
        other => other,
    })
}

fn load(connection: &Connection) -> Result<(PersonalTodoDocument, Option<LastMutation>)> {
    let document_json = read(connection, DOCUMENT_KEY)?;
    let marker_json = read(connection, LAST_MUTATION_KEY)?;
    match (document_json, marker_json) {
        (None, None) => Ok((PersonalTodoDocument::empty(), None)),
        (Some(document_json), Some(marker_json)) => {
            if document_json.len() > MAX_PERSONAL_TODO_DOCUMENT_BYTES {
                return Err(anyhow!("stored personal todo document exceeds 1 MiB"));
            }
            let document: PersonalTodoDocument = serde_json::from_str(&document_json)
                .context("stored personal todo document is malformed or unsupported")?;
            validate_document(&document)
                .map_err(|error| anyhow!("stored personal todo document is invalid: {error:?}"))?;
            if serde_json::to_vec(&document)
                .context("serialize stored personal todo document")?
                .len()
                > MAX_PERSONAL_TODO_DOCUMENT_BYTES
            {
                return Err(anyhow!("stored personal todo document exceeds 1 MiB"));
            }
            let marker: LastMutation = serde_json::from_str(&marker_json)
                .context("stored personal todo mutation marker is malformed")?;
            validate_id(&marker.mutation_id, "stored mutationId").map_err(|error| {
                anyhow!("stored personal todo mutation marker is invalid: {error:?}")
            })?;
            if document.revision == 0
                || marker.expected_revision < 0
                || Some(marker.expected_revision) != document.revision.checked_sub(1)
                || marker.request_hash.len() != 64
                || !marker
                    .request_hash
                    .bytes()
                    .all(|value| value.is_ascii_hexdigit())
                || marker.request_hash
                    != mutation_hash_parts(marker.expected_revision, &document.items)?
            {
                return Err(anyhow!(
                    "stored personal todo mutation marker does not match document"
                ));
            }
            Ok((document, Some(marker)))
        }
        _ => Err(anyhow!("personal todo storage is incomplete")),
    }
}

fn mutation_hash(request: &PersonalTodoReplace) -> Result<String> {
    mutation_hash_parts(request.expected_revision, &request.items)
}

fn mutation_hash_parts(expected_revision: i64, items: &[PersonalTodoItem]) -> Result<String> {
    let bytes = serde_json::to_vec(&MutationFingerprint {
        expected_revision,
        items,
    })
    .context("serialize personal todo mutation fingerprint")?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn read(connection: &Connection, key: &str) -> Result<Option<String>> {
    connection
        .query_row(
            "SELECT value_json FROM kv WHERE ns = ?1 AND key = ?2",
            params![NAMESPACE, key],
            |row| row.get(0),
        )
        .optional()
        .context("read personal todo storage")
}

fn upsert(connection: &Connection, key: &str, value: &str, updated_at: i64) -> Result<()> {
    connection.execute(
        "INSERT INTO kv (ns, key, value_json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(ns, key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at",
        params![NAMESPACE, key, value, updated_at],
    )?;
    Ok(())
}

struct ReadTransactionGuard<'a> {
    connection: &'a Connection,
    active: bool,
}
impl ReadTransactionGuard<'_> {
    fn finish(&mut self) -> Result<()> {
        self.connection.execute_batch("COMMIT")?;
        self.active = false;
        Ok(())
    }
}
impl Drop for ReadTransactionGuard<'_> {
    fn drop(&mut self) {
        if self.active {
            if let Err(error) = self.connection.execute_batch("ROLLBACK") {
                tracing::error!(%error, "failed to close personal todo read transaction");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn db() -> (tempfile::TempDir, Database) {
        let dir = tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }
    fn item(id: &str, title: &str, note: &str) -> PersonalTodoItem {
        PersonalTodoItem {
            id: id.into(),
            title: title.into(),
            note: note.into(),
            completed: false,
        }
    }
    fn request(
        items: Vec<PersonalTodoItem>,
        expected_revision: i64,
        mutation_id: &str,
    ) -> PersonalTodoReplace {
        PersonalTodoReplace {
            items,
            expected_revision,
            mutation_id: mutation_id.into(),
        }
    }

    #[test]
    fn empty_unicode_blank_draft_empty_clear_and_order_round_trip() {
        let (_dir, db) = db();
        assert_eq!(
            get(&db).unwrap(),
            PersonalTodoDocument {
                schema_version: 1,
                revision: 0,
                updated_at: None,
                items: vec![]
            }
        );
        let saved = replace(
            &db,
            &request(
                vec![item("a", "", "第一行\nsecond"), item("b", "next", "")],
                0,
                "m1",
            ),
        )
        .unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.items[0].title, "");
        assert_eq!(saved.items[0].note, "第一行\nsecond");
        assert_eq!(get(&db).unwrap(), saved);
        let cleared = replace(&db, &request(vec![], 1, "m2")).unwrap();
        assert_eq!(cleared.revision, 2);
        assert!(cleared.items.is_empty());
    }

    #[test]
    fn validates_unicode_scalar_limits_unique_nul_free_bounded_ids_and_item_count() {
        let (_dir, db) = db();
        let exact = item(
            "ok",
            &"🙂".repeat(MAX_PERSONAL_TODO_TITLE_CHARS),
            &"日".repeat(MAX_PERSONAL_TODO_NOTE_CHARS),
        );
        replace(&db, &request(vec![exact], 0, "first")).unwrap();
        for (items, token) in [
            (vec![item("same", "a", ""), item("same", "b", "")], "dupe"),
            (vec![item("bad\0id", "x", "")], "nul"),
            (
                vec![item(&"x".repeat(MAX_PERSONAL_TODO_ID_CHARS + 1), "x", "")],
                "long-id",
            ),
            (
                vec![item(
                    "x",
                    &"x".repeat(MAX_PERSONAL_TODO_TITLE_CHARS + 1),
                    "",
                )],
                "long-title",
            ),
            (
                vec![item(
                    "x",
                    "x",
                    &"x".repeat(MAX_PERSONAL_TODO_NOTE_CHARS + 1),
                )],
                "long-note",
            ),
            (
                vec![item("x", "", ""); MAX_PERSONAL_TODO_ITEMS + 1],
                "too-many",
            ),
        ] {
            assert!(replace(&db, &request(items, 1, token)).is_err(), "{token}");
        }
        assert!(replace(&db, &request(vec![], 1, "bad\0mutation")).is_err());
    }

    #[test]
    fn rejects_serialized_document_over_one_mib_without_partial_write() {
        let (_dir, db) = db();
        let items = (0..MAX_PERSONAL_TODO_ITEMS)
            .map(|i| item(&i.to_string(), "", &"日".repeat(6_000)))
            .collect();
        assert!(matches!(
            replace(&db, &request(items, 0, "large")),
            Err(ReplaceError::LimitExceeded(_))
        ));
        assert_eq!(get(&db).unwrap().revision, 0);
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM kv WHERE ns=?1", [NAMESPACE], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn cas_idempotency_conflict_and_late_retry_preserve_latest_data() {
        let (_dir, db) = db();
        let first = request(vec![item("a", "one", "")], 0, "token");
        let committed = replace(&db, &first).unwrap();
        assert_eq!(replace(&db, &first).unwrap(), committed);
        assert!(matches!(
            replace(&db, &request(vec![item("b", "changed", "")], 0, "token")),
            Err(ReplaceError::IdempotencyConflict)
        ));
        assert!(matches!(
            replace(&db, &request(vec![], 0, "stale")),
            Err(ReplaceError::Conflict)
        ));
        assert_eq!(
            replace(&db, &request(vec![item("b", "new", "")], 1, "next"))
                .unwrap()
                .revision,
            2
        );
        assert!(matches!(replace(&db, &first), Err(ReplaceError::Conflict)));
        assert_eq!(get(&db).unwrap().items[0].title, "new");
    }

    #[test]
    fn persisted_document_and_duplicate_retry_survive_restart() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let request = request(vec![item("saved", "durable", "note")], 0, "retry-token");
        let saved = {
            let db = Database::open(&path).unwrap();
            replace(&db, &request).unwrap()
        };
        let reopened = Database::open(&path).unwrap();
        assert_eq!(get(&reopened).unwrap(), saved);
        assert_eq!(replace(&reopened, &request).unwrap(), saved);
    }

    #[test]
    fn corrupt_unsupported_and_partial_records_fail_closed() {
        let (_dir, db) = db();
        db.conn()
            .execute(
                "INSERT INTO kv VALUES (?1, ?2, ?3, 1)",
                params![NAMESPACE, DOCUMENT_KEY, "not-json"],
            )
            .unwrap();
        assert!(get(&db).is_err());
        assert!(matches!(
            replace(&db, &request(vec![], 0, "no-reset")),
            Err(ReplaceError::Internal(_))
        ));
        let raw: String = db
            .conn()
            .query_row(
                "SELECT value_json FROM kv WHERE ns=?1 AND key=?2",
                params![NAMESPACE, DOCUMENT_KEY],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(raw, "not-json");
        db.conn()
            .execute(
                "UPDATE kv SET value_json=?1 WHERE ns=?2 AND key=?3",
                params![
                    serde_json::json!({"schemaVersion":2,"revision":0,"updatedAt":null,"items":[]})
                        .to_string(),
                    NAMESPACE,
                    DOCUMENT_KEY
                ],
            )
            .unwrap();
        assert!(get(&db).is_err());
        db.conn()
            .execute("DELETE FROM kv WHERE ns=?1", [NAMESPACE])
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO kv VALUES (?1, ?2, ?3, 1)",
                params![NAMESPACE, LAST_MUTATION_KEY, "{}"],
            )
            .unwrap();
        assert!(get(&db).is_err());
    }

    #[test]
    fn full_synchronous_write_restores_previous_mode_on_success_failure_and_panic() {
        let (_dir, db) = db();
        let original: i64 = db
            .conn()
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(original, 1);
        let level = db
            .with_full_synchronous_immediate_transaction(|connection| {
                connection
                    .query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(level, 2);
        assert_eq!(
            db.conn()
                .query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            original
        );
        db.conn().execute_batch("CREATE TRIGGER fail_todo BEFORE INSERT ON kv WHEN NEW.ns='personalTodos' BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        assert!(matches!(
            replace(&db, &request(vec![item("x", "x", "")], 0, "failure")),
            Err(ReplaceError::Internal(_))
        ));
        db.conn().execute_batch("DROP TRIGGER fail_todo").unwrap();
        assert_eq!(
            db.conn()
                .query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            original
        );
        assert_eq!(get(&db).unwrap().revision, 0);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ =
                db.with_full_synchronous_immediate_transaction::<()>(|_| panic!("injected panic"));
        }));
        assert_eq!(
            db.conn()
                .query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            original
        );
        assert_eq!(
            replace(
                &db,
                &request(
                    vec![item("after-panic", "write restored", "")],
                    0,
                    "after-panic"
                ),
            )
            .unwrap()
            .revision,
            1,
            "panic cleanup releases the transaction as well as restoring the pragma"
        );
    }

    #[test]
    fn empty_write_commits_document_and_mutation_marker() {
        let (_dir, db) = db();
        replace(&db, &request(vec![], 0, "empty")).unwrap();
        let marker: String = db
            .conn()
            .query_row(
                "SELECT value_json FROM kv WHERE ns=?1 AND key=?2",
                params![NAMESPACE, LAST_MUTATION_KEY],
                |r| r.get(0),
            )
            .unwrap();
        let marker: LastMutation = serde_json::from_str(&marker).unwrap();
        assert_eq!(marker.mutation_id, "empty");
        assert_eq!(marker.expected_revision, 0);
        assert_eq!(get(&db).unwrap().revision, 1);
    }
}
