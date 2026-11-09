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

#[derive(Clone, Default)]
pub struct Activity(Arc<Mutex<Snapshot>>);

tokio::task_local! {
    static CURRENT: Activity;
}

impl Activity {
    fn lock(&self) -> MutexGuard<'_, Snapshot> {
        self.0.lock().unwrap_or_else(|poison| {
            let mut snapshot = poison.into_inner();
            snapshot.uncertain = true;
            snapshot
        })
    }

    /// Reserve before spawning or invoking callbacks. A dropped reservation is
    /// unresolved even if its Rust future was cancelled successfully.
    pub fn begin(&self, kind: Kind) -> Obligation {
        let mut state = self.lock();
        let count = state.count(kind);
        let counted = *count < MAX_COUNT;
        if counted {
            *count += 1;
        } else {
            state.uncertain = true;
        }
        Obligation {
            activity: self.clone(),
            kind,
            counted,
            completed: false,
        }
    }

    pub fn mark_uncertain(&self) {
        self.lock().uncertain = true;
    }

    pub fn snapshot(&self) -> Snapshot {
        self.lock().clone()
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
            state.uncertain = true;
        }
        if self.counted {
            let count = state.count(self.kind);
            if *count == 0 {
                state.uncertain = true;
            } else {
                *count -= 1;
            }
        }
    }
}

#[cfg(test)]
mod tests;
