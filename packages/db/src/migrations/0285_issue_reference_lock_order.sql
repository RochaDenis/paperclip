-- Canonical write-side lock order for tables that reference both `issues` and
-- `heartbeat_runs`.
--
-- An INSERT (or a key-changing UPDATE) into a table with foreign keys to both
-- tables takes a `FOR KEY SHARE` row lock on the referenced `issues` row AND on
-- the referenced `heartbeat_runs` row, through the referential-integrity
-- triggers. PostgreSQL fires AFTER ROW triggers in alphabetical order of trigger
-- name, and RI triggers are named `RI_ConstraintTrigger_c_<oid>`: the order a
-- single write reaches those two row locks is decided by OID text sort, is
-- neither the column order nor the constraint creation order, and differs
-- between databases that ran the same migrations. On the embedded-Postgres
-- fixture, `cost_events` and `connection_token_issuances` reach `heartbeat_runs`
-- first while `company_secret_proposals` reaches `issues` first.
--
-- When the write reaches `heartbeat_runs` first it inverts the canonical
-- `issues` -> `heartbeat_runs` order the execution-lock reconciler uses
-- (`adoptStaleCheckoutRun`, `clearExecutionRunIfTerminal`,
-- `clearCheckoutRunIfTerminal`, `adoptUnownedCheckoutRun`,
-- `scheduleBoundedRetryForRun`), and the pair deadlocks: Postgres aborts one of
-- them, which loses an agent execution.
--
-- This trigger takes the referenced issue row lock before the RI triggers run,
-- so the write side always reaches `issues` first. Those reconciler entry
-- points lock `issues` before `heartbeat_runs`, so with this trigger every
-- transaction that touches both tables acquires them in one total order and the
-- cycle is gone. A transaction that already holds a `heartbeat_runs` lock
-- before writing joins at `issues`; that is why the reconciler order has to
-- stay canonical everywhere it is reachable.
--
-- `FOR KEY SHARE` is deliberately the same lock the RI trigger itself takes: it
-- orders the writer behind an execution-lock `FOR UPDATE` on the same issue
-- while remaining compatible with every other writer and with ordinary UPDATEs,
-- so hot tables (`issue_comments`, `tool_call_events`, `cost_events`) keep
-- their concurrency. A stronger `FOR UPDATE` here would serialize all writers
-- of one issue and would bring the deadlock class back through the FK triggers.
--
-- Coverage is enforced by `src/dual-fk-issue-lock-order.test.ts`: it enumerates
-- every table with a foreign key into `issues` and into `heartbeat_runs`, and
-- fails when one is missing this trigger or one of its issue columns.
CREATE OR REPLACE FUNCTION lock_issue_reference_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  issue_column text;
  referenced_issue_id uuid;
BEGIN
  FOREACH issue_column IN ARRAY TG_ARGV LOOP
    EXECUTE format('SELECT ($1).%I', issue_column) INTO referenced_issue_id USING NEW;
    IF referenced_issue_id IS NOT NULL THEN
      PERFORM 1 FROM public.issues WHERE public.issues.id = referenced_issue_id FOR KEY SHARE;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "chat_github_reviews"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "origin_issue_id"
  ON "company_secret_proposals"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('origin_issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "connection_token_issuances"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "cost_events"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "origin_issue_id"
  ON "decision_bundles"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('origin_issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "origin_issue_id"
  ON "decisions"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('origin_issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "document_annotation_comments"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "environment_leases"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "owner_issue_id"
  ON "execution_workspace_runtime_leases"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('owner_issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "finance_events"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "evaluation_issue_id"
  ON "heartbeat_run_watchdog_decisions"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('evaluation_issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "issue_attachments"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "issue_comments"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "issue_execution_decisions"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "issue_inbox_archives"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "source_issue_id"
  ON "issue_plan_decompositions"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('source_issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "issue_question_response_deliveries"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "issue_thread_interactions"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id", "parent_issue_id"
  ON "issue_tree_hold_members"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id', 'parent_issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "root_issue_id"
  ON "issue_tree_holds"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('root_issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id", "watchdog_issue_id"
  ON "issue_watchdogs"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id', 'watchdog_issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "issue_work_products"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "parent_id"
  ON "issues"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('parent_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "native_run_finalizations"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "native_run_results"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "generation_issue_id"
  ON "status_card_updates"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('generation_issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "tool_call_events"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "tool_gateway_sessions"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "tool_invocations"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "work_assessments"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "workspace_operations"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER lock_issue_reference_before_write
  BEFORE INSERT OR UPDATE OF "issue_id"
  ON "workspace_runtime_services"
  FOR EACH ROW EXECUTE FUNCTION lock_issue_reference_before_write('issue_id');
