//! Controller behaviour against a real SQLite journal. Only the native/stdio
//! boundary is substituted: `Probe` records what the controller observed when
//! each external effect ran, while every durable claim is read back from the
//! committed journal the controller writes through its own port.
//!
//! The acceptance order under test: Desktop `hold` while Rust admission is
//! still open -> Rust closes -> idle -> durable `prepared`; then
//! `source_fencing` is visible to `seal` and `stop` -> `source_fenced` plus the
//! exact generation close commit together; then `release_pending` is durable
//! before the release signal.
use super::{Command, Controller, Ports};
use crate::{
    db::{Database, SCHEMA_VERSION},
    owner_handoff::{
        activity::{Activity, Ingress},
        exchange_protocol::{self as exchange, Code, Failure, Operation, Outcome, Report, State},
        model::{self, Build, Generation, Owner, Phase, ProcessIdentity, Transfer, VERSION},
        repository::Journal,
    },
};
use anyhow::{anyhow, Result};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tempfile::TempDir;

/// Same count keys the production completion contract requires; the report
/// shape is validated by the Desktop coordinator, not by the controller.
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

/// One external effect and the state the controller must have exposed when it
/// ran. `admitted` asks whether Rust would still accept a new request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Observed {
    Hold {
        admitted: bool,
    },
    Seal {
        durable: Option<Phase>,
    },
    Cancel {
        durable: Option<Phase>,
        admitted: bool,
    },
    Idle {
        admitted: bool,
        durable: Option<Phase>,
    },
    Stop {
        durable: Option<Phase>,
    },
    Release {
        durable: Option<Phase>,
    },
}

#[derive(Default)]
struct Faults {
    busy_holds: AtomicUsize,
    unavailable_holds: AtomicUsize,
    unavailable_seals: AtomicUsize,
    idle_failures: AtomicUsize,
    stop_failures: AtomicUsize,
}

/// Consume one injected failure; `false` once the fixture's budget is spent.
fn take(counter: &AtomicUsize) -> bool {
    let mut left = counter.load(Ordering::SeqCst);
    while let Some(next) = left.checked_sub(1) {
        match counter.compare_exchange_weak(left, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return true,
            Err(current) => left = current,
        }
    }
    false
}

/// A read-only admission probe that leaves no reservation behind.
fn admitted(activity: &Activity) -> bool {
    match activity.admit(Ingress::Request) {
        Ok(obligation) => {
            obligation.finish(true);
            true
        }
        Err(_) => false,
    }
}

struct Inner {
    owner: Owner,
    generation: String,
    root: ProcessIdentity,
    transfer: String,
    activity: Activity,
    journal: Arc<Mutex<Journal>>,
    events: Mutex<Vec<Observed>>,
    held: Mutex<Option<String>>,
    faults: Faults,
}

/// Immutable ports: every field is shared, so the controller can never be
/// handed a different journal, owner or admission gate mid-transfer.
#[derive(Clone)]
struct Probe(Arc<Inner>);

