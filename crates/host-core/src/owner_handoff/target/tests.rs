use super::*;
use crate::data_directory_owner::DataDirectoryOwner;
use crate::owner_handoff::{
    activity::{Activity, Hold, Ingress, Snapshot},
    model::{self, Build, Generation, Owner, Phase, ProcessIdentity, Transfer, VERSION},
    repository::Journal,
    service::ContextIdentity,
    startup::NativeProof,
    transitions::{Mutation, Request},
};
use anyhow::{bail, Result};
use rusqlite::params;
use serde_json::{json, Value};
use std::cell::Cell;
use std::sync::Arc;

mod argv_tests;
mod bootstrap_tests;
mod entry_tests;
mod ready_resources_tests;
mod ready_tests;
// These two suites exercise the real Windows Job/pipe root join and the framed
// serving gate, so they only exist where those native APIs do.
#[cfg(windows)]
mod root_join_tests;
#[cfg(windows)]
mod serving_tests;

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn process(pid: u32) -> ProcessIdentity {
    process_with_sid(pid, "S-1-5-21-1234")
}
fn process_with_sid(pid: u32, sid: &str) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        created_at: format!("1341156492345678{pid:02}"),
        sid: sid.into(),
        image: "C:\\fixture\\target-host.exe".into(),
    }
}
fn generation(owner: &Owner) -> Generation {
    let id = id();
    Generation {
        version: VERSION,
        job_name: Generation::job_name(&owner.profile, &owner.epoch, &id),
        id,
        owner_epoch: owner.epoch.clone(),
        profile: owner.profile.clone(),
        root: None,
    }
}

struct Fixture {
    journal: Journal,
    source: Owner,
    source_generation: Generation,
    released: Transfer,
    context: ContextIdentity,
    capability: String,
    claim_id: String,
    lock: Arc<DataDirectoryOwner>,
    // Drop connections/lock before deleting this isolated profile on Windows.
    directory: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        Self::with_sid("S-1-5-21-1234")
    }

    fn with_sid(sid: &str) -> Self {
        // Host scratch space instead of the OS temp directory: this managed
        // Windows host denies directory creation under the short-name temp path.
        let scratch = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
        std::fs::create_dir_all(&scratch).expect("repo target directory");
        let directory = tempfile::tempdir_in(&scratch).unwrap();
        let lock = Arc::new(DataDirectoryOwner::acquire(directory.path()).unwrap());
        drop(crate::db::Database::open_in_dir(directory.path()).unwrap());
        let mut journal = Journal::open(&directory.path().join("pi.sqlite"), false).unwrap();
        let source = Owner {
            version: VERSION,
            epoch: id(),
            profile: model::digest(b"target fixture profile"),
            host: process_with_sid(11, sid),
            coordinator: process_with_sid(12, sid),
        };
        journal.register_owner(&source).unwrap();
        let source_generation = generation(&source);
        journal.register_generation(&source_generation).unwrap();
        journal
            .bind_root(&source_generation.id, &process_with_sid(13, sid))
            .unwrap();
        let build = Build {
            sha256: model::digest(b"target fixture build"),
            schema: crate::db::SCHEMA_VERSION as u32,
            protocol: VERSION,
        };
        let capability = id();
        let mut released = Transfer {
            version: VERSION,
            id: id(),
            profile: source.profile.clone(),
            source_epoch: source.epoch.clone(),
            target_epoch: id(),
            source_build: build.clone(),
            target_build: build.clone(),
            requester: process_with_sid(14, sid),
            capability_hash: model::digest(capability.as_bytes()),
            revision: 1,
            phase: Phase::Prepared,
            recovery_attempt: 0,
            last_failure: None,
        };
        let request = Request {
            id: id(),
            transfer_id: released.id.clone(),
            source_epoch: source.epoch.clone(),
            expected_revision: 0,
            mutation: Mutation::Prepare {
                record: released.clone(),
            },
        };
        journal.mutate(&source.host.sid, &request).unwrap();
        for mutation in [
            Mutation::BeginFencing,
            Mutation::ConfirmFenced,
            Mutation::Release,
        ] {
            released = journal
                .mutate(
                    &source.host.sid,
                    &Request {
                        id: id(),
                        transfer_id: released.id.clone(),
                        source_epoch: source.epoch.clone(),
                        expected_revision: released.revision,
                        mutation,
                    },
                )
                .unwrap();
        }
        journal.conn.execute_batch(
            "INSERT INTO sessions(id,title,created_at,updated_at) VALUES('kept','Original history',1,2);
             INSERT INTO turns(id,session_id,status,started_at) VALUES('original-turn','kept','running',1);
             INSERT INTO plan_approvals(request_id,session_id,turn_id,tool_call_id,plan_json,status,created_at,updated_at,execution_id,execution_state)
             VALUES('approval','kept','original-turn','tool-call','{\"original\":true}','approved',1,2,'queued-plan','queued');"
        ).unwrap();
        let context = ContextIdentity {
            owner: Owner {
                version: VERSION,
                epoch: released.target_epoch.clone(),
                profile: source.profile.clone(),
                host: process_with_sid(21, sid),
                coordinator: process_with_sid(22, sid),
            },
            build,
        };
        Self {
            directory,
            journal,
            source,
            source_generation,
            released,
            context,
            capability,
            claim_id: id(),
            lock,
        }
    }
    fn envelope(&self) -> Value {
        json!({"version":VERSION,"profileId":self.context.owner.profile,"targetBuild":self.context.build,
            "command":{"operation":"claim","version":VERSION,"request_id":self.claim_id,
            "transfer_id":self.released.id,"source_epoch":self.released.source_epoch,
            "expected_revision":self.released.revision,"target_epoch":self.released.target_epoch,
            "capability":self.capability}})
    }
    fn request(&self) -> BootstrapRequest {
        parse(&self.envelope()).unwrap()
    }
    fn claim(&self) -> TargetBootstrap {
        bootstrap::claim_locked(
            self.directory.path(),
            self.lock.clone(),
            &self.context,
            &self.request(),
            &mut Ended::default(),
        )
        .unwrap()
    }
    fn registered(&self, bootstrap: &TargetBootstrap) -> RegisteredGeneration {
        bootstrap
            .prepare_generation(generation(bootstrap.owner()))
            .unwrap()
            .bind_root(&process(23))
            .unwrap()
    }
    fn work(&self) -> String {
        let turn: String = self.journal.conn.query_row("SELECT quote(id)||quote(session_id)||quote(status)||quote(started_at) FROM turns WHERE id='original-turn'", [], |row| row.get(0)).unwrap();
        let approval: String = self.journal.conn.query_row("SELECT quote(request_id)||quote(plan_json)||quote(status)||quote(execution_id)||quote(execution_state)||quote(updated_at) FROM plan_approvals WHERE request_id='approval'", [], |row| row.get(0)).unwrap();
        format!("{turn}\n{approval}")
    }
    fn snapshot(&self) -> String {
        let mut lines = vec![self.work()];
        for query in [
            "SELECT quote(epoch)||quote(profile)||quote(retired)||quote(record_json) FROM execution_owners ORDER BY sequence",
            "SELECT quote(id)||quote(closed)||quote(record_json) FROM execution_generations ORDER BY sequence",
            "SELECT quote(id)||quote(revision)||quote(phase)||quote(record_json) FROM owner_handoffs ORDER BY sequence",
            "SELECT quote(principal)||quote(request_id)||quote(fingerprint)||quote(result_json) FROM owner_handoff_receipts ORDER BY sequence",
        ] {
            let mut statement = self.journal.conn.prepare(query).unwrap();
            lines.extend(statement.query_map([], |row| row.get::<_, String>(0)).unwrap().map(|row| row.unwrap()));
        }
        lines.join("\n")
    }
}
fn parse(value: &Value) -> Result<BootstrapRequest> {
    BootstrapRequest::parse(&serde_json::to_vec(value).unwrap())
}
fn refused<T>(result: Result<T>, code: &str) {
    match result {
        Ok(_) => panic!("expected {code}"),
        Err(error) => assert!(error.to_string().contains(code), "{error:#}"),
    }
}

