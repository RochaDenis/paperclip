# Native wake admission reliability

## Partial root cause

At base `3b23027aaca2d7e8dbd16889176007da2d9c7a4e`, two dispatchers can read
the same expired native wake claim. The update checks `status = claimed` but
not the observed claim time. Both workers can renew it. A PostgreSQL test
with two service instances reproduced two dispatch receipts for one intent.
Fresh claims also consume the query limit before the loop rejects them.
This can hide eligible requests behind a batch of active leases.

This finding does not establish the cause of any historical incident.
The native outbox and ordinary comment requests have different producers.
Comment routes call `heartbeat.wakeup` with the real actor and comment or
interaction identity. The native status committer writes a system outbox
intent. This change preserves that origin filter.

## Admission contract

- Select only queued or expired claims before applying the batch limit.
- Compare company, agent, request, status and claim time when taking a lease.
- Fence every later write with the worker's own claim snapshot.
- Lock the issue, then the intent, inside the existing admission transaction.
- Keep the intent lock until the dispatch receipt and run commit.
- Reconcile an existing receipt before any repeated admission.
- Keep a distinct receipt and structured execution wait when a gate denies admission.
- Count a lost claim separately from a successful recovery or dispatch.

The final intent-to-run link can lag the receipt transaction. A later scan
recovers that receipt. No new timer, schema, authorization grant or production
flag is needed. The claim is internal service state, never caller-supplied
payload authority. External provider effects still require their own durable
idempotency and reconciliation contract.

## Incremental work plan

| Task | Dependency | Acceptance |
| --- | --- | --- |
| E0: reproduce and map producers/consumers | None | Real database reproduction; historical unknowns explicit |
| E1: request-specific admission diagnostics and scan receipts | E0 | Sanitized company-scoped decision, actor category, reason and scan identity |
| E2a: native outbox admission fencing (this change) | E0 | Concurrent and slow workers cannot repeat admission; gate waits remain structured |
| E2b: comment deduplication and orphan request recovery | E0, E1 | Exact comment identity; distinct input preserved; decision within two completed cycles |
| E3: durable checkpoints, retry lineage and escalation | E1, E2 | Restart cannot reset retry budget; terminal gap has an explicit owner and next action |
| E4: integrated acceptance | E1, E3 | Exact scope, parent, SHA, required checks and current review; required SKIP is not PASS |
| E5: integrated verification | E1–E4 | Required fault matrix, isolation and gate checks pass |
| E6: reviewed release proposal | E5 | Separate operator approval and reversible rollout; this PR remains draft |

E2a does not complete the global plan. Tests for exhausted retry across restart,
terminal-without-checkpoint, revoked authorization, wrong parent and required
versus optional SKIP remain part of the later tasks. Existing pause, dependency,
configuration, budget and concurrency gates remain authoritative.

## Measurement

The proposed primary target is at least 90% of eligible tasks completing with
valid integrated acceptance and no corrective human intervention over the whole
episode. One initial advance cannot satisfy this target. Later stalls or
interventions invalidate provisional success. Expected review is a normal gate.

Freeze a seven-day cohort of unique tasks at eligibility. Do not count comments,
retries or duplicate requests as new tasks. Report open/censored tasks, legitimate
blocks and exclusions separately. Once a cohort matures, incomplete tasks stay
in the denominator and out of the numerator. Record late completion separately.
Baseline and a representative minimum sample are not yet known.

Pre-eligibility pauses, human-only work, planned approval/dependency waits and
cancellations have explicit exclusion counts. Unexpected failures after
eligibility cannot remove tasks retrospectively. Stage progress is a secondary
metric. Also report decision latency in cycles and wall time, completed scan
age, duplicate admissions, retry counts and gate violations.

## Validation and future rollout

Use PostgreSQL tests for concurrent stale claims, lease takeover, receipt recovery,
and company/agent isolation. Exercise the full dispatcher for slow workers with
active and paused agents. Use synthetic adapter configuration and a temporary
Paperclip home; never use developer credentials or weaken the real gates.

Before a future release, run the full fault matrix and all required repository
checks on the exact head SHA. A proposed staging cohort contains at least 100
synthetic eligible tasks, two workers and one complete observation window.
Require at least 90% valid completion, every legitimate request decided within
two completed scans, no duplicate admission or gate bypass, and no p95 latency
regression. Production baseline remains a separate requirement.

Stop promotion on any pause/auth violation or duplicate effect. Investigate a
completion drop over five percentage points or p95 latency growth over 20%.
The existing authorized release operator owns escalation and any release.
Do not treat a mixed-version fleet as fenced: older dispatchers do not honor
the new intent lock and lease predicates. A future operator must drain the old
consumers through the existing approved operational path before resuming scans
on the new version. This PR does not perform that operation.
Rollback reverts code while preserving receipts, checkpoints and retry lineage.
Do not reset attempts or repeat unknown external effects. No merge or deployment
is part of this work.