impl Probe {
    fn observed(&self) -> Vec<Observed> {
        self.0
            .events
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    fn record(&self, event: Observed) {
        self.0
            .events
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .push(event);
    }

    fn recorded(&self, wanted: fn(&Observed) -> bool) -> usize {
        self.observed().iter().filter(|event| wanted(event)).count()
    }

    fn effects(&self) -> usize {
        self.recorded(|event| {
            matches!(
                event,
                Observed::Hold { .. } | Observed::Seal { .. } | Observed::Cancel { .. }
            )
        })
    }

    fn admitted(&self) -> bool {
        admitted(&self.0.activity)
    }

    fn durable(&self) -> Option<Transfer> {
        let journal = self
            .0
            .journal
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        journal.transfer(&self.0.transfer).ok()
    }

    fn phase(&self) -> Option<Phase> {
        self.durable().map(|record| record.phase)
    }

    fn receipt(&self, principal: &str, command: &Command) -> Option<Transfer> {
        let journal = self
            .0
            .journal
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        journal.source_receipt(principal, command).ok().flatten()
    }

    /// Uses the public inspection surface so a closed column is read exactly
    /// the way the recovery path reads it.
    fn generation_open(&self) -> bool {
        let journal = self
            .0
            .journal
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        journal
            .inspect_generation(&self.0.owner, &self.0.generation, Some(&self.0.root))
            .is_ok()
    }

    fn sql(&self, statement: &str) {
        let journal = self
            .0
            .journal
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        journal.conn.execute_batch(statement).unwrap();
    }

    fn refusal(code: Code) -> Outcome {
        Outcome::Refusal {
            error: Failure { code },
        }
    }

    fn report(&self, request: &exchange::Request, state: State, hold: String) -> Report {
        Report {
            version: VERSION,
            exchange_id: request.exchange_id.clone(),
            transfer_id: request.transfer_id.clone(),
            source_epoch: request.source_epoch.clone(),
            revision: request.revision,
            hold_id: hold,
            state,
            counts: COUNTS
                .iter()
                .map(|key| ((*key).to_owned(), 0_u64))
                .collect(),
        }
    }

    /// Emulates the coordinator's accepted half of the frozen exchange
    /// contract: exact operation, exact hold id, zero counts on hold/seal.
    fn answer(&self, request: exchange::Request) -> Outcome {
        assert!(
            request.validate().is_ok(),
            "controller sent an invalid exchange request"
        );
        assert_eq!(request.version, VERSION);
        if request.operation == Operation::Hold {
            assert!(request.hold_id.is_none());
            self.record(Observed::Hold {
                admitted: admitted(&self.0.activity),
            });
            if take(&self.0.faults.busy_holds) {
                return Self::refusal(Code::Busy);
            }
            if take(&self.0.faults.unavailable_holds) {
                return Self::refusal(Code::Unavailable);
            }
            let hold = uuid();
            *self
                .0
                .held
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(hold.clone());
            return Outcome::Success {
                report: self.report(&request, State::Held, hold),
            };
        }
        let held = self
            .0
            .held
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        assert_eq!(
            request.hold_id, held,
            "a non-hold exchange must reuse the Desktop hold id"
        );
        let hold = held.expect("hold id from the accepted hold exchange");
        let durable = self.phase();
        match request.operation {
            Operation::Seal => {
                self.record(Observed::Seal { durable });
                if take(&self.0.faults.unavailable_seals) {
                    return Self::refusal(Code::Unavailable);
                }
                Outcome::Success {
                    report: self.report(&request, State::Sealed, hold),
                }
            }
            Operation::Cancel => {
                self.record(Observed::Cancel {
                    durable,
                    admitted: admitted(&self.0.activity),
                });
                Outcome::Success {
                    report: self.report(&request, State::Cancelled, hold),
                }
            }
            Operation::Inspect => Outcome::Success {
                report: self.report(&request, State::Held, hold),
            },
            Operation::Hold => unreachable!("handled above"),
        }
    }
}

impl Ports for Probe {
    fn owner(&self) -> &Owner {
        &self.0.owner
    }

    fn generation(&self) -> &str {
        &self.0.generation
    }

    fn activity(&self) -> &Activity {
        &self.0.activity
    }

    fn journal(&self) -> Arc<Mutex<Journal>> {
        self.0.journal.clone()
    }

    async fn check(&self) -> Result<()> {
        Ok(())
    }

    async fn idle(&self) -> Result<()> {
        self.record(Observed::Idle {
            admitted: admitted(&self.0.activity),
            durable: self.phase(),
        });
        if take(&self.0.faults.idle_failures) {
            return Err(anyhow!("HANDOFF_BUSY"));
        }
        Ok(())
    }

    async fn exchange(&self, request: exchange::Request) -> Result<Outcome> {
        Ok(self.answer(request))
    }

    async fn stop(&self) -> Result<()> {
        self.record(Observed::Stop {
            durable: self.phase(),
        });
        if take(&self.0.faults.stop_failures) {
            return Err(anyhow!("HANDOFF_STOP_UNCONFIRMED"));
        }
        Ok(())
    }

    async fn release(&self) -> Result<()> {
        self.record(Observed::Release {
            durable: self.phase(),
        });
        Ok(())
    }
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn digest(seed: &[u8]) -> String {
    model::digest(seed)
}

fn process(pid: u32, sid: &str) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        created_at: "134115649234567891".into(),
        sid: sid.into(),
        image: "C:\\fixture\\host.exe".into(),
    }
}

fn owner(epoch: String, sid: &str) -> Owner {
    Owner {
        version: VERSION,
        epoch,
        profile: digest(b"fixture profile"),
        host: process(11, sid),
        coordinator: process(12, sid),
    }
}

fn generation(owner: &Owner) -> Generation {
    let id = uuid();
    Generation {
        version: VERSION,
        job_name: Generation::job_name(&owner.profile, &owner.epoch, &id),
        id,
        owner_epoch: owner.epoch.clone(),
        profile: owner.profile.clone(),
        root: None,
    }
}

