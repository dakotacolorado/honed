import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeJudge, decisionJsonSchema, render, type Case } from "./judge.ts";

const c: Case = { skill: "x", version: 0, maxChars: 20_000, files: [], others: [], feedback: [], precedent: [], failure: null, guidance: "" };

test("the decision schema carries no $schema, which Claude Code refuses", () => {
  const schema = decisionJsonSchema();
  assert.equal("$schema" in schema, false);
  assert.equal(schema.type, "object");
});

test("a case for a skill that does not exist yet says so, with the cap", () => {
  assert.match(render(c), /<skill name="x" version="0" characters="0" cap="20000">\nnone: the skill does not exist yet/);
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
  const decision = { reasoning: "r", changed: false, note: "", write: [], remove: [] };
  const claude = await fakeClaude({ is_error: false, structured_output: decision });
  try {
    assert.deepEqual(await new ClaudeJudge({ command: claude.path }).decide(c), decision);
  } finally {
    await claude.done();
  }
});

test("a session that errs fails with what Claude Code said", async () => {
  const claude = await fakeClaude({ is_error: true, result: "usage limit reached" }, 1);
  try {
    await assert.rejects(new ClaudeJudge({ command: claude.path }).decide(c), /usage limit reached/);
  } finally {
    await claude.done();
  }
});

test("the system prompt is the fixed brief, then the honed-judge skill's guidance, and the brief wins", async () => {
  const { systemPrompt, JUDGE_CONTRACT } = await import("./judge.ts");
  const prompt = systemPrompt("## Weigh the evidence\nBe careful.");
  assert.ok(prompt.startsWith(JUDGE_CONTRACT));
  assert.match(prompt, /Where it conflicts with this brief, this brief wins/);
  assert.match(prompt, /# Your judging guidance \(the honed-judge skill\)\n\n## Weigh the evidence\nBe careful\.\n$/);
});
