import assert from "node:assert/strict";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { test } from "node:test";
import { ClaudeJudge, decisionJsonSchema, render, systemPrompt, type AgentQuery, type Case } from "./judge.ts";

const c: Case = { skill: "x", version: 0, maxChars: 20_000, files: [], others: [], feedback: [], precedent: [], approved: false, failure: null, guidance: "", writingGuide: null };

test("the decision schema carries no $schema, which Claude Code refuses", () => {
  const schema = decisionJsonSchema();
  assert.equal("$schema" in schema, false);
  assert.equal(schema.type, "object");
});

test("a case for a skill that does not exist yet says so, with the cap", () => {
  assert.match(render(c), /<skill name="x" version="0" characters="0" cap="20000">\nnone: the skill does not exist yet/);
});

const decision = { reasoning: "r", changed: false, note: "", edits: [], write: [], remove: [], revert_to: 0, sorted: [], honer_feedback: "" };
const success = (over: object = {}) => ({ type: "result", subtype: "success", is_error: false, result: "", structured_output: decision, ...over }) as unknown as SDKMessage;

/** A stand-in for the Agent SDK's query that yields `messages` (or throws `fail` after them), and keeps what it was asked. */
function fakeQuery(messages: SDKMessage[], fail?: Error) {
  const calls: { prompt: string; options: Options }[] = [];
  const query: AgentQuery = async function* (params) {
    calls.push(params);
    yield* messages;
    if (fail) {
      params.options.stderr?.("boom on stderr\n");
      throw fail;
    }
  };
  return { query, calls };
}

test("asks the Agent SDK for the decision as structured output, with no tools, settings, MCP servers or saved session", async () => {
  const { query, calls } = fakeQuery([{ type: "system", subtype: "init" } as unknown as SDKMessage, success()]);
  assert.deepEqual(await new ClaudeJudge({ query, model: "claude-opus-5-5" }).decide(c), decision);
  const { prompt, options: o } = calls[0]!;
  assert.equal(prompt, render(c));
  assert.deepEqual(o.outputFormat, { type: "json_schema", schema: decisionJsonSchema() });
  assert.equal(o.systemPrompt, systemPrompt(c.guidance));
  assert.deepEqual([o.tools, o.allowedTools, o.mcpServers, o.strictMcpConfig, o.settingSources, o.persistSession], [[], [], {}, true, [], false]);
  assert.equal(o.model, "claude-opus-5-5");
  assert.equal(o.pathToClaudeCodeExecutable, undefined);
  assert.ok(o.abortController instanceof AbortController);
  const plain = fakeQuery([success()]);
  await new ClaudeJudge({ query: plain.query, executable: "/opt/claude" }).decide(c);
  assert.equal(plain.calls[0]!.options.model, undefined, "Claude Code's own model unless one is named");
  assert.equal(plain.calls[0]!.options.pathToClaudeCodeExecutable, "/opt/claude");
});

test("a session that errs fails with what Claude Code said", async () => {
  await assert.rejects(new ClaudeJudge({ query: fakeQuery([success({ is_error: true, result: "usage limit reached" })]).query }).decide(c), /no decision: usage limit reached/);
  const failed = { type: "result", subtype: "error_max_structured_output_retries", is_error: true, errors: ["could not match the schema"] } as unknown as SDKMessage;
  await assert.rejects(new ClaudeJudge({ query: fakeQuery([failed]).query }).decide(c), /could not match the schema/);
  await assert.rejects(new ClaudeJudge({ query: fakeQuery([success({ structured_output: { changed: "yes" } })]).query }).decide(c), /no decision/);
  await assert.rejects(new ClaudeJudge({ query: fakeQuery([]).query }).decide(c), /ended without a result/);
  await assert.rejects(new ClaudeJudge({ query: fakeQuery([], new Error("Claude Code process exited with code 1")).query }).decide(c), /exited with code 1; boom on stderr/);
});

test("a session that runs past the timeout is aborted, and fails saying so", async () => {
  let signal: AbortSignal | undefined;
  const query: AgentQuery = async function* ({ options }) {
    signal = options.abortController!.signal;
    await new Promise((resolve) => signal!.addEventListener("abort", resolve));
    throw new Error("Claude Code process aborted by user");
  };
  await assert.rejects(new ClaudeJudge({ query, timeoutMs: 20 }).decide(c), /did not decide within 0.02s/);
  assert.equal(signal?.aborted, true);
});

test("the system prompt is the fixed brief, then the honed/honer skill's guidance, and the brief wins", async () => {
  const { systemPrompt, JUDGE_CONTRACT } = await import("./judge.ts");
  const prompt = systemPrompt("## Weigh the evidence\nBe careful.");
  assert.ok(prompt.startsWith(JUDGE_CONTRACT));
  assert.match(prompt, /Where it conflicts with this brief, this brief wins/);
  assert.match(prompt, /# Your guidance \(the honed\/honer skill\)\n\n## Weigh the evidence\nBe careful\.\n$/);
});
