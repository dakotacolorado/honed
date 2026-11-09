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
import { createToken } from "./auth.ts";
import { Hub } from "./hub.ts";
import { app, WRITE_HEADER } from "./web.ts";

const skillMd = `---\nname: release-notes\ndescription: Writing release notes from merged PRs.\n---\n\nGroup by user-facing change.\n`;
const WRITE = { "content-type": "application/json", [WRITE_HEADER]: "1" };

interface Running {
  hub: Hub;
  base: string;
  close: () => Promise<void>;
}

async function start(opts: { shared?: boolean } = {}): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), "honed-web-"));
  const hub = await Hub.open(dir, null);
  let server!: ServerType;
  await new Promise<void>((ready) => {
    server = serve({ fetch: app(hub, "test", opts).fetch, port: 0, hostname: "127.0.0.1" }, () => ready());
  });
  return {
    hub,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.close();
      hub.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function connect(base: string, token?: string): Promise<Client> {
  const client = new Client({ name: "spec", version: "0" });
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = result.content[0]!.text;
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {}
  return { value: value as any, isError: result.isError ?? false };
}

/** Asks with a Host of our choosing, which fetch will not send. */
function statusWithHost(base: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    request({ host: "127.0.0.1", port, path: "/api/skills", headers: { host } }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject).end();
  });
}

