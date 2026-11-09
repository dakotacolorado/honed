import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Hub } from "./hub.ts";
import { app, WRITE_HEADER } from "./web.ts";

const skillMd = `---\nname: release-notes\ndescription: Writing release notes from merged PRs.\n---\n\nGroup by user-facing change.\n`;

let dir: string;
let hub: Hub;
let server: ServerType;
let base: string;
let client: Client;

const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = result.content[0]!.text;
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {}
  return { value: value as any, isError: result.isError ?? false };
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "honed-web-"));
  hub = await Hub.open(dir, null);
  await new Promise<void>((ready) => {
    server = serve({ fetch: app(hub, "test").fetch, port: 0, hostname: "127.0.0.1" }, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new Client({ name: "spec", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});

after(async () => {
  await client.close();
  server.close();
  hub.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the MCP server", () => {
  test("says how to use it, and offers its tools", async () => {
    assert.match(client.getInstructions() ?? "", /give_feedback/);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["comment", "get_proposal", "give_feedback", "list_skills", "read_file", "read_skill", "vote", "write_skill"]);
  });

  test("takes a proposal, votes, comments and feedback, and serves the skill once merged", async () => {
    const proposed = await call("write_skill", {
      name: "release-notes",
      title: "Add release notes",
      why: "Every release I rewrote the notes by hand.",
      write: [{ path: "SKILL.md", content: skillMd }, { path: "scripts/prs.sh", content: "#!/bin/sh\ngh pr list --state merged\n", executable: true }],
      author: "writer",
    });
    assert.equal(proposed.isError, false);
    const id = proposed.value.proposal as string;

    assert.equal((await call("vote", { proposal: id, vote: "up", reason: "Same here.", author: "a" })).isError, false);
    assert.equal((await call("comment", { proposal: id, body: "Mention breaking changes first?" })).isError, false);
    const pending = await call("get_proposal", { id });
    assert.equal(pending.value.state, "open");
    assert.match(pending.value.diff, /\+Group by user-facing change\./);
    assert.equal(pending.value.votes[0].author, "a");

    assert.equal((await call("list_skills", {})).value.length, 0);
    await hub.merge(id, "Yes.");

    const listed = await call("list_skills", { query: "release" });
    assert.deepEqual(listed.value, [{ name: "release-notes", description: "Writing release notes from merged PRs.", version: 1, openProposals: 0 }]);
    const read = await call("read_skill", { name: "release-notes" });
    assert.equal(read.value["SKILL.md"], skillMd);
    assert.deepEqual(read.value.files, [{ path: "scripts/prs.sh", executable: true, bytes: 36 }]);
    assert.equal(read.value.folder, hub.library.path("release-notes"));
    assert.match((await call("read_file", { name: "release-notes", path: "scripts/prs.sh" })).value, /gh pr list/);

    assert.equal((await call("give_feedback", { name: "release-notes", verdict: "helped", reason: "Saved the grouping." })).isError, false);
    assert.equal(hub.store.feedback("release-notes")[0]?.reason, "Saved the grouping.");
  });

  test("answers a refusal as a tool error, in the hub's words", async () => {
    const bad = await call("write_skill", { name: "Bad Name", title: "t", why: "w", write: [{ path: "SKILL.md", content: "" }] });
    assert.equal(bad.isError, true);
    assert.match(bad.value, /lowercase letters/);
    const missing = await call("read_skill", { name: "nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.value, /no skill is named nope/);
  });
});

describe("the page", () => {
  test("shows the skills, a skill, a proposal and a judgment", async () => {
    const home = await (await fetch(base)).text();
    assert.match(home, /release-notes/);
    assert.match(home, /claude mcp add --transport http honed http:\/\/127\.0\.0\.1:\d+\/mcp/);
    const skill = await fetch(`${base}/skills/release-notes`);
    assert.equal(skill.status, 200);
    const body = await skill.text();
    assert.match(body, /Group by user-facing change\./);
    assert.match(body, /Saved the grouping\./);
    const [proposal] = hub.store.proposals("release-notes");
    assert.match(await (await fetch(`${base}/proposals/${proposal!.id}`)).text(), /Same here\./);
    assert.match(await (await fetch(`${base}/judgments/${proposal!.judgment}`)).text(), /Yes\./);
  });

  test("escapes what agents wrote", async () => {
    const p = await hub.propose({ skill: "release-notes", title: "<script>alert(1)</script>", why: "w", change: { write: [{ path: "SKILL.md", content: skillMd + "more\n" }], remove: [] } });
    const body = await (await fetch(`${base}/proposals/${p.id}`)).text();
    assert.doesNotMatch(body, /<script>alert/);
    assert.match(body, /&lt;script&gt;alert/);
  });

  test("a write without the write header is refused, and with it a refusal comes back in the hub's words", async () => {
    const [open] = hub.store.proposals("release-notes", "open");
    const bare = await fetch(`${base}/api/proposals/${open!.id}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bare.status, 403);
    assert.equal(hub.proposal(open!.id).state, "open");
    const headers = { "content-type": "application/json", [WRITE_HEADER]: "1" };
    const rejected = await fetch(`${base}/api/proposals/${open!.id}/reject`, { method: "POST", headers, body: JSON.stringify({ reason: "No." }) });
    assert.equal(rejected.status, 200);
    const again = await fetch(`${base}/api/proposals/${open!.id}/reject`, { method: "POST", headers, body: "{}" });
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: string }).error, /is rejected/);
  });

  test("answers only to a local hostname", async () => {
    // fetch will not send a Host of its own, so ask as a rebound hostname would.
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const { port } = new URL(base);
        request({ host: "127.0.0.1", port, path: "/api/skills", headers: { host } }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject).end();
      });
    assert.equal(await status("evil.example"), 403);
    assert.equal(await status("evil.example:4321"), 403);
    assert.equal(await status("localhost:4321"), 200);
  });
});
