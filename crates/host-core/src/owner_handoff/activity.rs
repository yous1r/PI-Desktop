//! Process-local obligations of the original Rust owner. These counters are
//! conservative busy evidence, not a durable ledger or native closure proof.
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;

const MAX_COUNT: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy)]
pub enum Kind {
    Request,
    Background,
    Write,
}

/// New work is distinct from persistence/cleanup of work already admitted.
#[derive(Clone, Copy)]
pub enum Ingress {
    Request,
    Background,
}

#[derive(Clone, Default, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub requests: u64,
    pub background_tasks: u64,
    pub writes: u64,
    pub uncertain: bool,
}
impl Snapshot {
    fn count(&mut self, kind: Kind) -> &mut u64 {
        match kind {
            Kind::Request => &mut self.requests,
            Kind::Background => &mut self.background_tasks,
            Kind::Write => &mut self.writes,
        }
    }
}

#[derive(Default)]
enum Gate {
    #[default]
    Open,
    Held(Arc<()>),
    Sealed,
    Closed,
}
#[derive(Default)]
struct State {
    snapshot: Snapshot,
    gate: Gate,
}

#[derive(Clone, Default)]
pub struct Activity(Arc<Mutex<State>>);

#[derive(Debug)]
pub struct AdmissionClosed;

tokio::task_local! {
    static CURRENT: Activity;
}

pub struct Lifetime(Activity);
impl Drop for Lifetime {
    fn drop(&mut self) {
        self.0.close();
    }
}

impl Activity {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|poison| {
            let mut state = poison.into_inner();
            state.snapshot.uncertain = true;
            state.gate = Gate::Closed;
            state
        })
    }

    /// Check and reserve in one critical section, before any effect or spawn.
    pub fn admit(&self, ingress: Ingress) -> Result<Obligation, AdmissionClosed> {
        let mut state = self.lock();
        if !matches!(state.gate, Gate::Open) {
            return Err(AdmissionClosed);
        }
        let kind = match ingress {
            Ingress::Request => Kind::Request,
            Ingress::Background => Kind::Background,
        };
        if *state.snapshot.count(kind) >= MAX_COUNT {
            state.snapshot.uncertain = true;
            return Err(AdmissionClosed);
        }
        Ok(self.reserve(&mut state.snapshot, kind))
    }

    /// Close ingress before inspection. Existing obligations remain visible.
    /// The source controller must retain this capability until reconciliation;
    /// dropping it, a timeout or a disconnected caller never reopens admission.
    pub fn hold(&self) -> Result<Hold, AdmissionClosed> {
        let mut state = self.lock();
        if !matches!(state.gate, Gate::Open) {
            return Err(AdmissionClosed);
        }
        let token = Arc::new(());
        state.gate = Gate::Held(token.clone());
        Ok(Hold {
            activity: self.clone(),
            token,
        })
    }

    pub fn close(&self) {
        self.lock().gate = Gate::Closed;
    }

    /// Serving-future cancellation revokes ingress even if AppState is retained.
    pub fn lifetime(&self) -> Lifetime {
        Lifetime(self.clone())
    }

    /// Continuations and explicitly classified control requests only. New RPC
    /// and autonomous work must use `admit`. Reserve before callbacks/spawn;
    /// dropping a reservation retains uncertainty, including on cancellation.
    pub fn begin(&self, kind: Kind) -> Obligation {
        self.reserve(&mut self.lock().snapshot, kind)
    }

    fn reserve(&self, snapshot: &mut Snapshot, kind: Kind) -> Obligation {
        let count = snapshot.count(kind);
        let counted = *count < MAX_COUNT;
        if counted {
            *count += 1;
        } else {
            snapshot.uncertain = true;
        }
        Obligation {
            activity: self.clone(),
            kind,
            counted,
            completed: false,
        }
    }

    pub fn mark_uncertain(&self) {
        self.lock().snapshot.uncertain = true;
    }

    pub fn snapshot(&self) -> Snapshot {
        self.lock().snapshot.clone()
    }

    pub fn current() -> Option<Self> {
        CURRENT.try_with(Clone::clone).ok()
    }

    /// Propagate only through the original request. Spawned blocking work must
    /// explicitly take its own reservation before leaving this scope.
    pub async fn scope<F: Future>(&self, future: F) -> F::Output {
        CURRENT.scope(self.clone(), future).await
    }
}

/// Process-local authority only; this does not certify a durable cancellation.
/// The source controller must validate its journal/owner before calling reopen.
pub struct Hold {
    activity: Activity,
    token: Arc<()>,
}
impl Hold {
    fn owns(&self, state: &State) -> bool {
        matches!(&state.gate, Gate::Held(token) if Arc::ptr_eq(token, &self.token))
    }

    pub fn reopen(self) -> Result<(), AdmissionClosed> {
        let mut state = self.activity.lock();
        if !self.owns(&state) {
            return Err(AdmissionClosed);
        }
        state.gate = Gate::Open;
        Ok(())
    }

    pub fn seal(&self) -> Result<(), AdmissionClosed> {
        let mut state = self.activity.lock();
        if !self.owns(&state) {
            return Err(AdmissionClosed);
        }
        state.gate = Gate::Sealed;
        Ok(())
    }
}

pub struct Obligation {
    activity: Activity,
    kind: Kind,
    counted: bool,
    completed: bool,
}
impl Obligation {
    /// Only the original operation calls this after its work has settled.
    /// Failure remains uncertain; a later success never clears that evidence.
    pub fn finish(mut self, confirmed: bool) {
        self.completed = confirmed;
    }
}
impl Drop for Obligation {
    fn drop(&mut self) {
        let mut state = self.activity.lock();
        if !self.completed {
            state.snapshot.uncertain = true;
        }
        if self.counted {
            let count = state.snapshot.count(self.kind);
            if *count == 0 {
                state.snapshot.uncertain = true;
            } else {
                *count -= 1;
            }
        }
    }
}

#[cfg(test)]
mod tests;