#[derive(Default)]
struct Ended {
    owners: Vec<String>,
    generations: Vec<String>,
    reject_owner: Option<String>,
    reject_generation: Option<String>,
}
impl NativeProof for Ended {
    fn owner_ended(&mut self, owner: &Owner) -> Result<()> {
        self.owners.push(owner.epoch.clone());
        if self.reject_owner.as_ref() == Some(&owner.epoch) {
            bail!("HANDOFF_PREVIOUS_PROCESS_ALIVE");
        }
        Ok(())
    }
    fn generation_ended(&mut self, generation: &Generation) -> Result<()> {
        self.generations.push(generation.id.clone());
        if self.reject_generation.as_ref() == Some(&generation.id) {
            bail!("HANDOFF_PREVIOUS_CONTAINMENT_ACTIVE");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ResourceState {
    Incomplete,
    Running,
    Stopped,
    Replaced,
    EventReplaced,
}
/// Only external resource/native evidence is controlled; journal, claim,
/// preparation, Ready transaction, receipt and admission use production code.
struct Resources {
    owner: Owner,
    generation: Generation,
    state: Cell<ResourceState>,
    event_epoch: String,
    activity: Activity,
    _hold: Hold,
}
impl Resources {
    fn new(registered: &RegisteredGeneration, state: ResourceState) -> Self {
        let activity = Activity::default();
        let hold = activity.hold().unwrap();
        Self {
            owner: registered.owner().clone(),
            generation: registered.record().clone(),
            state: Cell::new(state),
            event_epoch: id(),
            activity,
            _hold: hold,
        }
    }
}
impl ReadyResources for Resources {
    fn event_stream(&self) -> Result<EventStream<'_>> {
        Ok(EventStream {
            epoch: &self.event_epoch,
            protocol_version: crate::state::PROTOCOL_VERSION,
        })
    }
    fn with_ready<T>(
        &self,
        owner: &Owner,
        generation: &Generation,
        commit: impl FnOnce(EventStream<'_>) -> Result<T>,
    ) -> Result<T> {
        if owner != &self.owner
            || generation != &self.generation
            || self.state.get() == ResourceState::Replaced
        {
            bail!("HANDOFF_OWNER_CHANGED");
        }
        if !matches!(
            self.state.get(),
            ResourceState::Running | ResourceState::EventReplaced
        ) {
            bail!("HANDOFF_TARGET_NOT_INITIALIZED");
        }
        if self.activity.snapshot() != Snapshot::default()
            || self.activity.admit(Ingress::Request).is_ok()
        {
            bail!("HANDOFF_TARGET_NOT_IDLE");
        }
        if self.state.get() == ResourceState::EventReplaced {
            commit(EventStream {
                epoch: "replacement-event-stream",
                protocol_version: crate::state::PROTOCOL_VERSION,
            })
        } else {
            commit(self.event_stream()?)
        }
    }
}