fn build(seed: &[u8]) -> Build {
    Build {
        sha256: digest(seed),
        schema: SCHEMA_VERSION as u32,
        protocol: VERSION,
    }
}

fn revision(record: &Transfer) -> u64 {
    u64::try_from(record.revision).unwrap()
}

struct Fixture {
    _directory: TempDir,
    probe: Probe,
    build: Build,
    transfer: String,
    target: String,
    requester: ProcessIdentity,
}

impl Fixture {
    fn prepare(&self, request_id: &str) -> Command {
        self.prepare_with(request_id, &self.transfer, &self.build)
    }

    fn prepare_with(&self, request_id: &str, transfer: &str, target_build: &Build) -> Command {
        Command::Prepare {
            version: VERSION,
            request_id: request_id.into(),
            source_epoch: self.probe.0.owner.epoch.clone(),
            transfer_id: transfer.into(),
            expected_revision: 0,
            target_epoch: self.target.clone(),
            capability_hash: digest(b"private fixture capability"),
            target_build: target_build.clone(),
        }
    }

    fn fence(&self, request_id: &str, expected_revision: u64) -> Command {
        Command::Fence {
            version: VERSION,
            request_id: request_id.into(),
            source_epoch: self.probe.0.owner.epoch.clone(),
            transfer_id: self.transfer.clone(),
            expected_revision,
        }
    }

    fn cancel(&self, request_id: &str, expected_revision: u64) -> Command {
        Command::Cancel {
            version: VERSION,
            request_id: request_id.into(),
            source_epoch: self.probe.0.owner.epoch.clone(),
            transfer_id: self.transfer.clone(),
            expected_revision,
        }
    }

    fn release(&self, request_id: &str, expected_revision: u64) -> Command {
        Command::Release {
            version: VERSION,
            request_id: request_id.into(),
            source_epoch: self.probe.0.owner.epoch.clone(),
            transfer_id: self.transfer.clone(),
            expected_revision,
        }
    }

    fn controller(&self) -> Controller<Probe> {
        Controller::new(self.probe.clone(), self.build.clone())
    }

    /// Register, bind a root and close nothing: a fresh original owner with one
    /// exact generation, which `ConfirmFenced` requires.
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        drop(Database::open_in_dir(directory.path()).unwrap());
        let mut journal = Journal::open(&directory.path().join("pi.sqlite"), false).unwrap();
        let owner = owner(uuid(), "S-1-5-21-1234");
        let root = process(13, &owner.host.sid);
        let registered = generation(&owner);
        journal.register_owner(&owner).unwrap();
        journal.register_generation(&registered).unwrap();
        journal.bind_root(&registered.id, &root).unwrap();
        let transfer = uuid();
        let probe = Probe(Arc::new(Inner {
            owner: owner.clone(),
            generation: registered.id,
            root,
            transfer: transfer.clone(),
            activity: Activity::default(),
            journal: Arc::new(Mutex::new(journal)),
            events: Mutex::new(Vec::new()),
            held: Mutex::new(None),
            faults: Faults::default(),
        }));
        Self {
            _directory: directory,
            probe,
            build: build(b"fixture build"),
            transfer,
            target: uuid(),
            requester: owner.host,
        }
    }
}

#[tokio::test]
async fn prepare_takes_the_desktop_hold_while_admission_is_open_and_journals_after_idle() {
    let fixture = Fixture::new();
    let mut controller = fixture.controller();
    let prepare = fixture.prepare(&uuid());
    let record = controller
        .execute(&prepare, &fixture.requester)
        .await
        .unwrap();
    assert_eq!(record.id, fixture.transfer);
    assert_eq!((record.phase, record.revision), (Phase::Prepared, 1));
    assert_eq!(record.requester, fixture.requester);
    assert_eq!(record.source_epoch, fixture.probe.0.owner.epoch);
    assert_eq!(record.target_build, fixture.build);
    assert_eq!(
        fixture.probe.observed(),
        vec![
            // Desktop admitted the hold while Rust would still have accepted
            // new work.
            Observed::Hold { admitted: true },
            // Rust had already closed ingress and nothing was durable yet.
            Observed::Idle {
                admitted: false,
                durable: None,
            },
        ]
    );
    assert_eq!(fixture.probe.durable(), Some(record.clone()));
    assert_eq!(
        fixture.probe.receipt(&fixture.requester.sid, &prepare),
        Some(record)
    );
    assert!(fixture.probe.generation_open());
    assert!(!fixture.probe.admitted());
}

