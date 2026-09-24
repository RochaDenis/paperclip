import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// A table that references BOTH `issues` and `heartbeat_runs` makes every write
// take a `FOR KEY SHARE` row lock on the referenced issue row and run row
// through the referential-integrity triggers. PostgreSQL fires those AFTER ROW
// triggers in trigger-name order, and RI triggers are named
// `RI_ConstraintTrigger_c_<oid>`, so the order a single write reaches the two
// rows is decided by OID text sort and differs between databases. When it
// reaches `heartbeat_runs` first it inverts the canonical `issues` ->
// `heartbeat_runs` order the execution-lock reconciler uses, and the pair
// deadlocks — each abort loses an agent execution.
//
// Migration 0285 installs a BEFORE INSERT/UPDATE trigger on every such table
// that takes the issue lock first, so the write side always reaches `issues`
// first. These tests pin the interleaving (with the inverted RI order forced,
// so they do not depend on which OID happens to sort first) and the coverage of
// the trigger set.

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  await sql`INSERT INTO companies (id,name,issue_prefix) VALUES (${ids.company},'Dual FK fixture','DFK')`;
  await sql`INSERT INTO agents (id,company_id,name) VALUES (${ids.agent},${ids.company},'Agent')`;
  await sql`INSERT INTO issues (id,company_id,title,status) VALUES (${ids.issue},${ids.company},'Fixture','in_progress')`;
  await sql`INSERT INTO heartbeat_runs (id,company_id,agent_id,status) VALUES (${ids.run},${ids.company},${ids.agent},'failed')`;
  return ids;
}

describeDatabase("dual foreign key issue lock order", () => {
  it(
    "commits the write when the RI triggers are forced to reach heartbeat_runs first",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-dual-fk-order-");
      const setup = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      const reconciler = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      const writer = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const ids = await seed(setup);

        // Force the inverted order the production database measured: rename the
        // issues-side INSERT check trigger so it sorts after the
        // heartbeat_runs-side one. The order now reaches `heartbeat_runs`
        // first, deterministically, on every PostgreSQL version.
        const [issuesCheck] = await setup<{ tgname: string }[]>`
          SELECT t.tgname
          FROM pg_constraint c
          JOIN pg_trigger t ON t.tgconstraint = c.oid AND t.tgrelid = c.conrelid
          WHERE c.conrelid = 'issue_comments'::regclass
            AND c.confrelid = 'issues'::regclass
            AND t.tgname LIKE 'RI_ConstraintTrigger_c_%'
            AND (t.tgtype & 4) = 4`;
        expect(issuesCheck?.tgname).toBeTruthy();
        await setup.unsafe(
          `ALTER TRIGGER "${issuesCheck.tgname}" ON issue_comments RENAME TO zz_forced_issues_ri_check`,
        );

        // Transaction A is the canonical execution-lock order: issues first,
        // then heartbeat_runs.
        const transactionA = reconciler
          .begin(async (tx) => {
            await tx`SELECT id FROM issues WHERE id = ${ids.issue} FOR UPDATE`;
            await sleep(1500);
            await tx`SELECT id FROM heartbeat_runs WHERE id = ${ids.run} FOR UPDATE`;
          })
          .then(() => "committed" as const)
          .catch((error: Error) => `failed: ${error.message}`);

        await sleep(300);

        // Transaction B writes a row that references the same issue and run.
        const transactionB = writer
          .begin(async (tx) => {
            await tx`INSERT INTO issue_comments (company_id, issue_id, created_by_run_id, body)
                     VALUES (${ids.company}, ${ids.issue}, ${ids.run}, 'comment')`;
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
        await writer.end();
        await database.cleanup();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "covers every issue column of every table that references issues and heartbeat_runs",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-dual-fk-coverage-");
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const issueColumns = await sql<{ table_name: string; column_name: string }[]>`
          SELECT c.conrelid::regclass::text AS table_name, att.attname::text AS column_name
          FROM pg_constraint c
          JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
          JOIN unnest(c.confkey) WITH ORDINALITY AS r(attnum, ord) ON r.ord = k.ord
          JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k.attnum
          JOIN pg_attribute refatt ON refatt.attrelid = c.confrelid AND refatt.attnum = r.attnum
          WHERE c.contype = 'f'
            AND c.confrelid = 'issues'::regclass
            AND refatt.attname = 'id'
            AND EXISTS (
              SELECT 1 FROM pg_constraint d
              WHERE d.contype = 'f' AND d.conrelid = c.conrelid
                AND d.confrelid = 'heartbeat_runs'::regclass
            )
          GROUP BY 1, 2
          ORDER BY 1, 2`;

        const definitions = await sql<{ table_name: string; definition: string }[]>`
          SELECT c.conrelid::regclass::text AS table_name,
                 pg_get_triggerdef(t.oid) AS definition
          FROM pg_constraint c
          JOIN pg_trigger t ON t.tgrelid = c.conrelid
          WHERE t.tgname = 'lock_issue_reference_before_write'
          GROUP BY 1, 2`;

        const columnsByTable = new Map<string, string[]>();
        for (const row of issueColumns) {
          const columns = columnsByTable.get(row.table_name) ?? [];
          columns.push(row.column_name);
          columnsByTable.set(row.table_name, columns);
        }

        // The sweep is only as good as its coverage: a table added later with
        // the same double reference must ship this trigger in the same change.
        expect(columnsByTable.size).toBeGreaterThan(0);
        for (const [table, columns] of columnsByTable) {
          const definition = definitions.find((entry) => entry.table_name === table)?.definition;
          expect(definition, `missing lock_issue_reference_before_write trigger on ${table}`).toBeTruthy();
          expect(definition).toContain("BEFORE INSERT OR UPDATE OF");
          for (const column of columns) {
            expect(definition).toContain(`'${column}'`);
          }
        }

        const [fn] = await sql<{ definition: string }[]>`
          SELECT pg_get_functiondef('lock_issue_reference_before_write()'::regprocedure) AS definition`;
        expect(fn.definition).toContain("FOR KEY SHARE");
      } finally {
        await sql.end();
        await database.cleanup();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "keeps referential integrity for writes that reference a missing issue",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-dual-fk-integrity-");
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const ids = await seed(sql);
        await expect(
          sql`INSERT INTO issue_comments (company_id, issue_id, body)
              VALUES (${ids.company}, ${randomUUID()}, 'orphan')`,
        ).rejects.toMatchObject({ code: "23503" });
        await expect(
          sql`INSERT INTO issue_comments (company_id, issue_id, body)
              VALUES (${ids.company}, ${ids.issue}, 'valid')`,
        ).resolves.toBeDefined();
      } finally {
        await sql.end();
        await database.cleanup();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
