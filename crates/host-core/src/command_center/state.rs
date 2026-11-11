//! Lifecycle states and their legal continuations.
//!
//! The tables here are the executable form of the approved control contract:
//! capacity is retained until a terminal admission state, and a receipt moves
//! only along the documented edges with a monotonic revision.

use anyhow::{bail, Result};

/// Admission states. Capacity is retained in every non-terminal state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReservationState {
    Reserved,
    Starting,
    Running,
    WaitingTool,
    WaitingHuman,
    Stopping,
    OutcomeUnknown,
    Interrupted,
    Completed,
    Aborted,
    Failed,
    LaunchFailed,
}

impl ReservationState {
    /// SQL list of terminal states; used by every capacity count.
    pub(crate) const TERMINAL_SQL: &'static str =
        "'completed', 'aborted', 'failed', 'launch_failed'";

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::WaitingTool => "waiting_tool",
            Self::WaitingHuman => "waiting_human",
            Self::Stopping => "stopping",
            Self::OutcomeUnknown => "outcome_unknown",
            Self::Interrupted => "interrupted",
            Self::Completed => "completed",
            Self::Aborted => "aborted",
            Self::Failed => "failed",
            Self::LaunchFailed => "launch_failed",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "reserved" => Self::Reserved,
            "starting" => Self::Starting,
            "running" => Self::Running,
            "waiting_tool" => Self::WaitingTool,
            "waiting_human" => Self::WaitingHuman,
            "stopping" => Self::Stopping,
            "outcome_unknown" => Self::OutcomeUnknown,
            "interrupted" => Self::Interrupted,
            "completed" => Self::Completed,
            "aborted" => Self::Aborted,
            "failed" => Self::Failed,
            "launch_failed" => Self::LaunchFailed,
            other => bail!("CC_CORRUPT_STORAGE: unknown reservation state {other}"),
        })
    }

    /// Terminal states release capacity exactly once.
    pub(crate) fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Aborted | Self::Failed | Self::LaunchFailed
        )
    }

    /// `outcome_unknown` and `interrupted` keep their slot on purpose: the old
    /// process may still be running, so capacity is not handed to new work.
    pub(crate) fn retains_capacity(self) -> bool {
        !self.terminal()
    }

    pub(crate) fn can_advance(self, next: Self) -> bool {
        use ReservationState::*;
        match self {
            Reserved => matches!(
                next,
                Starting | Interrupted | Aborted | Failed | LaunchFailed
            ),
            Starting => matches!(
                next,
                Running | Interrupted | OutcomeUnknown | Aborted | Failed | LaunchFailed
            ),
            Running => matches!(
                next,
                WaitingTool
                    | WaitingHuman
                    | Stopping
                    | Interrupted
                    | OutcomeUnknown
                    | Completed
                    | Aborted
                    | Failed
            ),
            WaitingTool | WaitingHuman => matches!(
                next,
                Running | Stopping | Interrupted | OutcomeUnknown | Completed | Aborted | Failed
            ),
            Stopping => matches!(
                next,
                Interrupted | OutcomeUnknown | Completed | Aborted | Failed
            ),
            OutcomeUnknown => matches!(
                next,
                Running | Stopping | Interrupted | Completed | Aborted | Failed | LaunchFailed
            ),
            Interrupted => matches!(next, Completed | Aborted | Failed),
            Completed | Aborted | Failed | LaunchFailed => false,
        }
    }
}

/// Durable intervention receipt states, in lifecycle order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReceiptStatus {
    Recorded,
    Accepted,
    Consumed,
    Completed,
    Rejected,
    Conflicted,
    Interrupted,
    OutcomeUnknown,
}

impl ReceiptStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Recorded => "recorded",
            Self::Accepted => "accepted",
            Self::Consumed => "consumed",
            Self::Completed => "completed",
            Self::Rejected => "rejected",
            Self::Conflicted => "conflicted",
            Self::Interrupted => "interrupted",
            Self::OutcomeUnknown => "outcome_unknown",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "recorded" => Self::Recorded,
            "accepted" => Self::Accepted,
            "consumed" => Self::Consumed,
            "completed" => Self::Completed,
            "rejected" => Self::Rejected,
            "conflicted" => Self::Conflicted,
            "interrupted" => Self::Interrupted,
            "outcome_unknown" => Self::OutcomeUnknown,
            other => bail!("CC_CORRUPT_STORAGE: unknown receipt status {other}"),
        })
    }

    /// Mirrors the shared contract table. `outcome_unknown` has no continuation
    /// here: reconciliation needs its own evidence path, never a blind replay.
    pub(crate) fn can_advance(self, next: Self) -> bool {
        use ReceiptStatus::*;
        match self {
            Recorded => matches!(
                next,
                Accepted | Rejected | Conflicted | Interrupted | OutcomeUnknown
            ),
            Accepted => matches!(next, Consumed | Completed | Interrupted | OutcomeUnknown),
            Consumed => matches!(next, Completed | Interrupted | OutcomeUnknown),
            Completed | Rejected | Conflicted | Interrupted | OutcomeUnknown => false,
        }
    }

    pub(crate) fn requires_error(self) -> bool {
        matches!(self, Self::Rejected | Self::Conflicted)
    }

    pub(crate) fn forbids_error(self) -> bool {
        matches!(
            self,
            Self::Recorded | Self::Accepted | Self::Consumed | Self::Completed
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Operation {
    Append,
    Steer,
    ReviseGoal,
    Stop,
}

impl Operation {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Append => "append",
            Self::Steer => "steer",
            Self::ReviseGoal => "reviseGoal",
            Self::Stop => "stop",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "append" => Self::Append,
            "steer" => Self::Steer,
            "reviseGoal" => Self::ReviseGoal,
            "stop" => Self::Stop,
            other => bail!("CC_CORRUPT_STORAGE: unknown operation {other}"),
        })
    }

    /// Only a goal-bearing intent can be consumed at a scheduling boundary.
    pub(crate) fn has_goal_revision(self) -> bool {
        matches!(self, Self::ReviseGoal)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopScope {
    Target,
    Subtree,
}

impl StopScope {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Target => "target",
            Self::Subtree => "subtree",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "target" => Self::Target,
            "subtree" => Self::Subtree,
            other => bail!("CC_CORRUPT_STORAGE: unknown stop scope {other}"),
        })
    }
}
