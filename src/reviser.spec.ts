import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ApiJudge, API_MODEL, ClaudeJudge, type Case } from "./judge.ts";
import { chooseReviser } from "./reviser.ts";

describe("choosing who revises", () => {
  let bin: string;
  before(async () => {
    bin = await mkdtemp(join(tmpdir(), "honed-bin-"));
    await writeFile(join(bin, "claude"), "#!/bin/sh\n");
    await chmod(join(bin, "claude"), 0o755);
  });
  after(async () => rm(bin, { recursive: true, force: true }));
  const empty = "/nonexistent";

  test("auto takes Claude Code on a dev host, the API with a key on a server without it, else nothing", () => {
    assert.ok(chooseReviser({ mode: "auto", path: bin, apiKey: "k" }).judge instanceof ClaudeJudge);
    const hosted = chooseReviser({ mode: "auto", path: empty, apiKey: "k" });
    assert.ok(hosted.judge instanceof ApiJudge);
    assert.match(hosted.why, /the Claude API \(claude-opus-5-5\), billed to ANTHROPIC_API_KEY/);
    const none = chooseReviser({ mode: "auto", path: empty });
    assert.equal(none.judge, null);
    assert.match(none.why, /Claude Code is not installed and ANTHROPIC_API_KEY is not set/);
  });

  test("an explicit mode is kept to, and says what it is missing", () => {
    assert.ok(chooseReviser({ mode: "api", path: bin, apiKey: "k" }).judge instanceof ApiJudge);
    assert.throws(() => chooseReviser({ mode: "api", path: bin }), /needs ANTHROPIC_API_KEY/);
    assert.throws(() => chooseReviser({ mode: "claude-code", path: empty, apiKey: "k" }), /needs Claude Code/);
    assert.equal(chooseReviser({ mode: "off", path: bin, apiKey: "k" }).judge, null);
    assert.throws(() => chooseReviser({ mode: "cloud", path: bin }), /must be one of auto, claude-code, api, off/);
  });
});

describe("the API judge", () => {
  const c: Case = { skill: "x", version: 1, maxChars: 20_000, files: [], others: [], feedback: [], precedent: [], failure: null, guidance: "## Weigh the evidence" };
  const decision = { reasoning: "r", changed: false, note: "", write: [], remove: [] };

  /** A client that answers every request with `reply` (or throws it), and keeps what it was sent. */
  function stub(reply: unknown) {
    const sent: any[] = [];
    const client = {
      beta: {
        messages: {
          stream(params: unknown) {
            sent.push(params);
            return { finalMessage: async () => (reply instanceof Error ? Promise.reject(reply) : reply) };
          },
        },
      },
    } as unknown as Anthropic;
    return { client, sent };
  }
  const message = (text: string, stop_reason = "end_turn") => ({ stop_reason, stop_details: null, content: [{ type: "text", text }] });

  test("asks for the decision as structured output, with the fixed brief and the honed/judge guidance, and a fallback on refusal", async () => {
    const { client, sent } = stub(message(JSON.stringify(decision)));
    assert.deepEqual(await new ApiJudge({ client }).decide(c), decision);
    const p = sent[0];
    assert.equal(p.model, API_MODEL);
    assert.equal(p.output_config.format.type, "json_schema");
    assert.equal(p.output_config.format.schema.additionalProperties, false);
    assert.equal(p.fallbacks, "default");
    assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
    assert.match(p.system, /this brief wins[\s\S]*## Weigh the evidence/);
    assert.match(p.messages[0].content, /<skill name="x" version="1"/);
  });

  test("fails a judgment, in words, on a refusal, a cut-off answer, bad JSON or a refused key", async () => {
    await assert.rejects(new ApiJudge({ client: stub({ ...message(""), stop_reason: "refusal", stop_details: { category: "cyber" } }).client }).decide(c), /declined to decide \(cyber\)/);
    await assert.rejects(new ApiJudge({ client: stub(message("{", "max_tokens")).client }).decide(c), /ran past the token limit/);
    await assert.rejects(new ApiJudge({ client: stub(message('{"changed": "yes"}')).client }).decide(c), /no valid decision/);
    const refused = Object.create(Anthropic.AuthenticationError.prototype) as Error;
    await assert.rejects(new ApiJudge({ client: stub(refused).client }).decide(c), /refused the API key: check ANTHROPIC_API_KEY/);
  });
});
