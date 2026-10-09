import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

const notification = {
  type: "result", subtype: "success", origin: { kind: "task-notification" },
  session_id: "notification-session", result: "background notification",
  usage: { input_tokens: 999, output_tokens: 999 },
};
const terminal = {
  type: "result", subtype: "success", session_id: "main-session",
  result: "main work completed", usage: { input_tokens: 2, output_tokens: 3 },
};

describe("Claude task notifications through the real CLI process", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function runFixture(body: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-notification-process-"));
    directories.push(root);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
    const command = path.join(root, "fixture.cjs");
    await writeFile(command, `#!${process.execPath}\n
if (process.argv.includes('--version')) { console.log('2.1.280 (Claude Code)'); process.exit(0); }
const emit = event => console.log(JSON.stringify(event));
const notification = ${JSON.stringify(notification)};
const terminal = ${JSON.stringify(terminal)};
${body}\n`);
    await chmod(command, 0o700);
    const result = await execute({
      runId: "notification-process-test",
      agent: { id: "fixture-agent", companyId: "fixture-company", name: "Fixture", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command, cwd: root, promptTemplate: "Fixture only", timeoutSec: 5, graceSec: 1, terminalResultCleanupGraceMs: 100 },
      context: {}, onLog: async () => {},
    });
    return { result, root };
  }

  it("keeps working beyond the notification grace and cleans up after the genuine final result", async () => {
    const { result, root } = await runFixture(`
emit(notification);
setTimeout(() => {
  require('node:fs').writeFileSync('work-completed', 'yes');
  emit({ type: 'assistant', session_id: 'main-session', message: { content: [{ type: 'text', text: 'continued work' }] } });
  emit(terminal);
}, 500);
setInterval(() => {}, 1000);
`);
    expect(await readFile(path.join(root, "work-completed"), "utf8")).toBe("yes");
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("main work completed");
    expect(result.sessionId).toBe("main-session");
    expect(result.usage).toMatchObject({ inputTokens: 2, outputTokens: 3 });
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({ kind: "terminal_result_cleanup", terminalResultSeen: true, stopped: true });
  }, 10_000);

  it("retains legacy pretty-printed JSON final results", async () => {
    const { result } = await runFixture("console.log(JSON.stringify(terminal, null, 2));");
    expect(result.summary).toBe("main work completed");
    expect(result.sessionId).toBe("main-session");
    expect(result.usage).toMatchObject({ inputTokens: 2, outputTokens: 3 });
  }, 10_000);

  it("preserves genuine error results and their cleanup", async () => {
    const { result } = await runFixture(`
emit({ ...terminal, subtype: 'error_max_turns', is_error: true });
emit(notification);
setInterval(() => {}, 1000);
`);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("max_turns_exhausted");
    expect(result.clearSession).toBe(true);
    expect(result.sessionId).toBe("main-session");
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({ terminalResultSeen: true, stopped: true });
  }, 10_000);

  it("does not promote a lone JSON notification through the non-stream fallback", async () => {
    const { result } = await runFixture("emit(notification);");
    expect(result.timedOut).toBe(false);
    expect(result.resultJson).not.toHaveProperty("origin");
    expect(result.resultJson?.stdout).toContain('"task-notification"');
    expect(result.sessionId).toBeUndefined();
    expect(result.usage).toBeUndefined();
    expect(result.summary).toBeUndefined();
  }, 10_000);
});
