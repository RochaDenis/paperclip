/**
 * STO-7578 item 3: stopgap throttle for codex_local process starts.
 *
 * Until every codex_local agent gets an isolated CODEX_HOME (STO-7578 items
 * 1-2), concurrent Codex process starts share one sqlite state file under
 * the company codex-home, and the sqlite runtime fails to initialize when
 * several open at once ("failed to initialize sqlite state runtime"). This
 * caps codex_local process starts to at most one per MIN_INTERVAL_MS across
 * the whole server process until that fix is live everywhere; remove once
 * the per-agent CODEX_HOME isolation has fully rolled out.
 */

export const CODEX_LOCAL_START_MIN_INTERVAL_MS = 60_000;

export interface CodexLocalStartThrottleDecision {
  /** How long the caller must wait before it may start its Codex process. */
  waitMs: number;
}

// Test-only override: suites that start several codex_local runs (with a
// mocked adapter, never a real sqlite file) would otherwise pay the real
// 60s wall-clock gap between starts and blow past their own timeouts. See
// setup-supertest.ts, which zeroes this out for every server test file.
let minIntervalOverrideMsForTests: number | null = null;

export function setCodexLocalStartMinIntervalMsForTests(ms: number | null): void {
  minIntervalOverrideMsForTests = ms;
}

export function resolveCodexLocalStartMinIntervalMs(): number {
  return minIntervalOverrideMsForTests ?? CODEX_LOCAL_START_MIN_INTERVAL_MS;
}

/**
 * Pure decision function: given the last recorded start time, how long must
 * the next start wait so starts stay at least `minIntervalMs` apart.
 */
export function evaluateCodexLocalStartThrottle(
  nowMs: number,
  lastStartAtMs: number | null,
  minIntervalMs: number = CODEX_LOCAL_START_MIN_INTERVAL_MS,
): CodexLocalStartThrottleDecision {
  if (lastStartAtMs === null) return { waitMs: 0 };
  const nextAllowedStartAtMs = lastStartAtMs + minIntervalMs;
  return { waitMs: Math.max(0, nextAllowedStartAtMs - nowMs) };
}
