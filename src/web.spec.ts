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
import type { Decision, Judge } from "./judge.ts";
import { Hub } from "./hub.ts";
import { app, WRITE_HEADER } from "./web.ts";

const skillMd = `---\nname: release-notes\ndescription: Writing release notes from merged PRs.\n---\n\nGroup by user-facing change.\n`;
const WRITE = { "content-type": "application/json", [WRITE_HEADER]: "1" };

/** Takes the newest draft as it is. */
const takeDraft: Judge = {
  label: "a fake judge",
  async decide(c) {
    const d = [...c.feedback].reverse().find((f) => f.draft.length);
    return (d
      ? { reasoning: "Supported by the report.", changed: true, note: d.text, write: d.draft.map((f) => ({ ...f, executable: f.executable ?? false })), remove: [], honer_feedback: "" }
      : { reasoning: "Not yet.", changed: false, note: "", write: [], remove: [], honer_feedback: "" }) satisfies Decision;
  },
};

interface Running {
  hub: Hub;
  base: string;
  close: () => Promise<void>;
}

async function start(opts: { shared?: boolean } = {}): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), "honed-web-"));
  const hub = await Hub.open(dir, takeDraft, { starters: false });
  let server!: ServerType;
  await new Promise<void>((ready) => {
    server = serve({ fetch: app(hub, "test", opts).fetch, port: 0, hostname: "127.0.0.1" }, () => ready());
  });
  return {
    hub,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      await hub.idle();
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

  test("says how to use it, and offers four tools", async () => {
    assert.match(client.getInstructions() ?? "", /submit_feedback/);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["get_skill", "list_skills", "search_skills", "submit_feedback"]);
  });

  test("makes a skill from feedback with a draft, then lists, finds and gets it", async () => {
    const sent = await call(client, "submit_feedback", {
      name: "release-notes",
      feedback: "Every release I rewrote the notes by hand.",
      files: [{ path: "SKILL.md", content: skillMd }, { path: "scripts/prs.sh", content: "#!/bin/sh\ngh pr list --state merged\n", executable: true }],
      author: "writer",
    });
    assert.equal(sent.isError, false);
    await s.hub.idle();

    assert.deepEqual((await call(client, "list_skills")).value, [{ name: "release-notes", description: "Writing release notes from merged PRs.", version: 1 }]);
    const found = await call(client, "search_skills", { query: "grouping user" });
    assert.equal(found.value[0].name, "release-notes");
    assert.match(found.value[0].matched, /«/);
    const got = await call(client, "get_skill", { name: "release-notes" });
    assert.equal(got.value["SKILL.md"], skillMd);
    assert.deepEqual(got.value.files, [{ path: "scripts/prs.sh", executable: true }]);
    assert.match((await call(client, "get_skill", { name: "release-notes", path: "scripts/prs.sh" })).value, /gh pr list/);
    assert.equal(s.hub.store.feedback("release-notes")[0]?.author, "writer");
    assert.equal((await call(client, "submit_feedback", { name: "release-notes", quote: "Group by user-facing change.", evidence: [{ command: "gh pr list --state merged", output: "#12 Fix login" }], what_changed: "Grouped by PR instead.", feedback: "Saved me the grouping." })).isError, false);
  });

  test("answers a refusal as a tool error, in the server's words", async () => {
    const bad = await call(client, "submit_feedback", { name: "Bad Name", feedback: "t" });
    assert.equal(bad.isError, true);
    assert.match(bad.value, /lowercase letters/);
    const unquoted = await call(client, "submit_feedback", { name: "release-notes", quote: "Group by date.", evidence: [{ command: "git log", output: "a1 b2" }], what_changed: "Grouped by change." });
    assert.equal(unquoted.isError, true);
    assert.match(unquoted.value, /this text is not in release-notes as it is now \(v1\); get_skill it again and quote it exactly/);
    const bare = await call(client, "submit_feedback", { name: "release-notes", quote: "Group by user-facing change.", what_changed: "Grouped by change." });
    assert.match(bare.value, /needs evidence/);
    assert.match((await call(client, "get_skill", { name: "nope" })).value, /no skill is named nope/);
    assert.match((await call(client, "get_skill", { name: "release-notes", path: "nope.md" })).value, /has no file nope\.md/);
  });

  test("shows the skills, a search, a skill with its feedback and history, and why it changed", async () => {
    const home = await (await fetch(s.base)).text();
    assert.match(home, /<title>honed<\/title>/);
    assert.ok(home.includes(encodeURIComponent("🗡️")), "the sword is the tab's icon");
    assert.match(home, /<a class="wordmark " href="\/"/, "the wordmark heads the page, full size at home");
    assert.match(home, /agents use a skill, say how it went, and honed revises it\./);
    assert.doesNotMatch(home, /header class="top"/);
    assert.match(home, /release-notes/);
    assert.match(home, /connect Claude Code/);
    assert.match(home, /claude plugin install honed@honed --config url=http:\/\/127\.0\.0\.1:\d+</);
    assert.doesNotMatch(home, /claude mcp add/);
    assert.doesNotMatch(home, /class="bar"/, "no size bar");
    assert.match(await (await fetch(`${s.base}/?q=grouping`)).text(), /release-notes/);
    assert.match(await (await fetch(`${s.base}/?q=zebra`)).text(), /No skill mentions that/);
    const body = await (await fetch(`${s.base}/skills/release-notes`)).text();
    assert.match(body, /<p>Group by user-facing change\.<\/p>/, "SKILL.md is rendered");
    assert.doesNotMatch(body, /name: release-notes/, "its frontmatter is the header, not the body");
    assert.match(body, /<title>release-notes · honed<\/title>/);
    assert.match(body, /aria-current="page">skill</);
    assert.match(await (await fetch(`${s.base}/skills/release-notes?raw=1`)).text(), /name: release-notes/);
    const feedbackTab = await (await fetch(`${s.base}/skills/release-notes?tab=feedback`)).text();
    assert.match(feedbackTab, /Saved me the grouping\./);
    assert.match(feedbackTab, /with a draft: SKILL\.md, scripts\/prs\.sh/);
    const history = await (await fetch(`${s.base}/skills/release-notes?tab=history`)).text();
    assert.match(history, /created SKILL\.md/);
    assert.doesNotMatch(history, /diff --git|index [0-9a-f]+\.\./, "none of git's bookkeeping");
    const [v] = s.hub.store.versions("release-notes");
    const why = await (await fetch(`${s.base}/judgments/${v!.judgment}`)).text();
    assert.match(why, /Supported by the report\./);
    assert.match(why, /Every release I rewrote the notes by hand\./);
  });

  test("escapes what agents wrote, and highlights a search match without trusting it", async () => {
    await s.hub.submitFeedback({
      skill: "release-notes",
      quote: "Group by user-facing change.",
      evidence: [{ path: "<script>a.ts</script>", content: "<script>alert(2)</script>" }],
      whatChanged: "<script>alert(3)</script>",
      text: "<script>alert(1)</script>",
    });
    const body = await (await fetch(`${s.base}/skills/release-notes?tab=feedback`)).text();
    assert.doesNotMatch(body, /<script>alert/);
    assert.match(body, /&lt;script&gt;alert/);
    const found = await (await fetch(`${s.base}/?q=grouping`)).text();
    assert.match(found, /<mark>[^<]*<\/mark>/);
  });

  test("a write without the write header is refused, and with it a refusal comes back in the server's words", async () => {
    const bare = await fetch(`${s.base}/api/skills/release-notes/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bare.status, 403);
    const refused = await fetch(`${s.base}/api/skills/release-notes/revert`, { method: "POST", headers: WRITE, body: JSON.stringify({ version: "1" }) });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /from 1 to 0/);
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

  test("attributes feedback to its token, with the role the agent gave", async () => {
    const client = await connect(s.base, agent);
    await call(client, "submit_feedback", { name: "x", feedback: "make it", files: [{ path: "SKILL.md", content: "---\nname: x\ndescription: d\n---\n" }], author: "reviewer on PR 3" });
    await s.hub.idle();
    await call(client, "submit_feedback", { name: "x", quote: "description: d", evidence: [{ command: "gh pr list --state merged", output: "#12 Fix login" }], what_changed: "Grouped by PR instead." });
    await s.hub.idle();
    assert.deepEqual(s.hub.store.feedback("x").map((f) => f.author).sort(), ["ci-agent", "ci-agent (reviewer on PR 3)"]);
    await client.close();
  });

  test("lets only an admin revert, and records who did", async () => {
    const client = await connect(s.base, agent);
    await call(client, "submit_feedback", { name: "x", quote: "description: d", evidence: [{ command: "gh pr list --state merged", output: "#12 Fix login" }], what_changed: "Grouped by PR instead.", feedback: "v2", files: [{ path: "SKILL.md", content: "---\nname: x\ndescription: d2\n---\n" }] });
    await client.close();
    await s.hub.idle();
    const asAgent = await fetch(`${s.base}/api/skills/x/revert`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${agent}` }, body: JSON.stringify({ version: 1 }) });
    assert.equal(asAgent.status, 403);
    assert.match(((await asAgent.json()) as { error: string }).error, /admin token/);
    const asAdmin = await fetch(`${s.base}/api/skills/x/revert`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${admin}` }, body: JSON.stringify({ version: 1 }) });
    assert.equal(asAdmin.status, 200);
    assert.equal(((await asAdmin.json()) as { actor: string }).actor, "dakota");
  });

  test("serves prefixed skills at their own paths, for agents and on the page", async () => {
    const client = await connect(s.base, agent);
    await call(client, "submit_feedback", { name: "team/deploys", feedback: "make it", files: [{ path: "SKILL.md", content: "---\nname: deploys\ndescription: Deploying.\n---\n" }] });
    await s.hub.idle();
    assert.equal((await call(client, "get_skill", { name: "team/deploys" })).value.name, "team/deploys");
    await client.close();
    const auth = { authorization: `Bearer ${admin}` };
    assert.equal((await fetch(`${s.base}/api/skills/team/deploys`, { headers: auth })).status, 200);
    const page = await (await fetch(`${s.base}/skills/team/deploys`, { headers: auth })).text();
    assert.match(page, /<title>team\/deploys · honed<\/title>/);
    const home = await (await fetch(s.base, { headers: auth })).text();
    assert.match(home, /href="\/\?group=team"/);
    assert.match(home, /<div class="tag">team\/<\/div>\s*<div class="name">deploys<\/div>/);
    const filtered = await (await fetch(`${s.base}/?group=team`, { headers: auth })).text();
    assert.match(filtered, /aria-current="true">team\//);
    assert.doesNotMatch(filtered, /<div class="name">x<\/div>/);
    const edited = await fetch(`${s.base}/api/skills/team/deploys/edit`, { method: "POST", headers: { ...WRITE, ...auth }, body: JSON.stringify({ path: "SKILL.md", content: "---\nname: deploys\ndescription: Deploying, edited.\n---\n" }) });
    assert.equal(edited.status, 200);
  });

  test("previews an edit as a diff, refused as the edit would be, without changing anything", async () => {
    const auth = { authorization: `Bearer ${admin}` };
    const before = s.hub.skill("team/deploys").version;
    const ok = await fetch(`${s.base}/api/skills/team/deploys/preview`, { method: "POST", headers: { ...WRITE, ...auth }, body: JSON.stringify({ path: "notes.md", content: "Roll back first." }) });
    assert.equal(ok.status, 200);
    assert.match(((await ok.json()) as { html: string }).html, /created notes\.md[\s\S]*Roll back first\./);
    const bad = await fetch(`${s.base}/api/skills/team/deploys/preview`, { method: "POST", headers: { ...WRITE, ...auth }, body: JSON.stringify({ path: "SKILL.md", content: "no frontmatter" }) });
    assert.equal(bad.status, 400);
    assert.equal(s.hub.skill("team/deploys").version, before);
    const editing = await (await fetch(`${s.base}/skills/team/deploys?edit=SKILL.md`, { headers: auth })).text();
    assert.match(editing, /data-preview="\/api\/skills\/team\/deploys\/preview"/);
    assert.match(editing, /<button type="submit" class="primary" hidden>/, "save waits for a preview");
  });

  test("lets only an admin edit or delete a skill, and tells an agent what happens to its feedback", async () => {
    const asAgent = await fetch(`${s.base}/api/skills/x/edit`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${agent}` }, body: JSON.stringify({ path: "SKILL.md", content: "---\nname: x\ndescription: e\n---\n" }) });
    assert.equal(asAgent.status, 403);
    const edited = await fetch(`${s.base}/api/skills/x/edit`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${admin}` }, body: JSON.stringify({ path: "SKILL.md", content: "---\nname: x\ndescription: edited\n---\n", reason: "typo" }) });
    assert.equal(edited.status, 200);
    assert.equal(s.hub.list().find((k) => k.name === "x")?.description, "edited");
    const client = await connect(s.base, agent);
    assert.match((await call(client, "submit_feedback", { name: "x", quote: "description: edited", evidence: [{ command: "gh pr list --state merged", output: "#12 Fix login" }], what_changed: "Grouped by PR instead." })).value, /revised once 2 more pieces of feedback arrive/);
    await client.close();
    const deleted = await fetch(`${s.base}/api/skills/x/delete`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${admin}` }, body: JSON.stringify({ reason: "done" }) });
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(`${s.base}/api/skills/x`, { headers: { authorization: `Bearer ${admin}` } })).status, 404);
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
});

test("a shared server refuses everyone until it has a token", async () => {
  const s = await start({ shared: true });
  try {
    assert.equal((await fetch(`${s.base}/api/skills`)).status, 401);
  } finally {
    await s.close();
  }
});
