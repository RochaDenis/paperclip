import { describe, expect, it } from "vitest";
import {
  CODEX_LOCAL_START_MIN_INTERVAL_MS,
  evaluateCodexLocalStartThrottle,
} from "../services/codex-local-start-throttle.ts";

describe("evaluateCodexLocalStartThrottle", () => {
  it("never waits for the first start (no prior start recorded)", () => {
    expect(evaluateCodexLocalStartThrottle(1_000, null)).toEqual({ waitMs: 0 });
  });

  it("waits out the remainder of the interval when starts bunch up", () => {
    const lastStartAtMs = 0;
    const nowMs = 10_000;
    const decision = evaluateCodexLocalStartThrottle(nowMs, lastStartAtMs);
    expect(decision.waitMs).toBe(CODEX_LOCAL_START_MIN_INTERVAL_MS - 10_000);
  });

  it("does not wait once the interval has fully elapsed", () => {
    const lastStartAtMs = 0;
    const nowMs = CODEX_LOCAL_START_MIN_INTERVAL_MS;
    expect(evaluateCodexLocalStartThrottle(nowMs, lastStartAtMs)).toEqual({ waitMs: 0 });
  });

  it("does not wait when the interval has already passed by a wide margin", () => {
    const lastStartAtMs = 0;
    const nowMs = CODEX_LOCAL_START_MIN_INTERVAL_MS * 5;
    expect(evaluateCodexLocalStartThrottle(nowMs, lastStartAtMs)).toEqual({ waitMs: 0 });
  });

  it("honors a custom minimum interval", () => {
    const decision = evaluateCodexLocalStartThrottle(1_000, 0, 5_000);
    expect(decision.waitMs).toBe(4_000);
  });
});
