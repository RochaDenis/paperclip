import { and, eq, isNull, lte, or } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

export type WakeClaimSnapshot = Pick<
  typeof agentWakeupRequests.$inferSelect,
  "id" | "companyId" | "agentId" | "status" | "claimedAt"
>;

/** Filter before LIMIT so live claims cannot hide claimable work behind them. */
export function claimableWakeRequest(now: Date, staleClaimMs: number) {
  return and(
    isNull(agentWakeupRequests.runId),
    or(
      eq(agentWakeupRequests.status, "queued"),
      and(
        eq(agentWakeupRequests.status, "claimed"),
        or(
          isNull(agentWakeupRequests.claimedAt),
          lte(agentWakeupRequests.claimedAt, new Date(now.getTime() - staleClaimMs)),
        ),
      ),
    ),
  );
}

/**
 * Compare the observed lease, not just its status. A competing sweeper can
 * renew a claimed row without changing status. The same predicate fences
 * writes by a worker whose lease was replaced while admission was pending.
 */
export function observedWakeClaim(snapshot: WakeClaimSnapshot) {
  return and(
    eq(agentWakeupRequests.id, snapshot.id),
    eq(agentWakeupRequests.companyId, snapshot.companyId),
    eq(agentWakeupRequests.agentId, snapshot.agentId),
    eq(agentWakeupRequests.status, snapshot.status),
    isNull(agentWakeupRequests.runId),
    snapshot.claimedAt
      ? eq(agentWakeupRequests.claimedAt, snapshot.claimedAt)
      : isNull(agentWakeupRequests.claimedAt),
  );
}

/**
 * Caller holds the issue lock, then retains this intent lock until it commits
 * the dispatch receipt and run. A lease check without the lock would allow
 * takeover between the check and the write. This is internal dispatch state,
 * never authority accepted from a request payload or a run context.
 */
export async function lockNativeWakeAdmission(
  tx: Db,
  claim: WakeClaimSnapshot,
  issueId: string,
) {
  const [intent] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, claim.id),
    eq(agentWakeupRequests.companyId, claim.companyId),
    eq(agentWakeupRequests.agentId, claim.agentId),
    eq(agentWakeupRequests.requestedByActorType, "system"),
    eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
  )).for("update");
  // The native committer always writes the canonical issueId on its intent.
  // A malformed/unscoped intent must not fall into unscoped agent admission.
  if (!intent || intent.payload?.issueId !== issueId) return { kind: "lost" as const };

  const [receipt] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, claim.companyId),
    eq(agentWakeupRequests.agentId, claim.agentId),
    eq(agentWakeupRequests.requestedByActorType, "system"),
    eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${claim.id}`),
  )).limit(1);
  if (receipt) return { kind: "recorded" as const, receipt };
  if (intent.status !== "claimed" || intent.runId !== null || !claim.claimedAt ||
      intent.claimedAt?.getTime() !== claim.claimedAt.getTime()) {
    return { kind: "lost" as const };
  }
  return { kind: "claimed" as const };
}
