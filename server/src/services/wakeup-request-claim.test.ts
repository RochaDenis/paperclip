import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { claimableWakeRequest, observedWakeClaim, lockNativeWakeAdmission, type WakeClaimSnapshot } from "./wakeup-request-claim.js";

const support = await getEmbeddedPostgresTestSupport();
const postgresSuite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Wake claim PostgreSQL tests unavailable: ${support.reason}`);

postgresSuite("shared wake request claims", () => {
  let db: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string;
  let agentId: string;
  const now = new Date("2026-10-09T12:00:00.000Z");

  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-wake-claims-");
    db = createDb(fixture.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Wake claims", issuePrefix: "CLM" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claim owner", role: "engineer" });
  }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  async function seed(patch: Partial<typeof agentWakeupRequests.$inferInsert> = {}) {
    const [row] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", ...patch,
    }).returning();
    return row!;
  }

  it("excludes live claims before applying the batch limit", async () => {
    const reason = randomUUID();
    await seed({ reason, status: "claimed", claimedAt: now, requestedAt: new Date(0) });
    const queued = await seed({ reason, requestedAt: new Date(1) });
    const rows = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.reason, reason), claimableWakeRequest(now, 60_000),
    )).orderBy(asc(agentWakeupRequests.requestedAt)).limit(1);
    expect(rows.map(row => row.id)).toEqual([queued.id]);
  });

  it.each([null, new Date(0)])("only one worker renews an observed expired claim (%s)", async (claimedAt) => {
    const snapshot = await seed({ status: "claimed", claimedAt });
    const results = await Promise.all([1, 2].map(() => db.update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: now })
      .where(observedWakeClaim(snapshot)).returning()));
    expect(results.flat()).toHaveLength(1);
  });

  it("fences a late worker's failure update after another worker replaces its lease", async () => {
    const previous = await seed({ status: "claimed", claimedAt: new Date(0) });
    await db.update(agentWakeupRequests).set({ claimedAt: now }).where(observedWakeClaim(previous));
    const staleWrite = await db.update(agentWakeupRequests)
      .set({ status: "queued", claimedAt: null, error: "late failure" })
      .where(observedWakeClaim(previous)).returning();
    expect(staleWrite).toHaveLength(0);
    const [current] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, previous.id));
    expect(current).toMatchObject({ status: "claimed", claimedAt: now, error: null });
  });

  it("does not claim a linked request or a different company or agent", async () => {
    const snapshot = await seed();
    for (const scope of [{ companyId: randomUUID() }, { agentId: randomUUID() }]) {
      const result = await db.update(agentWakeupRequests).set({ status: "claimed", claimedAt: now })
        .where(observedWakeClaim({ ...snapshot, ...scope })).returning();
      expect(result).toHaveLength(0);
    }
    await db.update(agentWakeupRequests).set({ runId: randomUUID() }).where(eq(agentWakeupRequests.id, snapshot.id));
    const result = await db.update(agentWakeupRequests).set({ status: "claimed", claimedAt: now })
      .where(observedWakeClaim(snapshot)).returning();
    expect(result).toHaveLength(0);
  });

  async function nativeIntent() {
    return seed({
      status: "claimed", claimedAt: new Date(0), payload: { issueId: randomUUID() },
      requestedByActorType: "system", requestedByActorId: "native-status-committer",
    });
  }

  async function admit(claim: WakeClaimSnapshot, issueId: string) {
    return db.transaction(async (tx) => {
      const admission = await lockNativeWakeAdmission(tx as unknown as typeof db, claim, issueId);
      if (admission.kind !== "claimed") return admission;
      const [receipt] = await tx.insert(agentWakeupRequests).values({
        companyId, agentId, source: "automation", status: "completed",
        payload: { issueId }, requestedByActorType: "system",
        requestedByActorId: `native-status-wake-dispatch:${claim.id}`,
      }).returning();
      const [run] = await tx.insert(heartbeatRuns).values({
        companyId, agentId, status: "succeeded", invocationSource: "automation",
        wakeupRequestId: receipt!.id, contextSnapshot: { issueId },
      }).returning();
      await tx.update(agentWakeupRequests).set({ runId: run!.id }).where(eq(agentWakeupRequests.id, receipt!.id));
      return { kind: "created" as const, runId: run!.id };
    });
  }

  it("a slow worker cannot admit after takeover, even when the successor run already finished", async () => {
    const old = await nativeIntent();
    const issueId = String(old.payload!.issueId);
    const successor = { ...old, claimedAt: now };
    await db.update(agentWakeupRequests).set({ claimedAt: now }).where(observedWakeClaim(old));
    const denied = await admit(old, issueId);
    expect(denied.kind).toBe("lost");
    const first = await admit(successor, issueId);
    expect(first.kind).toBe("created");
    const repeated = await admit(old, issueId);
    expect(repeated).toMatchObject({ kind: "recorded", receipt: { runId: first.kind === "created" ? first.runId : null } });
    const receipts = await db.select().from(agentWakeupRequests).where(eq(
      agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${old.id}`,
    ));
    expect(receipts).toHaveLength(1);
  });

  it("recovers a committed receipt and run after a crash before intent linkage", async () => {
    const intent = await nativeIntent();
    const issueId = String(intent.payload!.issueId);
    const first = await admit(intent, issueId);
    const [unlinked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent.id));
    expect(unlinked!.runId).toBeNull();
    const recovered = await admit(intent, issueId);
    expect(recovered).toMatchObject({ kind: "recorded", receipt: { runId: first.kind === "created" ? first.runId : null } });
  });

  it("serializes concurrent receipt creation under the intent lock", async () => {
    const intent = await nativeIntent();
    const results = await Promise.all([1, 2].map(() => admit(intent, String(intent.payload!.issueId))));
    expect(results.map(result => result.kind).sort()).toEqual(["created", "recorded"]);
  });

  it("rejects a forged origin or a mismatched issue before creating a receipt", async () => {
    const intent = await nativeIntent();
    expect((await admit(intent, randomUUID())).kind).toBe("lost");
    await db.update(agentWakeupRequests).set({ requestedByActorType: "user" }).where(eq(agentWakeupRequests.id, intent.id));
    expect((await admit(intent, String(intent.payload!.issueId))).kind).toBe("lost");
  });
});
