import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeJudge, decisionJsonSchema, render, type Case } from "./judge.ts";

const c: Case = {
  skill: "x",
  policy: "judge",
  version: 0,
  files: [],
  others: [],
  proposals: [],
  feedback: [],
  precedent: [],
};

test("the decision schema carries no $schema, which Claude Code refuses", () => {
  const schema = decisionJsonSchema();
  assert.equal("$schema" in schema, false);
  assert.equal(schema.type, "object");
});

test("a case for a skill that does not exist yet says so", () => {
  assert.match(render(c), /the skill does not exist yet/);
});

/** A stand-in for Claude Code that prints `output` and exits with `code`. */
async function fakeClaude(output: unknown, code = 0): Promise<{ path: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "honed-claude-"));
  const path = join(dir, "claude");
  await writeFile(path, `#!/bin/sh\ncat >/dev/null\ncat <<'EOF'\n${JSON.stringify(output)}\nEOF\nexit ${code}\n`);
  await chmod(path, 0o755);
  return { path, done: () => rm(dir, { recursive: true, force: true }) };
}

test("reads the decision from Claude Code's structured output", async () => {
  const decision = { reasoning: "r", outcome: "no_change", note: "", change: { write: [], remove: [] }, proposals: [] };
  const claude = await fakeClaude({ is_error: false, structured_output: decision });
  try {
    assert.deepEqual(await new ClaudeJudge({ command: claude.path }).rule(c), decision);
  } finally {
    await claude.done();
  }
});

test("a session that errs fails with what Claude Code said", async () => {
  const claude = await fakeClaude({ is_error: true, result: "usage limit reached" }, 1);
  try {
    await assert.rejects(new ClaudeJudge({ command: claude.path }).rule(c), /usage limit reached/);
  } finally {
    await claude.done();
  }
});
