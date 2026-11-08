# AI command center: implementation schedule

- Status: Proposed schedule; staffing, kickoff and release dates are not committed
- Prepared: 2026-11-08 (verified local environment date)
- Design baseline: local commit `3eaa78fcb32a0e432519f493603fa63874ac7f82`, based on `origin/main` at `fd28eb89866ac513912ed109716e7120cf60f18c`
- Scope references: [ADR](../adr/ai-command-center.md), [requirements](ai-command-center-requirements.md), [development design](ai-command-center-development-design.md)
- Current execution: the operator authorized phased implementation. The [initial P0 runtime baseline](ai-command-center-p0-baseline.md) and [1 MiB persistence correction](ai-command-center-1mib-validation.md) are implemented; M0 remains open for full workload/platform qualification and contract review.
- Remaining execution order and per-step acceptance: [implementation backlog](ai-command-center-remaining-work.md). S03a adds a cooperating Rust Host data-directory lock; complete execution handoff, M0/M1 and dependent product gates remain open.

## Contents

1. [Planning object and delivery scope](#planning-object-and-delivery-scope)
2. [Missing inputs and working assumptions](#missing-inputs-and-working-assumptions)
3. [Roles and capacity](#roles-and-capacity)
4. [Calendar convention](#calendar-convention)
5. [Milestones and release gates](#milestones-and-release-gates)
6. [Work packages and dependencies](#work-packages-and-dependencies)
7. [Weekly owner allocation](#weekly-owner-allocation)
8. [Platform rollout](#platform-rollout)
9. [Acceptance coverage](#acceptance-coverage)
10. [Risks, contingency and replanning](#risks-contingency-and-replanning)
11. [Execution workflow and first actions](#execution-workflow-and-first-actions)
12. [Planning validation and status](#planning-validation-and-status)

## Planning object and delivery scope

Plan the implementation described by the three linked documents, not a general
rewrite of PI-Desktop. The first complete delivery is a Windows/RDP AI command
center plus Android/iOS responsive Web/PWA control. Native macOS and Linux remain
explicit follow-on platform deliverables; they are not removed from the product.

Required outputs include an independent Host mode with compatible data ownership;
a lightweight overview and up to three workspace surfaces; on-demand main/child
history and live attachment; explicit intervention with receipts and parent/child
goal consistency; atomic workspace admission; native program association; a secure
browser control edge; and reproducible release evidence.

Constraints that schedule pressure cannot relax:

- One permanent overview plus at most three application-internal workspace surfaces.
- Workspace maximize/restore prioritizes the focused page without stopping hidden work.
- At most twelve live agents per workspace and thirty-six per command-center Host,
  counting main agents, native children and Workers under the proposed counting rule.
- Qualified maximum-concurrency workload stays within the proposed decimal 4 GB
  budget for all application-owned processes, including independent Host and bridge.
- No required GPU feature; actual software-rendering, RDP, DPI and IME qualification.
- Retain Electron and existing Rust/Node/shared/plugin ownership boundaries; no
  direct Renderer database access, second writer, permission bypass or silent replay.
- Desktop and mobile operate on the same Host identities; devices do not receive
  independent quota pools. Mobile is a control client, not a local Agent executor.

Selected native-window embedding, remote GUI streaming, automatic semantic task
supervision, on-device model execution, desktop-shell replacement and distributed
multi-Host quota are not included in the first-release effort. Application
association is included. A requested embedding adapter must have its own app list,
validation and estimate rather than expanding that work package invisibly.

## Missing inputs and working assumptions

The operator has asked for a recommended team, an early start and a suggested
platform order. Actual people, availability and dates are not yet supplied. The
following gaps do not prevent planning, but have explicit closure dates.

| Input | Needed by | Proposed working basis | Accountable role |
|---|---|---|---|
| Names, skills and weekly availability | Before T0 | Two full-time developers plus half-time QA; roles below | P |
| Start date, leave and regional holiday calendar | Before T0 | Relative work weeks; example dates only | P with B/F/Q |
| Reference machine and remote-desktop access | W1 day 2 | Windows 11, eight cores, 32 GB RAM, SSD; freeze actual machine and RDP profile | P supplies; Q records |
| Agent/context/provider/plugin load | W1 day 3 | Requirements' 36-instance, 32k-token fixture plus larger-context measurement | B with Q; P confirms representative work |
| At least three native applications and workflows | W2 day 2 | Association first; record versions, elevation and multi-window behavior | P supplies; F owns matrix |
| Counting rule and command workspace grouping | M0 | All live parent/child/Worker executions; 3 admitted groups | P accepts; B specifies |
| Browser deployment, enrollment and network reachability | W2 contract gate; environment ready by W10 | Same-origin user-owned HTTPS edge; no mandatory cloud | B with P |
| Android and iOS/iPadOS test devices | Access confirmed by W2; usable by W11 | Real browsers/PWA and network-switch tests | P supplies; Q qualifies |
| Mac access and supported architectures | Procurement/access decision by W10; ready by W17 | Native qualification after the Windows/mobile core | P supplies; F validates |
| Linux distribution and X11/Wayland scope | Decision by W17; environment ready by W21 | Named supported matrix and explicit unsupported-control fallback | P with B/F |

No engineer or reviewer has actually been assigned by this document. Replace role
codes with names before implementation begins. AI assistance is a tool available
to those owners; it does not count as additional guaranteed staffing or justify an
unmeasured productivity multiplier.

## Roles and capacity

One person-day means one focused working day on a scheduled deliverable, including
its implementation and assigned verification. Capacity discounts reserve time for
reviews, coordination and interruptions; vacation and holidays are additional.

| Code | Recommended role | Nominal weekly availability | Scheduled delivery capacity | Accountabilities |
|---|---|---:|---:|---|
| P | Product owner/operator | 0.5-1 day | Outside engineering totals | Scope, input decisions, program/device access, user acceptance and release authorization |
| B | Host/runtime lead and integration owner | 5 days | 4 days | Rust persistence, TypeScript runtime, admission, control, browser authentication, contract integration |
| F | Desktop/Web client engineer | 5 days | 4 days | React/client seams, four surfaces, native bridge UI, mobile Web/PWA and platform adaptation |
| Q | QA/automation engineer | 2.5 days | 2 days | Fixtures, process/memory metrics, race/recovery tests, RDP/mobile journeys and release evidence |

B and F review each other's cross-boundary contracts; Q verifies gate evidence;
P accepts product behavior. Authentication/native-permission changes need a reviewer
with relevant experience, provided by B/F or explicitly booked before the gate.
Do not assume an unstaffed external security team is available. A skill gap is an
input to replanning, not a reason to waive the gate.

### Selected planning point

The previous estimate is 80-135 engineering person-days, or 100-169 with a 25%
uncertainty reserve, for Windows plus mobile Web/PWA. This schedule selects a
**120-person-day baseline**, inside that range, distributed as follows. Q effort
is part of the total, not an additional hidden budget.

| Phase | B days | F days | Q days | Total days |
|---|---:|---:|---:|---:|
| P0 baseline and contracts | 4 | 2 | 2 | 8 |
| P1 independent Host foundation | 12 | 4 | 2 | 18 |
| P2 overview and attached views | 4 | 12 | 2 | 18 |
| P3 admission and intervention | 11 | 4 | 3 | 18 |
| P4 native application association | 5 | 4 | 2 | 11 |
| P5 browser/mobile access | 10 | 9 | 4 | 23 |
| P6 rolling qualification and release evidence | 6 | 9 | 9 | 24 |
| Total | 52 | 44 | 24 | 120 |

Fourteen weeks provide at most 56 B, 56 F and 28 Q delivery days, or 140 total.
The 20 unused days are role/dependency slack, not assumed interchangeable capacity.
B has only four such days and is the principal bottleneck. The weekly table proves
the baseline does not double-book any role.

W15-W17 reserve up to another 30 delivery days across B/F/Q (12/12/6), equivalent
to 25% of the 120-day planning point. This is a pooled capacity allowance, not a
promise that every possible overrun fits three weeks. If a role needs more than
its remaining capacity or a platform dependency is missing, publish a new forecast.
The 17-week window is not a guaranteed worst-case bound for the old 169-day range.
Nominal staff cost is different from focused task days; use booked availability
and the agreed rate for a financial budget.

## Calendar convention

T0 is the first Monday after named owners, their availability and Windows access
are in place. Calendar dates remain examples. The subsequent authorization to
begin scoped P0 implementation does not commit staffing, releases or reminders.

For a concrete example only, T0 = **2026-11-09**, the next Monday after the verified
planning date. If staffing is not ready then, shift every example date by the T0
change. The table assumes five working weekdays per week and no public holidays
or leave. This example crosses year-end and regional holiday periods; incorporate
the actual calendars before calling dates committed. Do not use contingency to
conceal holidays already known at kickoff.

Schedule notation Wn refers to a project work week; milestones mean end of that
week unless a day is specified. The baseline is W1-W14, with W15-W17 contingency.
Relative weeks are authoritative; dated examples are for coordination only.

## Milestones and release gates

| Milestone | Target | Example date | Accountable / verifies / accepts | Deliverable and exit condition |
|---|---|---|---|---|
| M0: baseline and design gate | W2 day 3 | 2026-11-18 | B / Q / P | Record resource baseline/prototype, Host parity inventory, workspace/goal/receipt contracts, fixture parameters, program/device matrix and scoped risk actions; viable path to 4 GB or explicit redesign/re-estimate |
| M1: execution foundation | W5 | 2026-12-11 | B / Q with F / P | Independent owner handoff, versioned repositories and portable control seams; one database writer; targeted migration/recovery and authorization contracts pass |
| M2: monitoring preview | W6 | 2026-12-18 | F / Q / P | Overview plus three surfaces, maximize/restore, bounded main/child history and live attachment; AC-01/02/03 pass on the preview path |
| M3: control beta | W9 | 2027-01-08 | B / Q with F / P | Explicit main/child intervention, parent revision consistency and all-source 12/36 admission; AC-04/05/06 pass |
| M4: Windows integrated candidate | W11 | 2027-01-22 | F / Q with B / P | Nominated native programs associate/detach safely; software-rendered RDP/DPI/IME paths and capacity fixture run; open failures are classified, not ignored |
| M5: Windows release-ready | W12 | 2027-01-29 | B / Q / P | Windows gate set below passes, including actual 36-agent workload within 4 GB; upgrade, recovery and single-session regressions pass |
| M6: mobile Web/PWA release-ready | W14 | 2027-02-12 | F / Q with B / P | Android/iOS device paths, authenticated access, cross-client intervention/approval and suspend/reconnect pass; browser portions of AC-12/13/15/16 close |
| R: reserved recovery window | W15-W17 | 2027-02-15 to 2027-03-05 | B/F by defect owner / Q / P | Resolve evidenced failures on the same scope; if all gates pass early, release the unused reserve rather than adding features |
| M7: native macOS qualified | W21 | 2027-04-02 | F / Q with B / P | Mac platform acceptance and selected native association paths pass; explicit supported architecture/version matrix |
| M8: native Linux qualified | W25 | 2027-04-30 | B / Q with F / P | Nominated Linux/X11/Wayland capabilities and fallbacks pass; report actual supported distributions and limits |

M2 is an internal preview, not the full command-center release: new direct child
control, maximum-capacity and mobile/native-program gates are not implied. M4 is
an integration candidate, not a license to ship with failing capacity/security gates.
M5 is a Windows-only acceptance boundary; the full cross-platform promise remains
open until the corresponding M6-M8 platform evidence exists. Release-ready does
not authorize distribution, a real-provider spend, a push or a merge.

### Gate sets

- **Windows M5:** AC-01 through AC-11, AC-14, local/native portions of AC-15, and
  Windows regression/accessibility/i18n portions of AC-16. Include client-independent
  Host continuation and desktop reconnect from AC-13, even though phone acceptance
  remains at M6. Browser networking stays unexposed until its own gate passes.
- **Mobile M6:** AC-12 and AC-13 on nominated Android and iOS devices, browser/device
  security portions of AC-15, and mobile portions of AC-16. Rerun affected core
  gates, including the co-located memory fixture with the browser edge active;
  M5 evidence cannot conceal new P5 process memory or protocol regressions.
- **macOS/Linux M7/M8:** applicable core, native-process, authentication and client
  user paths from AC-01 through AC-16. Define equivalent platform memory metrics
  before execution; do not report Windows Private Bytes as a cross-platform metric.

## Work packages and dependencies

Package effort is the sum across roles, not elapsed duration. Each package is
broken into 1-4-day owner tasks at its start, with explicit changed modules and
verification. The phase/weekly tables contain the authoritative role allocation.

| ID | Window | Effort days | Lead / contributors | Prerequisite | Concrete output and verification |
|---|---|---:|---|---|---|
| S01 | W1-W2 day 2 | 4 | B / Q | Named team and Windows access | Baseline process inventory, software-rendering/RDP probe, 36-runtime feasibility fixture and captured limitations |
| S02 | W1-W2 day 3 | 4 | B / F,Q,P | Existing design; S01 evidence | Frozen target identity, quota, goal/receipt draft, workload and native/mobile matrices; M0 record |
| S03 | W2 day 4-W4 | 8 | B / F,Q | M0; exclusive ownership contract | Independent Host lifecycle and capability inventory; data-directory handoff and interrupted-start tests |
| S04 | W3-W5 | 6 | B / F,Q | S02 identity/schema; S03 ownership seam | Rust membership/reservation/goal/receipt repositories and migration tests; no second transcript store |
| S05 | W3-W5 | 4 | B / F,Q | S02; S03/S04 final integration | Portable client interfaces, capability negotiation, authorization and deterministic adapters |
| S06 | W3-W6 | 8 | B / F,Q | S02 contracts; S05 required for final integration | Summary projection, snapshot/subscription barrier, stale detection, bounded task tree; AC-02/03 races |
| S07 | W3-W6 | 10 | F / B,Q | S02 UI contract; S06 live integration | Four surfaces, protected overview, maximize, history/draft lifecycle and keyboard paths; AC-01/03 |
| S08 | W6-W9 | 7 | B / F,Q | M1 and P2 target contracts frozen in W5 | All-entry atomic 12/36 admission and recovery; no hidden/client quota bypass; AC-06 |
| S09 | W6-W9 | 11 | B / F,Q | S04/S05; S07 for complete UI journey | Main/child steering, goal revisions, parent notification, receipts and stop races; AC-04/05 |
| S10 | W8-W11 | 11 | F / B,Q | M1/M2, named app matrix; no need to wait for all of S09 | Native bridge association, process/window identity, detach/recovery and RDP/DPI/IME; AC-10/11 |
| S11 | W10-W14 | 10 | B / F,Q | M1, M3 and deployment inputs | HTTPS/browser session adapter, scoped principals, revocation and control transport; AC-15 |
| S12 | W10-W14 | 13 | F / B,Q | M2/M3 contracts; S11 ready for final device gates | Responsive Web/PWA, cross-client state, history, intervention and mobile resume; AC-12/13/16 |
| S13 | W2 harness; W6-W14 qualification | 8 | Q / B,F | S01 fixture; runnable features as they land | Process/latency instrumentation, fixed-load progression, capacity and soak artifacts; AC-07/08/09 |
| S14 | W6-W14 | 10 | Q / B,F | Incremental P1-P5 candidates | Migration/crash, regressions, native/mobile journeys and release defect verification; AC-14/15/16 |
| S15 | W10-W14 | 6 | Q / B,F,P | Accepted outputs of S10-S14 per release scope | Updated specs/scenarios, platform matrix, package/candidate evidence, operating and recovery notes |

P6 is a rolling verification stream (S13-S15), not testing deferred until W14.
The prior phase table's P6 dependency means its final gate needs P1-P5; test
harnesses and incremental checks intentionally begin earlier. Similarly, P2 UI can
use deterministic contract fixtures before the Host is ready, but M2 requires real
internal integration. S08/S09 can begin behind frozen P2 targets before M2 closes;
the control-beta gate still requires the real P2 user path.

### Dependency and critical-path rules

```text
S01 + S02 -> M0 -> S03/S04/S05 -> M1
M0 contracts -> S06/S07 preparation; M1 + integrated S06/S07 -> M2
M1 + P2 target contracts (W5) -> S08/S09; M2 + completed S08/S09 -> M3
M1 + M2 -> S10; M3 + S10 + rolling qualification -> M4 -> M5
M3 -> S11/S12; completed S11/S12 + rolling qualification -> M6

S13/S14/S15 qualify each integrated path as it becomes available.
M5 + M6 + required devices -> M7 -> M8 for the proposed platform sequence.
```

The main resource-constrained path is B's ownership/persistence work, then
admission/child control, native bridge integration, Windows failure fixes, and
browser authentication. F's available time cannot automatically replace Rust or
runtime work. Blocked UI work may proceed against the frozen boundary but cannot
claim an integration milestone. Changes to canonical identities after M0 require
producer/consumer impact analysis and a revised schedule.

## Weekly owner allocation

Cells show **phase: focused days**. B/F each have at most four scheduled delivery
days/week; Q has two. P's decisions and reviews are outside these totals. No entry
starts a dependent implementation before the relevant subgate defined above.

| Week | Example Monday-Friday | B allocation | F allocation | Q allocation | Focus / evidence due |
|---|---|---|---|---|---|
| W1 | 2026-11-09 to 2026-11-13 | P0:2 | P0:1 | P0:1 | Inventory, reference workload, initial risk probe |
| W2 | 2026-11-16 to 2026-11-20 | P0:2, P1:2 | P0:1, P1:1 | P0:1, P6:1 | M0 on day 3; P1 starts after gate; harness skeleton |
| W3 | 2026-11-23 to 2026-11-27 | P1:4 | P1:2, P2:2 | P1:1 | Owner/schema/client seams, UI with frozen fixture |
| W4 | 2026-11-30 to 2026-12-04 | P1:4 | P1:1, P2:3 | P1:1 | Handoff/migration and snapshot contracts |
| W5 | 2026-12-07 to 2026-12-11 | P1:2, P2:2 | P2:4 | P2:1 | M1; freeze P2 targets; integrate monitor Host |
| W6 | 2026-12-14 to 2026-12-18 | P2:2, P3:2 | P2:3, P3:1 | P2:1, P6:1 | M2; begin control/admission and load trend checks |
| W7 | 2026-12-21 to 2026-12-25 | P3:4 | P3:2, P6:1 | P3:1, P6:1 | Child/control races and 12-agent workspace load |
| W8 | 2026-12-28 to 2027-01-01 | P3:4 | P3:1, P4:2 | P3:1, P6:1 | Parent revision consistency; native UI/adapters |
| W9 | 2027-01-04 to 2027-01-08 | P3:1, P4:3 | P4:2, P6:1 | P3:1, P6:1 | M3; full three-workspace admission; native integration |
| W10 | 2027-01-11 to 2027-01-15 | P4:2, P6:2 | P5:3, P6:1 | P4:1, P6:1 | 36-agent integrated load, native qualification; mobile against stable API |
| W11 | 2027-01-18 to 2027-01-22 | P6:2, P5:2 | P5:3, P6:1 | P4:1, P5:1 | M4; real apps/RDP; browser auth integration |
| W12 | 2027-01-25 to 2027-01-29 | P6:2, P5:2 | P5:2, P6:2 | P5:1, P6:1 | M5; Windows evidence set and browser device regressions |
| W13 | 2027-02-01 to 2027-02-05 | P5:4 | P5:1, P6:2 | P5:1, P6:1 | Cross-client/revocation/reconnect; rerun changed core paths |
| W14 | 2027-02-08 to 2027-02-12 | P5:2 | P6:1 | P5:1, P6:1 | M6; mobile evidence and final co-located resource check |

W14 leaves B/F time unassigned so last integration findings do not depend entirely
on Q. It is not counted as delivered work. Windows regression during P5 takes
priority over optional mobile polish. Explicitly separate release candidates so
an unfinished browser edge is neither enabled in the Windows release nor treated
as an independently validated process excluded from the later memory total.

## Platform rollout

Recommended sequence: **Windows -> mobile Web/PWA -> native macOS -> native Linux**.
This follows existing code reuse and the currently available Windows environment.
It is a planning recommendation, not a claim that mobile outranks the user's
macOS needs. A Mac or mobile-device availability change can reorder follow-on
qualification after the shared contracts stabilize, without changing core scope.

| Stage | Reserved relative window | Example dates | Task allocation and owner | Acceptance output |
|---|---|---|---|---|
| Windows | W1-W12 | 2026-11-09 to 2027-01-29 | Core allocation above; B integration/F desktop/Q tests | M5 Windows evidence |
| Mobile Web/PWA | W10-W14 | 2027-01-11 to 2027-02-12 | P5 plus its share of P6; F client/B edge/Q devices | M6 Android and iOS evidence |
| Risk reserve | W15-W17 | 2027-02-15 to 2027-03-05 | Capacity held for core failures; do not simultaneously book it for platform delivery | Closed core gates or explicit new forecast |
| macOS | W18-W21 | 2027-03-08 to 2027-04-02 | Planning point 16 days: B4/F8/Q4; F accountable | Mac desktop, Host lifecycle, native association and applicable AC gates |
| Linux | W22-W25 | 2027-04-05 to 2027-04-30 | Planning point 16 days: B4/F8/Q4; B accountable | Nominated distribution/display-server matrix and applicable AC gates |

For each four-week platform stage, reserve B1/F2/Q1 delivery days per week. This
fits the same team's capacities and leaves room for stabilization. Each stage's
16-day point is within the existing 10-20-day estimate; novel adapter or packaging
requirements trigger re-estimation. Core plus both platform points totals 152
planned task-days; the 30-day core contingency brings that selected envelope to
182 task-days, excluding conditional features and any further platform contingency.
Those are effort totals, not a promise of twenty-five completely occupied weeks.

Earlier completion can pull a ready platform forward after P confirms staff and
devices, but it cannot consume contingency already committed to unresolved core
failures. Android emulator/iOS browser emulation may help development; neither is
proof of real-device lifecycle acceptance. Native iOS packaging is outside P5 and
requires its own Mac/Xcode/signing plan if selected later.

## Acceptance coverage

All implementation gates are **NOT RUN**. Planning does not change the existing
ADR/design status from Proposed. The following map makes ownership and due dates
explicit while reusing the requirements' numeric thresholds.

| Gate | Lead for evidence | Target | Evidence required |
|---|---|---|---|
| AC-01 four-surface behavior | F, verified by Q | M2 | Protected overview, three workspaces, resize/focus/maximize/restore and draft retention |
| AC-02 monitoring/freshness | B, verified by Q | M2 | Summary P95 <=1 s; 2 s health probes; stale within 1 s after 6 s without a reply |
| AC-03 attach/history | F with B, verified by Q | M2 | Canonical main/child history plus streaming, paging, view-generation cancellation and complete final output |
| AC-04 intervention identity | B, verified by Q | M3 | 1,000 interleaved operations, stale target and duplicate request/payload cases; no wrong-session effect |
| AC-05 child/parent consistency | B, verified by Q | M3 | Running-child correction, consumed revision and parent fence; settled/stop/unsupported cases |
| AC-06 admission | B, verified by Q | M3 | All-source atomic 12/36 limits, reservations, waits, hidden surfaces and multi-client quota |
| AC-07 capacity/memory | Q with B/F | M5; rerun with P5 at M6 | Frozen co-located 36-agent workload, recorded process set and maximum contemporaneous owned Private Bytes <=4,000,000,000; all measurement limits disclosed |
| AC-08 foreground response | Q with F/B | M5; affected paths at M6 | P95 input <=100 ms, warm switch <=250 ms, stop-request admission <=500 ms; 1,000 samples under load |
| AC-09 lifecycle/resource retention | Q with B/F | M5 and M6 | Two-hour/100-cycle soak; <=10% equivalent steady-memory growth; no orphan resources |
| AC-10 native applications | F, verified by Q | M4 evidence; M5 pass | Named program selection/association, identity change, activation refusal and safe detach |
| AC-11 remote-desktop usability | F, verified by Q | M4 evidence; M5 pass | Software rendering, real RDP reconnect, 100/125/150/200% DPI, Chinese IME and overlay/native-view interaction |
| AC-12 cross-client control | F with B, verified by Q | M6 | Desktop start/phone intervention, shared receipts, once-only approval resolution and independent focus |
| AC-13 continuation/reconnect | B with F, verified by Q | Desktop portion M5; full M6 | Headless continuation, mobile suspension/network changes, consistent resync <=5 s on fixed network; no automatic mutation replay |
| AC-14 migration/recovery | B, verified by Q | Foundation M1; release M5 | Populated upgrade, exclusive handoff, crash/epoch/schema-too-new and orphan execution checks |
| AC-15 security | B, verified by Q and F | Local M5; browser M6 | Role/target boundaries, Origin/CSRF, enrollment/revocation, no URL-token/raw-RPC/provider-secret leakage |
| AC-16 compatibility/platforms | Q with B/F, accepted by P | M5/M6; platform portions M7/M8 | Current single-session/plugin/remote-tools regressions, locales, accessibility and named platform/device evidence |

Evidence includes exact candidate/base revisions, fixture and build versions,
configuration, raw memory/latency output, representative user paths, pass/fail/not-run
status and residual limitations. Paid providers, production services and the user's
running Desktop are not default test environments. Real-provider limits or semantic
correction quality require separate authorized evidence; deterministic fixtures
prove the integration/capacity path only.

## Risks, contingency and replanning

| Trigger | Detection checkpoint | Owner | Required schedule response |
|---|---|---|---|
| Team not available or B lacks required Rust/runtime skill | Before T0 | P | Move T0 or book the skill; do not keep the dated example as a commitment |
| 36-runtime feasibility already exceeds the memory path | M0; revisit W7/W10 | B with Q | Identify measured cause, evaluate bounded retention/topology work and revise forecast before scaling UI; queued Agents cannot substitute |
| Independent Host lacks a required provider/plugin capability | M0 inventory, M1 integration | B | Specify compatibility work and extra effort; avoid silent feature removal or credential relocation |
| Child-goal/receipt ordering remains unresolved | W5 contract freeze, M3 | B | Block child-control acceptance; isolate the missing contract and retest concrete races |
| Full-load or RDP/IME gate fails | W10-M5 | Q with F/B | Fix in owner capacity, use explicit reserve if necessary; no scope/threshold downgrade to meet a date |
| Browser authentication or device revocation fails | W11-M6 | B | Keep network entry disabled; fix and rerun affected security and core tests |
| Required phone, Mac or Linux environment unavailable | W2/W10/W17 access checkpoints | P | Move that platform gate; continue independent work but report NOT RUN rather than simulated qualification |
| Native program requires embedding rather than association | W2 matrix | P with F | Approve a separate adapter scope/estimate; do not bury it in P4 |
| Known holidays or leave reduce weekly capacity | T0 and weekly review | P with team | Recompute role calendar and milestone dates explicitly; no overtime assumption |
| B overrun exceeds twelve reserve days, or total reserve exceeds thirty | Weekly forecast | B/P | Publish a revised role-constrained finish date; 17 weeks is not an absolute upper bound |

Sidecar sharding remains an estimated additional 15-25 days only if justified;
selected embedding is another 10-20-day initial range. Neither is secretly included
in the baseline. Their owner-specific effect may exceed the available three-week
reserve. Treat P0 as the first decision gate for scope/capacity, then update estimates
using completed work and measured remaining effort at M1, M3 and M5.

If staffing differs, recompute by role rather than dividing 120 days by the total
headcount. For example, one developer plus Q has only four development days/week:
B+F's 96-day baseline needs at least 24 developer weeks before dependency/contingency
adjustments. Removing Q also transfers the 24 testing days to developers. AI usage
alone is not evidence that these lower bounds disappear.

## Execution workflow and first actions

### Before starting

The proposed B/F/Q staffing allocations and calendars still need named owners.
The operator has authorized phased implementation. P0 now includes the isolated
runtime harness, [control contract draft](ai-command-center-control-contracts.md),
and [Host parity/handoff inventory](ai-command-center-host-parity.md). Resource
instrumentation and replay-byte retention correction progress under S13 alongside
the one-hour load. Program/device qualification and the full M0 gate remain open.

### First two weeks

| Checkpoint | Owner | Observable output |
|---|---|---|
| Before day 1 | P | Named owners, T0, calendars, Windows access and scope authorization |
| W1 day 2 | B/Q | Existing application-owned process inventory and repeatable baseline collection |
| W1 day 3 | B/P | Representative workload, counting assumptions and Host parity inventory draft |
| W1 day 5 | F/Q | Four-surface interaction probe and platform/app matrix; no capacity claim from a visual prototype |
| W2 day 2 | B/F/Q | Native-program constraints, runtime feasibility results and draft protocol/receipt contracts |
| W2 day 3 | B/Q/P | M0 review: record pass, redesign required or specific missing inputs; approve the dependent P1 scope only when ready |
| W2 days 4-5 | B/F; Q harness | Begin P1 according to capacity, with one-owner handoff and migration tests defined before implementation |

### Weekly control loop

At the start of each week, each owner selects tasks that fit the allocation and
have satisfied dependencies. Keep at most one primary implementation task per
developer plus review; shared-schema/database files have one named edit owner.
At week's end, demonstrate the representative path, review actual versus planned
effort by role, refresh the risk/decision register and publish the next forecast.
A milestone closes only with its evidence; completion percentages are not inferred
from code volume or elapsed time.

Each implementation work item uses its own branch/worktree from refreshed remote
main, preserves unrelated work, and synchronizes relevant specs and E2E scenarios.
Reuse compatible host toolchains. Validate task candidates before authorized PR
publication and actual integration candidates before merge, per repository policy.
Do not merge into local main merely to test. Never run `verify:ui:*` without an
explicit request, and do not treat this workflow document as permission to commit,
push, merge, deploy, spend on providers or contact other people.

## Planning validation and status

The schedule's role/day arithmetic, phase totals, dependency ordering, dated
examples, links and AC coverage were checked for the planning artifact. The
[P0 baseline report](ai-command-center-p0-baseline.md) now records executed runtime
measurements: 12/36 sessions passed the bounded 128-KiB fixture, while 36 sessions
at 512 KiB exposed Host RPC overload. The subsequent
[1 MiB correction and validation](ai-command-center-1mib-validation.md) passes
12/36 sessions, repeated load, extended UTF-8 output and restart reads. These
close the scoped overload correction, not S01/S02 or M0. Full product gates
remain unqualified, staffing is unassigned, and proposed dates are not committed.

P0 follow-up output: S02 identity/admission/goal/receipt semantics and 19 concrete
race scenarios are documented, with source-grounded capability gaps and S03
handoff fault cases. Existing AgentHost and RACP suites validate reuse seams;
they do not imply the proposed command-center APIs or 12/36 quota repositories
already exist. The one-hour run supplies its own completed/failed evidence,
separate from this preparation progress.