#[tokio::test]
async fn fence_reports_fencing_to_seal_and_stop_and_commits_the_generation_close_together() {
    let fixture = Fixture::new();
    let mut controller = fixture.controller();
    let prepare = fixture.prepare(&uuid());
    let prepared = controller
        .execute(&prepare, &fixture.requester)
        .await
        .unwrap();
    let fence = fixture.fence(&uuid(), revision(&prepared));
    let fenced = controller
        .execute(&fence, &fixture.requester)
        .await
        .unwrap();
    assert_eq!((fenced.phase, fenced.revision), (Phase::SourceFenced, 3));
    assert_eq!(
        fixture.probe.observed(),
        vec![
            Observed::Hold { admitted: true },
            Observed::Idle {
                admitted: false,
                durable: None,
            },
            Observed::Idle {
                admitted: false,
                durable: Some(Phase::SourceFencing),
            },
            Observed::Seal {
                durable: Some(Phase::SourceFencing),
            },
            Observed::Stop {
                durable: Some(Phase::SourceFencing),
            },
        ]
    );
    assert_eq!(fixture.probe.phase(), Some(Phase::SourceFenced));
    assert!(!fixture.probe.generation_open());
    // An accepted fence receipt ends the request without another effect.
    assert_eq!(
        controller
            .execute(&fence, &fixture.requester)
            .await
            .unwrap(),
        fenced
    );
    assert_eq!(fixture.probe.observed().len(), 5);
}

#[tokio::test]
async fn release_is_durable_before_the_signal_and_replays_without_new_steps() {
    let fixture = Fixture::new();
    let mut controller = fixture.controller();
    let prepared = controller
        .execute(&fixture.prepare(&uuid()), &fixture.requester)
        .await
        .unwrap();
    let fenced = controller
        .execute(
            &fixture.fence(&uuid(), revision(&prepared)),
            &fixture.requester,
        )
        .await
        .unwrap();
    let release = fixture.release(&uuid(), revision(&fenced));
    let pending = controller
        .execute(&release, &fixture.requester)
        .await
        .unwrap();
    assert_eq!(
        (pending.phase, pending.revision),
        (Phase::ReleasePending, 4)
    );
    assert_eq!(
        fixture.probe.observed().last(),
        Some(&Observed::Release {
            durable: Some(Phase::ReleasePending),
        })
    );
    // The receipt ends the step; the release signal is a retained watch and is
    // legally re-issued for the same accepted request.
    assert_eq!(
        controller
            .execute(&release, &fixture.requester)
            .await
            .unwrap(),
        pending
    );
    assert_eq!(fixture.probe.phase(), Some(Phase::ReleasePending));
    assert_eq!(fixture.probe.durable().unwrap().revision, 4);
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Release { .. })),
        2
    );
    assert_eq!(fixture.probe.effects(), 2);
}

#[tokio::test]
async fn cancel_commits_cancelled_before_reopening_and_confirming_with_desktop() {
    let fixture = Fixture::new();
    let mut controller = fixture.controller();
    let prepared = controller
        .execute(&fixture.prepare(&uuid()), &fixture.requester)
        .await
        .unwrap();
    let cancel = fixture.cancel(&uuid(), revision(&prepared));
    let cancelled = controller
        .execute(&cancel, &fixture.requester)
        .await
        .unwrap();
    assert_eq!((cancelled.phase, cancelled.revision), (Phase::Cancelled, 2));
    // Durable cancellation and the reopened Rust gate are both observable when
    // the Desktop completion runs.
    assert_eq!(
        fixture.probe.observed().last(),
        Some(&Observed::Cancel {
            durable: Some(Phase::Cancelled),
            admitted: true,
        })
    );
    assert!(fixture.probe.admitted());
    assert_eq!(fixture.probe.effects(), 2);
    assert_eq!(
        controller
            .execute(&cancel, &fixture.requester)
            .await
            .unwrap(),
        cancelled
    );
    assert_eq!(fixture.probe.effects(), 2);
}

