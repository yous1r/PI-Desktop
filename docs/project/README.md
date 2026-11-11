# Project Tracking

- Pending release highlights: [Unreleased changes](unreleased.md)

- AI command center (proposed): [Implementation schedule](ai-command-center-schedule.md) · [Development design](ai-command-center-development-design.md) · [Requirements and delivery plan](ai-command-center-requirements.md) · [Architecture decision](../adr/ai-command-center.md)
- AI command center visual review: [Stage design boards](ai-command-center-visual-review.md) (v3 top icon toolbar, full-width desktop content and clickable navigation; earlier images retained).
- AI command center implementation: [P0 runtime baseline and Host gaps](ai-command-center-p0-baseline.md) · [1 MiB reliability validation](ai-command-center-1mib-validation.md) (bounded writes, durable completion, 12/36-session and restart evidence; full M0 remains open).
- AI command center P0 preparation: [Control contracts](ai-command-center-control-contracts.md) · [Host capability parity and handoff inventory](ai-command-center-host-parity.md).
- AI command center long-run evidence: [One-hour soak and follow-up progress](ai-command-center-soak-report.md) (59 rounds, 2,124 verified turns; 1.331 GB sampled peak, explicit coverage limitations).
- AI command center execution backlog: [Remaining steps and acceptance](ai-command-center-remaining-work.md) (S03 data-directory ownership foundation; full handoff and dependent features remain pending).
- AI command center Windows defect closure: [Full Rust validation](ai-command-center-p0-evidence/windows-validation.json) (1,103 passed, zero failures, one live-marketplace ignore; cmd and remote-permission process checks recorded in the backlog).
- AI command center S03b: [Idle handoff protocol design](ai-command-center-idle-handoff.md) (local identity, execution fencing and source operations have scoped candidate evidence; complete transfer remains open).
- AI command center independent continuation: [Observation foundations and evidence](ai-command-center-continuation.md) (bounded monitor pages, portable receipt consumers and connection health; production monitoring/browser integration remains open).
- AI command center status: [Acceptance index and handoff](ai-command-center-acceptance-index.md)
- AI command center takeover: [Authorized uncommitted-work provenance](ai-command-center-takeover-provenance.md) and [evidence](ai-command-center-takeover-evidence.json)
- AI command center handoff: [Branch state, verified suites and remaining wiring](ai-command-center-final-handoff.md) (accepted, internally verified and blocked items with their evidence/dependency).
- AI command center monitor join: [C3 integration contract](ai-command-center-monitor-integration-contract.md) (required authorized producer/change/bounds contract and acceptance; not a wire protocol or enablement).
- AI command center Batch 1: [Reconstructed worktree baseline](ai-command-center-batch1-baseline.md) · [Delivery, wiring and remaining work](ai-command-center-batch1-delivery.md) (H3 entry, C3 registration, U1 mount, schema alignment and the blocked joins).
- AI command center Batch 3: [Capability, supervisor, reattachment, monitor and live-data wiring](ai-command-center-batch3-delivery.md) (approved capability advertisement, C4 dispatch claims, H3 supervisor slice, H4 composition, M1 producer and the remaining joins).
- AI command center Batch 4: [Same-process Ready, commandCenter RPC, bootstrap composition and real monitor transport](ai-command-center-batch4-delivery.md) (Rust Ready frame, private commandCenter RPC, Desktop opt-in bootstrap, HostRpcPort monitor provider and the remaining serving joins).

- Historical project board (archived; last refreshed 2026-08-11 for the 0.5.x line): [`BOARD.md`](BOARD.md)
- Documentation/code alignment audit: [2026-07-30 audit](2026-07-30-docs-code-audit.md)
- Plan implementation plan: [`plan-mode-implementation-plan.md`](plan-mode-implementation-plan.md)
- Pi 1.0.1 adoption: [`pi-101-adoption.md`](pi-101-adoption.md)
- Pi 1.1.0 adoption: [`pi-110-adoption.md`](pi-110-adoption.md)
- GitHub Issues + Milestones: repository Issues page
- GitHub Projects: create after adding the `project` token scope
