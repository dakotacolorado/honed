import { serve, type ServerType } from "@hono/node-server";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Hub } from "./hub.ts";
import { app } from "./web.ts";

const hook = (name: string) => fileURLToPath(new URL(`../plugin/hooks/${name}`, import.meta.url));
const run = (name: string, input: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [hook(name)], { input, encoding: "utf8", env: { ...process.env, ...env } });

const use = (tool: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: tool, input }] } });

describe("the Stop hook", () => {
  let dir: string;
  before(async () => (dir = await mkdtemp(join(tmpdir(), "honed-hook-"))));
  after(async () => rm(dir, { recursive: true, force: true }));

  const stop = async (lines: string[], extra: Record<string, unknown> = {}) => {
    const path = join(dir, `${Math.random()}.jsonl`);
    await writeFile(path, lines.join("\n") + "\n{not json\n");
    const out = run("stop.mjs", JSON.stringify({ transcript_path: path, stop_hook_active: false, ...extra }));
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim() ? JSON.parse(out.stdout) : null;
  };

  test("asks for feedback on each skill read and not rated, by the plugin's tool names", async () => {
    const out = await stop([
      use("mcp__plugin_honed_honed__get_skill", { name: "git-commits" }),
      use("mcp__plugin_honed_honed__get_skill", { name: "blog-writing" }),
      use("mcp__plugin_honed_honed__get_skill", { name: "git-commits" }),
      use("mcp__plugin_honed_honed__submit_feedback", { name: "git-commits", feedback: "It helped." }),
      use("Read", { name: "blog-writing" }),
    ]);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /the honed skill blog-writing this session/);
    assert.doesNotMatch(out.reason, /git-commits/);
  });

  test("also knows the tools of a server added by hand", async () => {
    const out = await stop([use("mcp__honed__get_skill", { name: "a" }), use("mcp__honed__get_skill", { name: "b" })]);
    assert.match(out.reason, /skills a, b this session/);
  });

  test("lets the session stop when every skill read was rated, none was read, or it already asked", async () => {
    assert.equal(await stop([use("mcp__honed__get_skill", { name: "a" }), use("mcp__honed__submit_feedback", { name: "a" })]), null);
    assert.equal(await stop([use("mcp__honed__list_skills", {})]), null);
    assert.equal(await stop([use("mcp__honed__get_skill", { name: "a" })], { stop_hook_active: true }), null);
    assert.equal(run("stop.mjs", JSON.stringify({ transcript_path: join(dir, "missing.jsonl") })).stdout, "");
  });
});

describe("the SessionStart hook", () => {
  let hub: Hub;
  let server: ServerType;
  let url: string;
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "honed-start-"));
    hub = await Hub.open(dir, null, { starters: false });
    hub.close();
    hub = await Hub.open(dir, { label: "a fake judge", decide: async (c) => ({ reasoning: "r", changed: true, note: "n", edits: [], write: c.feedback[0]!.draft.map((f) => ({ ...f, executable: false })), remove: [], revert_to: 0, honer_feedback: "" }) }, { starters: false });
    await hub.submitFeedback({ skill: "git-commits", text: "t", files: [{ path: "SKILL.md", content: "---\nname: git-commits\ndescription: Commit messages.\n---\n" }] });
    await hub.idle();
    await new Promise<void>((ready) => {
      server = serve({ fetch: app(hub, "test").fetch, port: 0, hostname: "127.0.0.1" }, () => ready());
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("lists the library's skills for the session", async () => {
    // Not spawnSync: the server answering it runs in this process.
    const { stdout: out } = await promisify(execFile)(process.execPath, [hook("session-start.mjs")], { env: { ...process.env, CLAUDE_PLUGIN_OPTION_URL: `${url}/` } });
    assert.match(out, /search_skills/);
    assert.match(out, /- git-commits: Commit messages\./);
  });

  test("says so when the server cannot be reached, and still exits cleanly", () => {
    const out = run("session-start.mjs", "", { CLAUDE_PLUGIN_OPTION_URL: "http://127.0.0.1:1" });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /honed is not reachable at http:\/\/127\.0\.0\.1:1/);
  });
});