#[tokio::test]
async fn replays_and_restart_serve_receipts_without_repeating_external_effects() {
    let fixture = Fixture::new();
    let mut controller = fixture.controller();
    let prepare = fixture.prepare(&uuid());
    let prepared = controller
        .execute(&prepare, &fixture.requester)
        .await
        .unwrap();
    let fence = fixture.fence(&uuid(), revision(&prepared));
    let fenced = controller
        .execute(&fence, &fixture.requester)
        .await
        .unwrap();
    let release = fixture.release(&uuid(), revision(&fenced));
    let pending = controller
        .execute(&release, &fixture.requester)
        .await
        .unwrap();
    assert_eq!(fixture.probe.observed().len(), 6);

    // Historical receipts answer with the first accepted record and never
    // rerun the step they once advanced.
    assert_eq!(
        controller
            .execute(&prepare, &fixture.requester)
            .await
            .unwrap(),
        prepared
    );
    assert_eq!(
        controller
            .execute(&fence, &fixture.requester)
            .await
            .unwrap(),
        fenced
    );
    assert_eq!(fixture.probe.observed().len(), 6);
    assert_eq!(prepared.requester, fixture.requester);
    assert_eq!(
        fixture.probe.receipt(&fixture.requester.sid, &prepare),
        Some(prepared.clone())
    );
    assert_eq!(
        fixture.probe.receipt(&fixture.requester.sid, &fence),
        Some(fenced.clone())
    );
    assert_eq!(fixture.probe.durable(), Some(pending.clone()));

    // A restarted controller trusts the same receipts and touches no native or
    // Desktop resource again.
    let mut restarted = fixture.controller();
    assert_eq!(
        restarted
            .execute(&prepare, &fixture.requester)
            .await
            .unwrap(),
        prepared
    );
    assert_eq!(
        restarted.execute(&fence, &fixture.requester).await.unwrap(),
        fenced
    );
    assert_eq!(
        restarted
            .execute(&release, &fixture.requester)
            .await
            .unwrap(),
        pending
    );
    assert_eq!(fixture.probe.effects(), 2);
    assert_eq!(
        fixture
            .probe
            .recorded(|event| matches!(event, Observed::Stop { .. })),
        1
    );
    assert_eq!(fixture.probe.observed().len(), 7);

    // A fresh fence request cannot rewind a released transfer and sends
    // nothing.
    let rewind = fixture.fence(&uuid(), revision(&pending));
    assert_eq!(
        controller
            .execute(&rewind, &fixture.requester)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_INVALID_TRANSITION"
    );
    assert_eq!(fixture.probe.observed().len(), 7);
    assert_eq!(fixture.probe.phase(), Some(Phase::ReleasePending));
}

#[tokio::test]
async fn mismatched_authority_build_drift_busy_and_conflict_refuse_before_any_effect() {
    let fixture = Fixture::new();
    let mut controller = fixture.controller();
    let foreign = process(21, "S-1-5-21-999");
    assert_eq!(
        controller
            .execute(&fixture.prepare(&uuid()), &foreign)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_OWNER_CHANGED"
    );
    let mut wrong_epoch = fixture.prepare(&uuid());
    if let Command::Prepare { source_epoch, .. } = &mut wrong_epoch {
        *source_epoch = uuid();
    }
    assert_eq!(
        controller
            .execute(&wrong_epoch, &fixture.requester)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_OWNER_CHANGED"
    );
    let drifted = fixture.prepare_with(&uuid(), &uuid(), &build(b"other build"));
    assert_eq!(
        controller
            .execute(&drifted, &fixture.requester)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_INCOMPATIBLE_BUILD"
    );
    assert_eq!(fixture.probe.effects(), 0);
    assert_eq!(fixture.probe.durable(), None);

    let accepted = fixture.prepare(&uuid());
    let prepared = controller
        .execute(&accepted, &fixture.requester)
        .await
        .unwrap();
    assert_eq!(fixture.probe.effects(), 1);
    // A second transfer while one is retained is BUSY, not a second hold.
    let second = fixture.prepare_with(&uuid(), &uuid(), &fixture.build);
    assert_ne!(second.transfer_id(), Some(fixture.transfer.as_str()));
    assert_eq!(
        controller
            .execute(&second, &fixture.requester)
            .await
            .unwrap_err()
            .to_string(),
        "HANDOFF_BUSY"
    );
    // The same request id with a different body conflicts on its receipt.
    if let Command::Prepare {
        request_id,
        transfer_id,
        ..
    } = accepted
    {
        let conflict = fixture.prepare_with(&request_id, &uuid(), &fixture.build);
        assert_ne!(conflict.transfer_id(), Some(transfer_id.as_str()));
        assert_eq!(
            controller
                .execute(&conflict, &fixture.requester)
                .await
                .unwrap_err()
                .to_string(),
            "HANDOFF_REQUEST_CONFLICT"
        );
    }
    assert_eq!(fixture.probe.effects(), 1);
    assert_eq!(fixture.probe.phase(), Some(Phase::Prepared));
    assert_eq!(fixture.probe.durable(), Some(prepared));
}

mod recovery;