describe("a local server, with no tokens", () => {
  let s: Running;
  let client: Client;
  before(async () => {
    s = await start();
    client = await connect(s.base);
  });
  after(async () => {
    await client.close();
    await s.close();
  });

  test("says how to use it, and offers its tools", async () => {
    assert.match(client.getInstructions() ?? "", /give_feedback/);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["comment", "get_proposal", "give_feedback", "list_skills", "read_file", "read_skill", "search_skills", "vote", "write_skill"]);
  });

  test("takes a proposal, votes, comments and feedback, and serves and finds the skill once merged", async () => {
    const proposed = await call(client, "write_skill", {
      name: "release-notes",
      title: "Add release notes",
      why: "Every release I rewrote the notes by hand.",
      write: [{ path: "SKILL.md", content: skillMd }, { path: "scripts/prs.sh", content: "#!/bin/sh\ngh pr list --state merged\n", executable: true }],
      author: "writer",
    });
    assert.equal(proposed.isError, false);
    const id = proposed.value.proposal as string;
    assert.equal(s.hub.proposal(id).author, "writer");

    assert.equal((await call(client, "vote", { proposal: id, vote: "up", reason: "Same here.", author: "a" })).isError, false);
    assert.equal((await call(client, "comment", { proposal: id, body: "Mention breaking changes first?" })).isError, false);
    const pending = await call(client, "get_proposal", { id });
    assert.equal(pending.value.state, "open");
    assert.match(pending.value.diff, /\+Group by user-facing change\./);

    await s.hub.merge(id, "Yes.");

    assert.deepEqual((await call(client, "list_skills")).value, [
      { name: "release-notes", description: "Writing release notes from merged PRs.", version: 1, stage: "young", openProposals: 0 },
    ]);
    const found = await call(client, "search_skills", { query: "grouping user" });
    assert.equal(found.value[0].name, "release-notes");
    assert.match(found.value[0].matched, /«/);
    const read = await call(client, "read_skill", { name: "release-notes" });
    assert.equal(read.value["SKILL.md"], skillMd);
    assert.deepEqual(read.value.files, [{ path: "scripts/prs.sh", executable: true, bytes: 36 }]);
    assert.equal(read.value.folder, s.hub.library.path("release-notes"));
    assert.equal(read.value.stage, "young");
    assert.match((await call(client, "read_file", { name: "release-notes", path: "scripts/prs.sh" })).value, /gh pr list/);
    assert.equal((await call(client, "give_feedback", { name: "release-notes", verdict: "helped", reason: "Saved the grouping." })).isError, false);
  });

  test("answers a refusal as a tool error, in the hub's words", async () => {
    const bad = await call(client, "write_skill", { name: "Bad Name", title: "t", why: "w", write: [{ path: "SKILL.md", content: "" }] });
    assert.equal(bad.isError, true);
    assert.match(bad.value, /lowercase letters/);
    assert.match((await call(client, "read_skill", { name: "nope" })).value, /no skill is named nope/);
  });

  test("shows the skills, a search, a skill, a proposal and a judgment", async () => {
    const home = await (await fetch(s.base)).text();
    assert.match(home, /release-notes/);
    assert.match(home, /claude plugin install honed@honed --config url=http:\/\/127\.0\.0\.1:\d+/);
    assert.match(home, /claude mcp add --transport http --scope user honed http:\/\/127\.0\.0\.1:\d+\/mcp</);
    assert.match(await (await fetch(`${s.base}/?q=grouping`)).text(), /release-notes/);
    assert.match(await (await fetch(`${s.base}/?q=zebra`)).text(), /No skill mentions that/);
    const body = await (await fetch(`${s.base}/skills/release-notes`)).text();
    assert.match(body, /Group by user-facing change\./);
    assert.match(body, /Saved the grouping\./);
    assert.match(body, /<b>young<\/b>/);
    const [proposal] = s.hub.store.proposals("release-notes");
    assert.match(await (await fetch(`${s.base}/proposals/${proposal!.id}`)).text(), /Same here\./);
    assert.match(await (await fetch(`${s.base}/judgments/${proposal!.judgment}`)).text(), /Yes\./);
  });

  test("escapes what agents wrote", async () => {
    const p = await s.hub.propose({ skill: "release-notes", title: "<script>alert(1)</script>", why: "w", change: { write: [{ path: "SKILL.md", content: skillMd + "more\n" }], remove: [] } });
    const body = await (await fetch(`${s.base}/proposals/${p.id}`)).text();
    assert.doesNotMatch(body, /<script>alert/);
    assert.match(body, /&lt;script&gt;alert/);
  });

  test("a write without the write header is refused, and with it a refusal comes back in the hub's words", async () => {
    const [open] = s.hub.store.proposals("release-notes", "open");
    const bare = await fetch(`${s.base}/api/proposals/${open!.id}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bare.status, 403);
    assert.equal(s.hub.proposal(open!.id).state, "open");
    assert.equal((await fetch(`${s.base}/api/proposals/${open!.id}/reject`, { method: "POST", headers: WRITE, body: JSON.stringify({ reason: "No." }) })).status, 200);
    const again = await fetch(`${s.base}/api/proposals/${open!.id}/reject`, { method: "POST", headers: WRITE, body: "{}" });
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: string }).error, /is rejected/);
  });

  test("answers only to a local hostname", async () => {
    assert.equal(await statusWithHost(s.base, "evil.example"), 403);
    assert.equal(await statusWithHost(s.base, "evil.example:4321"), 403);
    assert.equal(await statusWithHost(s.base, "localhost:4321"), 200);
  });
});

describe("a server with tokens", () => {
  let s: Running;
  let admin: string;
  let agent: string;
  before(async () => {
    s = await start();
    admin = createToken(s.hub.store, "dakota", true);
    agent = createToken(s.hub.store, "ci-agent", false);
  });
  after(async () => s.close());

  test("refuses a request without a token, or with one it did not issue, and sends a person to sign in", async () => {
    assert.equal((await fetch(`${s.base}/api/skills`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/skills`, { headers: { authorization: "Bearer honed_nope" } })).status, 401);
    assert.equal((await fetch(`${s.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    const page = await fetch(s.base, { redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/login");
  });

  test("answers any hostname once it has tokens, since every request must carry one", async () => {
    assert.equal(await statusWithHost(s.base, "honed.example.com"), 401);
  });

  test("attributes what an agent writes to its token, with the role it gave", async () => {
    const client = await connect(s.base, agent);
    const p = await call(client, "write_skill", { name: "x", title: "t", why: "w", write: [{ path: "SKILL.md", content: "---\nname: x\ndescription: d\n---\n" }], author: "reviewer on PR 3" });
    assert.equal(s.hub.proposal(p.value.proposal).author, "ci-agent (reviewer on PR 3)");
    const q = await call(client, "write_skill", { name: "y", title: "t", why: "w", write: [{ path: "SKILL.md", content: "---\nname: y\ndescription: d\n---\n" }] });
    assert.equal(s.hub.proposal(q.value.proposal).author, "ci-agent");
    await client.close();
  });

  test("lets only an admin override the judge, and records who did", async () => {
    const [open] = s.hub.store.openProposals();
    const asAgent = await fetch(`${s.base}/api/proposals/${open!.id}/merge`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${agent}` }, body: "{}" });
    assert.equal(asAgent.status, 403);
    assert.match(((await asAgent.json()) as { error: string }).error, /admin token/);
    const asAdmin = await fetch(`${s.base}/api/proposals/${open!.id}/merge`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${admin}` }, body: "{}" });
    assert.equal(asAdmin.status, 200);
    assert.equal(((await asAdmin.json()) as { actor: string }).actor, "dakota");
  });

  test("signs a person in with a token, into a cookie the page then uses", async () => {
    const bad = await fetch(`${s.base}/login`, { method: "POST", body: new URLSearchParams({ token: "honed_nope" }), redirect: "manual" });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${s.base}/login`, { method: "POST", body: new URLSearchParams({ token: admin }), redirect: "manual" });
    assert.equal(ok.status, 302);
    const cookie = ok.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const home = await (await fetch(s.base, { headers: { cookie: cookie.split(";")[0]! } })).text();
    assert.match(home, /dakota \(admin\)/);
    assert.match(home, /\/plugin configure honed@honed/);
  });

  test("does not tell a remote agent where the server keeps its files", async () => {
    const client = await connect(s.base, agent);
    const read = await call(client, "read_skill", { name: s.hub.list()[0]!.name });
    assert.equal(read.isError, false);
    assert.equal(read.value.folder, undefined);
    await client.close();
  });
});

test("a shared server refuses everyone until it has a token", async () => {
  const s = await start({ shared: true });
  try {
    assert.equal((await fetch(`${s.base}/api/skills`)).status, 401);
  } finally {
    await s.close();
  }
});
