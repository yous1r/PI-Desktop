//! Strict private stdio payloads, shared with the TypeScript coordinator.
use super::model;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const NOTIFY: &str = "ownerHandoff.quiescence";
pub const COMPLETE: &str = "ownerHandoff.completeQuiescence";
pub const TIMEOUT_MS: u64 = 30_000;
const MAX_COUNT: u64 = 9_007_199_254_740_991;
const COUNTS: [&str; 19] = [
    "clients",
    "turns",
    "queuedTurns",
    "plans",
    "tools",
    "processes",
    "terminals",
    "plugins",
    "admissions",
    "finalizations",
    "writes",
    "children",
    "workers",
    "schedules",
    "approvals",
    "inputs",
    "nativeSessions",
    "mcp",
    "uncontainedResources",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub exchange_id: String,
    pub transfer_id: String,
    pub source_epoch: String,
    pub revision: u64,
    pub operation: Operation,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "present_hold"
    )]
    pub hold_id: Option<String>,
}
fn present_hold<'de, D: serde::Deserializer<'de>>(
    value: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(value).map(Some)
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Hold,
    Inspect,
    Seal,
    Cancel,
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        model::uuid(&self.exchange_id)?;
        model::uuid(&self.transfer_id)?;
        model::uuid(&self.source_epoch)?;
        if self.version != model::VERSION
            || !(1..=MAX_COUNT).contains(&self.revision)
            || (self.operation == Operation::Hold) != self.hold_id.is_none()
        {
            bail!("HANDOFF_INVALID_EXCHANGE");
        }
        if let Some(id) = &self.hold_id {
            model::uuid(id)?;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notification {
    pub version: u32,
    pub profile_id: String,
    pub request: Request,
}
impl Notification {
    pub fn validate(&self) -> Result<()> {
        if self.version != model::VERSION {
            bail!("HANDOFF_INVALID_EXCHANGE");
        }
        model::hash(&self.profile_id)?;
        self.request.validate()?;
        model::encode(self)?;
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub version: u32,
    pub exchange_id: String,
    pub transfer_id: String,
    pub source_epoch: String,
    pub revision: u64,
    pub hold_id: String,
    pub state: State,
    pub counts: BTreeMap<String, u64>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Held,
    Sealed,
    Cancelled,
}
impl Report {
    fn validate(&self, request: &Request) -> Result<()> {
        model::uuid(&self.hold_id)?;
        if self.version != model::VERSION
            || self.exchange_id != request.exchange_id
            || self.transfer_id != request.transfer_id
            || self.source_epoch != request.source_epoch
            || self.revision != request.revision
            || request
                .hold_id
                .as_ref()
                .is_some_and(|id| id != &self.hold_id)
            || self.counts.len() != COUNTS.len()
            || COUNTS
                .iter()
                .any(|key| self.counts.get(*key).is_none_or(|value| *value > MAX_COUNT))
            || match request.operation {
                Operation::Hold => self.state != State::Held,
                Operation::Seal => self.state != State::Sealed,
                Operation::Cancel => self.state != State::Cancelled,
                Operation::Inspect => false,
            }
            || (matches!(request.operation, Operation::Hold | Operation::Seal)
                && self.counts.values().any(|value| *value != 0))
        {
            bail!("HANDOFF_INVALID_COMPLETION");
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged, deny_unknown_fields)]
pub enum Outcome {
    Success { report: Report },
    Refusal { error: Failure },
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub code: Code,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Code {
    #[serde(rename = "HANDOFF_BUSY")]
    Busy,
    #[serde(rename = "HANDOFF_OWNER_CHANGED")]
    OwnerChanged,
    #[serde(rename = "HANDOFF_UNAVAILABLE")]
    Unavailable,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Completion {
    pub version: u32,
    pub profile_id: String,
    pub request: Request,
    pub outcome: Outcome,
}
impl Completion {
    pub fn validate(&self, expected: &Notification) -> Result<()> {
        expected.validate()?;
        model::encode(self)?;
        if self.version != model::VERSION
            || self.profile_id != expected.profile_id
            || self.request != expected.request
        {
            bail!("HANDOFF_INVALID_COMPLETION");
        }
        if let Outcome::Success { report } = &self.outcome {
            report.validate(&expected.request)?;
        }
        Ok(())
    }
}
