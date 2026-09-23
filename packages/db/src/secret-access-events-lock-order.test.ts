import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// `secret_access_events` is an audit trail. Every granted-secret read appends a
// row, and the row carries the issue and the heartbeat run it was read for.
// While those two columns carried foreign keys, a single INSERT took a
// `FOR KEY SHARE` row lock on `issues` AND on `heartbeat_runs` — the two hottest
// operational tables — through the referential-integrity triggers.
//
// PostgreSQL fires AFTER ROW triggers in alphabetical order of trigger *name*,
// and RI triggers are named `RI_ConstraintTrigger_c_<oid>`. The order in which
// one INSERT takes those two row locks is therefore decided by OID text sort:
// it is neither the column order nor the constraint creation order, and it can
// differ between databases that ran the same migrations. When it puts
// `heartbeat_runs` first it inverts the canonical `issues` -> `heartbeat_runs`
// order that `issues.ts` uses (clearExecutionRunIfTerminal,
// clearCheckoutRunIfTerminal, adoptStaleCheckout), and the pair deadlocks:
// Postgres aborts one of them, which loses an agent execution.
//
// The fix is that the audit write holds no lock on operational rows at all.
// Both tests below fail on the unfixed schema and neither depends on trigger
// ordering, so they reproduce the production deadlock deterministically.

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

type Fixture = {
  company: string;
  agent: string;
  issue: string;
  run: string;
};

async function seed(sql: postgres.Sql): Promise<Fixture> {
  const ids: Fixture = {
    company: randomUUID(),
    agent: randomUUID(),
    issue: randomUUID(),
    run: randomUUID(),
  };
  await sql`INSERT INTO companies (id,name,issue_prefix) VALUES (${ids.company},'Lock order fixture','LCK')`;
  await sql`INSERT INTO agents (id,company_id,name) VALUES (${ids.agent},${ids.company},'Agent')`;
  await sql`INSERT INTO issues (id,company_id,title,status) VALUES (${ids.issue},${ids.company},'Fixture','in_progress')`;
  await sql`INSERT INTO heartbeat_runs (id,company_id,agent_id,status) VALUES (${ids.run},${ids.company},${ids.agent},'failed')`;
  return ids;
}

function insertAuditEvent(sql: postgres.Sql | postgres.TransactionSql, ids: Fixture) {
  return sql`
    INSERT INTO secret_access_events
      (company_id, provider, actor_type, consumer_type, consumer_id, issue_id, heartbeat_run_id, outcome)
    VALUES
      (${ids.company}, 'paperclip', 'agent', 'agent', ${ids.agent}, ${ids.issue}, ${ids.run}, 'success')`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDatabase("secret_access_events lock order", () => {
  it(
    "appends the audit row while another transaction holds the issue and run rows",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-secret-access-lock-");
      const holder = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      const writer = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const ids = await seed(holder);

        // The execution-lock reconciler holds both rows for the length of its
        // transaction. An audit append that waits on either of them is what
        // makes the deadlock possible in the first place.
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const held = holder.begin(async (tx) => {
          await tx`SELECT id FROM issues WHERE id = ${ids.issue} FOR UPDATE`;
          await tx`SELECT id FROM heartbeat_runs WHERE id = ${ids.run} FOR UPDATE`;
          await released;
        });

        await sleep(250);
        // A short statement timeout turns "blocked on an operational row" into
        // a fast, legible failure instead of a hang.
        await writer`SET statement_timeout = 3000`;
        await expect(insertAuditEvent(writer, ids)).resolves.toBeDefined();

        release();
        await held;
      } finally {
        await holder.end();
        await writer.end();
        await database.cleanup();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "does not deadlock when the audit append reaches the two rows in inverted order",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-secret-access-deadlock-");
      const setup = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      const reconciler = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      const auditor = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const ids = await seed(setup);

        // Transaction A is the canonical order used across issues.ts:
        // issues first, then heartbeat_runs.
        const transactionA = reconciler
          .begin(async (tx) => {
            await tx`SELECT id FROM issues WHERE id = ${ids.issue} FOR UPDATE`;
            await sleep(1500);
            await tx`SELECT id FROM heartbeat_runs WHERE id = ${ids.run} FOR UPDATE`;
          })
          .then(() => "committed" as const)
          .catch((error: Error) => `failed: ${error.message}`);

        await sleep(300);

        // Transaction B reaches the same two rows in the inverted order: the
        // run row first, then whatever the audit INSERT itself needs. This is
        // the production interleaving, made deterministic — it no longer
        // depends on which RI trigger name happens to sort first.
        const transactionB = auditor
          .begin(async (tx) => {
            await tx`SELECT id FROM heartbeat_runs WHERE id = ${ids.run} FOR KEY SHARE`;
            await insertAuditEvent(tx, ids);
          })
          .then(() => "committed" as const)
          .catch((error: Error) => `failed: ${error.message}`);

        expect(await Promise.all([transactionA, transactionB])).toEqual([
          "committed",
          "committed",
        ]);
      } finally {
        await setup.end();
        await reconciler.end();
        await auditor.end();
        await database.cleanup();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the audit table free of foreign keys into issues and heartbeat_runs",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-secret-access-fk-");
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await sql<{ conname: string; referenced: string }[]>`
          SELECT c.conname, c.confrelid::regclass::text AS referenced
          FROM pg_constraint c
          WHERE c.conrelid = 'secret_access_events'::regclass
            AND c.contype = 'f'
            AND c.confrelid::regclass::text IN ('issues', 'heartbeat_runs')`;
        expect(rows).toEqual([]);
      } finally {
        await sql.end();
        await database.cleanup();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
