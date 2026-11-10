//! Original-source orchestration. External effects live behind an immutable
//! port; SQLite receipts and admission capabilities stay owned across awaits.
use super::{journal::Step, protocol::Command};
use crate::owner_handoff::{
    activity::{Activity, Hold, Kind},
    exchange_protocol::{self as exchange, Operation, Outcome},
    model::{Build, Owner, Phase, ProcessIdentity, Transfer, VERSION},
    repository::Journal,
};
use anyhow::{anyhow, bail, Result};
use std::{
    future::Future,
    sync::{Arc, Mutex},
};

pub(super) trait Ports: Send + Sync + 'static {
    fn owner(&self) -> &Owner;
    fn generation(&self) -> &str;
    fn activity(&self) -> &Activity;
    fn journal(&self) -> Arc<Mutex<Journal>>;
    fn check(&self) -> impl Future<Output = Result<()>> + Send;
    fn idle(&self) -> impl Future<Output = Result<()>> + Send;
    fn exchange(&self, request: exchange::Request) -> impl Future<Output = Result<Outcome>> + Send;
    fn stop(&self) -> impl Future<Output = Result<()>> + Send;
    fn release(&self) -> impl Future<Output = Result<()>> + Send;
}
struct Entry {
    command: Command,
    record: Transfer,
    desktop: Option<String>,
    rust: Option<Hold>,
    rust_sealed: bool,
    desktop_sealed: bool,
    reopened: bool,
    cancelled: bool,
}
pub(super) struct Controller<P: Ports> {
    ports: P,
    build: Build,
    entry: Option<Entry>,
}
impl<P: Ports> Controller<P> {
    pub fn new(ports: P, build: Build) -> Self {
        Self {
            ports,
            build,
            entry: None,
        }
    }
    pub fn can_replace(&self) -> bool {
        self.entry.as_ref().is_none_or(|entry| entry.cancelled)
    }
    async fn journal<T: Send + 'static>(
        &self,
        write: bool,
        action: impl FnOnce(&mut Journal) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let journal = self.ports.journal();
        let obligation = write.then(|| self.ports.activity().begin(Kind::Write));
        tokio::task::spawn_blocking(move || {
            let result = journal
                .lock()
                .map_err(|_| anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))
                .and_then(|mut journal| action(&mut journal));
            // Returning an error still settles this write; the retained entry
            // and next receipt read decide whether its durable outcome is known.
            if let Some(obligation) = obligation {
                obligation.finish(true);
            }
            result
        })
        .await
        .map_err(|_| anyhow!("HANDOFF_JOURNAL_UNAVAILABLE"))?
    }
    async fn receipt(&self, principal: &str, command: &Command) -> Result<Option<Transfer>> {
        let principal = principal.to_owned();
        let command = command.clone();
        self.journal(false, move |journal| {
            journal.source_receipt(&principal, &command)
        })
        .await
    }
    async fn step(&self, principal: &str, command: &Command, step: Step) -> Result<Transfer> {
        self.ports.check().await?;
        let principal = principal.to_owned();
        let command = command.clone();
        let record = self
            .journal(true, move |journal| {
                journal.source_step(&principal, &command, step)
            })
            .await?;
        self.ports.check().await?;
        Ok(record)
    }
    async fn desktop(&self, operation: Operation) -> Result<exchange::Report> {
        let entry = self
            .entry
            .as_ref()
            .ok_or_else(|| anyhow!("HANDOFF_INVALID_TRANSITION"))?;
        self.ports.check().await?;
        let outcome = self
            .ports
            .exchange(exchange::Request {
                version: VERSION,
                exchange_id: uuid::Uuid::new_v4().to_string(),
                transfer_id: entry.record.id.clone(),
                source_epoch: entry.record.source_epoch.clone(),
                revision: 1,
                operation,
                hold_id: if operation == Operation::Hold {
                    None
                } else {
                    entry.desktop.clone()
                },
            })
            .await?;
        self.ports.check().await?;
        match outcome {
            Outcome::Success { report } => Ok(report),
            Outcome::Refusal { error } => match error.code {
                exchange::Code::Busy => bail!("HANDOFF_BUSY"),
                exchange::Code::OwnerChanged => bail!("HANDOFF_OWNER_CHANGED"),
                exchange::Code::Unavailable => bail!("HANDOFF_UNAVAILABLE"),
            },
        }
    }
    pub async fn execute(
        &mut self,
        command: &Command,
        requester: &ProcessIdentity,
    ) -> Result<Transfer> {
        command.validate()?;
        requester.validate()?;
        self.ports.check().await?;
        if command.identity().2 != self.ports.owner().epoch
            || requester.sid != self.ports.owner().host.sid
        {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        let receipt = self.receipt(&requester.sid, command).await?;
        self.ports.check().await?;
        if let Some(record) = &receipt {
            if command.expected_phase() == Some(record.phase) {
                if matches!(command, Command::Cancel { .. }) {
                    self.finish_cancel(record).await?;
                } else if matches!(command, Command::Release { .. }) {
                    self.ports.release().await?;
                }
                return Ok(record.clone());
            }
        }
        match command {
            Command::Prepare { .. } => self.prepare(command, requester).await,
            Command::Cancel { .. } => {
                self.require_entry(command)?;
                let entry = self
                    .entry
                    .as_ref()
                    .ok_or_else(|| anyhow!("HANDOFF_CANCEL_UNCONFIRMED"))?;
                if entry.rust_sealed
                    || entry.desktop_sealed
                    || entry.rust.is_none()
                    || entry.desktop.is_none()
                {
                    bail!("HANDOFF_CANCEL_UNCONFIRMED");
                }
                let step = if self
                    .receipt(&requester.sid, &entry.command)
                    .await?
                    .is_some()
                {
                    Step::Cancel
                } else {
                    Step::CancelPending(entry.record.clone())
                };
                let record = self.step(&requester.sid, command, step).await?;
                self.finish_cancel(&record).await?;
                Ok(record)
            }
            Command::Fence { .. } => self.fence(command, &requester.sid).await,
            Command::Release { .. } => {
                self.require_entry(command)?;
                let record = self.step(&requester.sid, command, Step::Release).await?;
                self.ports.release().await?;
                Ok(record)
            }
            _ => bail!("HANDOFF_INVALID_REQUEST"),
        }
    }
    fn require_entry(&self, command: &Command) -> Result<()> {
        let entry = self
            .entry
            .as_ref()
            .ok_or_else(|| anyhow!("HANDOFF_INVALID_TRANSITION"))?;
        if command.transfer_id() != Some(entry.record.id.as_str()) || entry.cancelled {
            bail!("HANDOFF_INVALID_TRANSITION");
        }
        Ok(())
    }
    async fn prepare(
        &mut self,
        command: &Command,
        requester: &ProcessIdentity,
    ) -> Result<Transfer> {
        let Command::Prepare {
            transfer_id,
            source_epoch,
            target_epoch,
            capability_hash,
            target_build,
            ..
        } = command
        else {
            bail!("HANDOFF_INVALID_REQUEST");
        };
        if *target_build != self.build {
            bail!("HANDOFF_INCOMPATIBLE_BUILD");
        }
        let id = transfer_id.clone();
        if self
            .journal(false, move |journal| journal.find_transfer(&id))
            .await?
            .is_some()
        {
            bail!("HANDOFF_INVALID_TRANSITION");
        }
        if self.entry.as_ref().is_some_and(|entry| entry.cancelled) {
            self.entry = None;
        }
        if let Some(entry) = &self.entry {
            if super::journal::fingerprint(&entry.command)? != super::journal::fingerprint(command)?
            {
                bail!("HANDOFF_BUSY");
            }
        } else {
            self.entry = Some(Entry {
                command: command.clone(),
                record: Transfer {
                    version: VERSION,
                    id: transfer_id.clone(),
                    profile: self.ports.owner().profile.clone(),
                    source_epoch: source_epoch.clone(),
                    target_epoch: target_epoch.clone(),
                    source_build: self.build.clone(),
                    target_build: target_build.clone(),
                    requester: requester.clone(),
                    capability_hash: capability_hash.clone(),
                    revision: 1,
                    phase: Phase::Prepared,
                    recovery_attempt: 0,
                    last_failure: None,
                },
                desktop: None,
                rust: None,
                rust_sealed: false,
                desktop_sealed: false,
                reopened: false,
                cancelled: false,
            });
        }
        if self
            .entry
            .as_ref()
            .is_some_and(|entry| entry.desktop.is_none())
        {
            match self.desktop(Operation::Hold).await {
                Ok(report) => {
                    self.entry
                        .as_mut()
                        .ok_or_else(|| anyhow!("HANDOFF_UNAVAILABLE"))?
                        .desktop = Some(report.hold_id)
                }
                Err(error)
                    if error.to_string() == "HANDOFF_BUSY"
                        && self
                            .entry
                            .as_ref()
                            .is_some_and(|entry| entry.rust.is_none()) =>
                {
                    // The coordinator reserves this refusal for a confirmed
                    // no-hold result. Ambiguous holds use UNAVAILABLE instead.
                    self.entry = None;
                    return Err(error);
                }
                Err(error) => {
                    let entry = self
                        .entry
                        .as_mut()
                        .ok_or_else(|| anyhow!("HANDOFF_UNAVAILABLE"))?;
                    if entry.rust.is_none() {
                        // Uncertainty closes ingress without discarding the
                        // capability needed for later durable cancellation.
                        match self.ports.activity().hold() {
                            Ok(hold) => entry.rust = Some(hold),
                            Err(_) => self.ports.activity().close(),
                        }
                    }
                    if error.to_string() == "HANDOFF_BUSY" {
                        bail!("HANDOFF_UNAVAILABLE");
                    }
                    return Err(error);
                }
            }
        }
        let entry = self
            .entry
            .as_mut()
            .ok_or_else(|| anyhow!("HANDOFF_UNAVAILABLE"))?;
        if entry.rust.is_none() {
            entry.rust = Some(
                self.ports
                    .activity()
                    .hold()
                    .map_err(|_| anyhow!("HANDOFF_UNAVAILABLE"))?,
            );
        }
        // Desktop's admitted persistence settles before Rust closes ingress.
        // Completion RPC accounting may still be finishing at this point.
        self.ports.idle().await?;
        let record = self
            .entry
            .as_ref()
            .ok_or_else(|| anyhow!("HANDOFF_UNAVAILABLE"))?
            .record
            .clone();
        self.step(&requester.sid, command, Step::Prepare(record))
            .await
    }
    async fn finish_cancel(&mut self, record: &Transfer) -> Result<()> {
        let Some(entry) = self
            .entry
            .as_mut()
            .filter(|entry| entry.record.id == record.id)
        else {
            return Ok(());
        };
        if entry.cancelled {
            return Ok(());
        }
        if record.phase != Phase::Cancelled || entry.rust_sealed || entry.desktop_sealed {
            bail!("HANDOFF_CANCEL_UNCONFIRMED");
        }
        if !entry.reopened {
            entry
                .rust
                .take()
                .ok_or_else(|| anyhow!("HANDOFF_CANCEL_UNCONFIRMED"))?
                .reopen()
                .map_err(|_| anyhow!("HANDOFF_CANCEL_UNCONFIRMED"))?;
            entry.reopened = true;
        }
        // Rust opens first; Desktop's completion opens its gate only after it
        // independently reads the original source's durable cancellation.
        self.desktop(Operation::Cancel)
            .await
            .map_err(|_| anyhow!("HANDOFF_CANCEL_UNCONFIRMED"))?;
        self.entry
            .as_mut()
            .ok_or_else(|| anyhow!("HANDOFF_CANCEL_UNCONFIRMED"))?
            .cancelled = true;
        Ok(())
    }
    async fn fence(&mut self, command: &Command, principal: &str) -> Result<Transfer> {
        self.require_entry(command)?;
        let record = self.step(principal, command, Step::BeginFencing).await?;
        if record.phase == Phase::SourceFenced {
            return Ok(record);
        }
        let fenced = self.fence_resources().await;
        if let Err(error) = fenced {
            self.step(
                principal,
                command,
                Step::FenceFailure("HANDOFF_FENCE_UNCONFIRMED".into()),
            )
            .await?;
            tracing::warn!(%error, "original source fencing remains unconfirmed");
            bail!("HANDOFF_FENCE_UNCONFIRMED");
        }
        self.step(
            principal,
            command,
            Step::ConfirmFenced {
                generation: self.ports.generation().into(),
            },
        )
        .await
    }
    async fn fence_resources(&mut self) -> Result<()> {
        let entry = self
            .entry
            .as_mut()
            .ok_or_else(|| anyhow!("HANDOFF_INVALID_TRANSITION"))?;
        if !entry.rust_sealed {
            entry
                .rust
                .as_ref()
                .ok_or_else(|| anyhow!("HANDOFF_UNAVAILABLE"))?
                .seal()
                .map_err(|_| anyhow!("HANDOFF_UNAVAILABLE"))?;
            entry.rust_sealed = true;
        }
        if !entry.desktop_sealed {
            self.ports.idle().await?;
            self.desktop(Operation::Seal).await?;
            self.entry
                .as_mut()
                .ok_or_else(|| anyhow!("HANDOFF_UNAVAILABLE"))?
                .desktop_sealed = true;
        }
        // After this point only the retained native owner is used: never send
        // another Sidecar RPC after terminating the original generation.
        self.ports.stop().await
    }
}

#[cfg(test)]
mod tests;
