import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createToken } from "./auth.ts";
import type { Decision, Judge } from "./judge.ts";
import { Hub } from "./hub.ts";
import { mcpJson } from "./mcp.ts";
import { app, WRITE_HEADER } from "./web.ts";

const skillMd = `---\nname: release-notes\ndescription: Writing release notes from merged PRs.\n---\n\nGroup by user-facing change.\n`;
const WRITE = { "content-type": "application/json", [WRITE_HEADER]: "1" };

/** Takes the newest draft as it is. */
const takeDraft: Judge = {
  label: "a fake judge",
  async decide(c) {
    const d = [...c.feedback].reverse().find((f) => f.draft.length);
    return (d
      ? { reasoning: "Supported by the report.", changed: true, note: d.text, edits: [], write: d.draft.map((f) => ({ ...f, executable: f.executable ?? false })), remove: [], revert_to: 0, honer_feedback: "" }
      : { reasoning: "Not yet.", changed: false, note: "", edits: [], write: [], remove: [], revert_to: 0, honer_feedback: "" }) satisfies Decision;
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

async function connect(base: string, token?: string, namespaces: string | null = "docs, team"): Promise<Client> {
  const client = new Client({ name: "spec", version: "0" });
  const headers: Record<string, string> = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(namespaces === null ? {} : { "x-honed-namespaces": namespaces }) };
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
    const feedbackTool = (await client.listTools()).tools.find((t) => t.name === "submit_feedback")!;
    for (const text of [client.getInstructions() ?? "", feedbackTool.description ?? "", JSON.stringify(feedbackTool.inputSchema)]) {
      assert.ok(text.includes("If you edited something a skill mentions, or a skill gave you wrong information, report it before you finish, quoting the skill's text and showing the evidence.") || text.startsWith("{"), text);
      assert.doesNotMatch(text, /fell short|falls? short|report any issues|any issues/i);
    }
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["get_skill", "list_skills", "search_skills", "submit_feedback"]);
  });

  test("makes a skill from feedback with a draft, then lists, finds and gets it", async () => {
    const sent = await call(client, "submit_feedback", {
      name: "docs/release-notes",
      feedback: "Every release I rewrote the notes by hand.",
      files: [{ path: "SKILL.md", content: skillMd }, { path: "scripts/prs.sh", content: "#!/bin/sh\ngh pr list --state merged\n", executable: true }],
      author: "writer",
    });
    assert.equal(sent.isError, false);
    await s.hub.idle();

    assert.deepEqual((await call(client, "list_skills")).value, [{ name: "docs/release-notes", description: "Writing release notes from merged PRs.", version: 1 }]);
    const found = await call(client, "search_skills", { query: "grouping user" });
    assert.equal(found.value[0].name, "docs/release-notes");
    assert.match(found.value[0].matched, /«/);
    const got = await call(client, "get_skill", { name: "docs/release-notes" });
    assert.equal(got.value["SKILL.md"], skillMd);
    assert.deepEqual(got.value.files, [{ path: "scripts/prs.sh", executable: true }]);
    assert.match((await call(client, "get_skill", { name: "docs/release-notes", path: "scripts/prs.sh" })).value, /gh pr list/);
    assert.equal(s.hub.store.feedback("docs/release-notes")[0]?.author, "writer");
    assert.equal((await call(client, "submit_feedback", { name: "docs/release-notes", quote: "Group by user-facing change.", evidence: [{ command: "gh pr list --state merged", output: "#12 Fix login" }], what_changed: "Grouped by PR instead.", feedback: "Saved me the grouping." })).isError, false);
  });

  test("answers a refusal as a tool error, in the server's words", async () => {
    const bad = await call(client, "submit_feedback", { name: "Bad Name", feedback: "t" });
    assert.equal(bad.isError, true);
    assert.match(bad.value, /lowercase letters/);
    const unquoted = await call(client, "submit_feedback", { name: "docs/release-notes", quote: "Group by date.", evidence: [{ command: "git log", output: "a1 b2" }], what_changed: "Grouped by change." });
    assert.equal(unquoted.isError, true);
    assert.match(unquoted.value, /this text is not in docs\/release-notes as it is now \(v1\); get_skill it again and quote it exactly/);
    const bare = await call(client, "submit_feedback", { name: "docs/release-notes", quote: "Group by user-facing change.", what_changed: "Grouped by change." });
    assert.match(bare.value, /needs evidence/);
    assert.match((await call(client, "get_skill", { name: "nope" })).value, /no skill is named nope/);
    assert.match((await call(client, "get_skill", { name: "docs/release-notes", path: "nope.md" })).value, /has no file nope\.md/);
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
    assert.match(home, /Commit this <code>\.mcp\.json<\/code> at a repo's root/);
    assert.match(home, /&quot;url&quot;: &quot;http:\/\/127\.0\.0\.1:\d+\/mcp&quot;/);
    assert.match(home, /&quot;X-Honed-Namespaces&quot;: &quot;your-project, shared&quot;/);
    assert.doesNotMatch(home, /plugin/);
    assert.doesNotMatch(home, /claude mcp add/);
    assert.doesNotMatch(home, /class="bar"/, "no size bar");
    assert.match(await (await fetch(`${s.base}/?q=grouping`)).text(), /release-notes/);
    assert.match(await (await fetch(`${s.base}/?q=zebra`)).text(), /No skill mentions that/);
    const body = await (await fetch(`${s.base}/skills/docs/release-notes`)).text();
    assert.match(body, /<p>Group by user-facing change\.<\/p>/, "SKILL.md is rendered");
    assert.doesNotMatch(body, /name: release-notes/, "its frontmatter is the header, not the body");
    assert.match(body, /<title>docs\/release-notes · honed<\/title>/);
    assert.match(body, /aria-current="page">skill</);
    assert.match(await (await fetch(`${s.base}/skills/docs/release-notes?raw=1`)).text(), /name: release-notes/);
    const feedbackTab = await (await fetch(`${s.base}/skills/docs/release-notes?tab=feedback`)).text();
    assert.match(feedbackTab, /Saved me the grouping\./);
    assert.match(feedbackTab, /with a draft: SKILL\.md, scripts\/prs\.sh/);
    const history = await (await fetch(`${s.base}/skills/docs/release-notes?tab=history`)).text();
    assert.match(history, /created SKILL\.md/);
    assert.doesNotMatch(history, /diff --git|index [0-9a-f]+\.\./, "none of git's bookkeeping");
    const [v] = s.hub.store.versions("docs/release-notes");
    const why = await (await fetch(`${s.base}/judgments/${v!.judgment}`)).text();
    assert.match(why, /Supported by the report\./);
    assert.match(why, /Every release I rewrote the notes by hand\./);
  });

  test("escapes what agents wrote, and highlights a search match without trusting it", async () => {
    await s.hub.submitFeedback({
      skill: "docs/release-notes",
      quote: "Group by user-facing change.",
      evidence: [{ path: "<script>a.ts</script>", content: "<script>alert(2)</script>" }],
      whatChanged: "<script>alert(3)</script>",
      text: "<script>alert(1)</script>",
    });
    const body = await (await fetch(`${s.base}/skills/docs/release-notes?tab=feedback`)).text();
    assert.doesNotMatch(body, /<script>alert/);
    assert.match(body, /&lt;script&gt;alert/);
    const found = await (await fetch(`${s.base}/?q=grouping`)).text();
    assert.match(found, /<mark>[^<]*<\/mark>/);
  });

  test("a write without the write header is refused, and with it a refusal comes back in the server's words", async () => {
    const bare = await fetch(`${s.base}/api/skills/docs/release-notes/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bare.status, 403);
    const refused = await fetch(`${s.base}/api/skills/docs/release-notes/revert`, { method: "POST", headers: WRITE, body: JSON.stringify({ version: "1" }) });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /from 1 to 0/);
  });

  test("answers only to a local hostname", async () => {
    assert.equal(await statusWithHost(s.base, "evil.example"), 403);
    assert.equal(await statusWithHost(s.base, "evil.example:4321"), 403);
    assert.equal(await statusWithHost(s.base, "localhost:4321"), 200);
  });
});

describe("a connection's namespaces", () => {
  let s: Running;
  const md = (name: string) => [{ path: "SKILL.md", content: `---\nname: ${name.split("/").pop()}\ndescription: About ${name}.\n---\n\nShared word.\n` }];
  before(async () => {
    s = await start();
    for (const name of ["workplace-ui/forms", "ux/contrast", "billing/invoices", "honed/skill-writing", "loose"]) {
      await s.hub.submitFeedback({ skill: name, text: "make it", files: md(name) });
    }
    await s.hub.idle();
  });
  after(async () => s.close());

  test("bound to workplace-ui and ux, it lists, searches and gets only those, and honed's own, named in its instructions", async () => {
    const client = await connect(s.base, undefined, "workplace-ui, ux/");
    const seen = ["honed/skill-writing", "ux/contrast", "workplace-ui/forms"];
    assert.deepEqual((await call(client, "list_skills")).value.map((k: { name: string }) => k.name).sort(), seen);
    assert.deepEqual((await call(client, "search_skills", { query: "shared word" })).value.map((k: { name: string }) => k.name).sort(), seen);
    assert.equal((await call(client, "get_skill", { name: "ux/contrast" })).isError, false);
    for (const hidden of ["billing/invoices", "loose"]) {
      const got = await call(client, "get_skill", { name: hidden });
      assert.equal(got.isError, true);
      assert.equal(got.value, `no skill is named ${hidden}`, "answered as if it did not exist");
    }
    const refused = await call(client, "submit_feedback", { name: "billing/invoices", quote: "description: About billing/invoices.", evidence: [{ command: "c", output: "o" }], what_changed: "w" });
    assert.match(refused.value, /outside the namespaces this repo is bound to \(workplace-ui\/, ux\/\)/);
    const told = client.getInstructions() ?? "";
    assert.match(told, /bound to workplace-ui\/, ux\/ \(and honed's own honed\/\)/);
    for (const name of seen) assert.match(told, new RegExp(`- ${name}: About ${name}\\.`));
    assert.doesNotMatch(told, /billing|loose/);
    await client.close();
  });

  test("unbound, it sees only honed/ skills, and its instructions say how to bind the repo", async () => {
    const client = await connect(s.base, undefined, null);
    assert.deepEqual((await call(client, "list_skills")).value.map((k: { name: string }) => k.name), ["honed/skill-writing"]);
    assert.deepEqual((await call(client, "search_skills", { query: "shared" })).value.map((k: { name: string }) => k.name), ["honed/skill-writing"]);
    assert.equal((await call(client, "get_skill", { name: "workplace-ui/forms" })).isError, true);
    const told = client.getInstructions() ?? "";
    assert.match(told, /bound to no namespace, so it sees only honed's own honed\/ skills/);
    assert.match(told, /"X-Honed-Namespaces": "your-project, shared"/);
    assert.match(told, /"Authorization": "Bearer \$\{HONED_TOKEN\}"/);
    assert.match(told, new RegExp(`"url": "${s.base}/mcp"`));
    assert.match((await call(client, "submit_feedback", { name: "ux/new-one", feedback: "f", files: md("ux/new-one") })).value, /bound to no namespace/);
    await client.close();
  });

  test("a namespace that is not a prefix is refused", async () => {
    const res = await fetch(`${s.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-honed-namespaces": "Bad Space!" }, body: "{}" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /is not a namespace/);
  });
});

test("a skill's history names the reports behind each version, and both behind a revert", async () => {
  const s = await start();
  try {
    const md = (body: string) => [{ path: "SKILL.md", content: `---\nname: x\ndescription: d\n---\n\n${body}\n` }];
    await s.hub.submitFeedback({ skill: "docs/x", text: "make it", files: md("Run `make ship`."), author: "maker" });
    await s.hub.idle();
    const { feedback: f } = await s.hub.submitFeedback({ skill: "docs/x", quote: "Run `make ship`.", evidence: [{ command: "make ship", output: "No rule" }], whatChanged: "Ran ./deploy.", files: md("Run `./deploy`."), author: "fixer" });
    await s.hub.idle();
    const history = await (await fetch(`${s.base}/skills/docs/x?tab=history`)).text();
    assert.match(history, new RegExp(`from report ${f.id.slice(0, 8)} by fixer on “Run <code>|from report ${f.id.slice(0, 8)} by fixer on “Run \`make ship\`\\.”`));
    assert.match(history, /from report [0-9a-f]{8} by maker/);
  } finally {
    await s.close();
  }
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

  test("connects with the .mcp.json honed gives, HONED_TOKEN filled from the environment, and nothing else", async () => {
    const { url, headers } = (JSON.parse(mcpJson(s.base, ["team"])) as { mcpServers: { honed: { url: string; headers: Record<string, string> } } }).mcpServers.honed;
    const env = { HONED_TOKEN: agent };
    const expanded = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.replace(/\$\{(\w+)\}/g, (_, name: keyof typeof env) => env[name])]));
    const client = new Client({ name: "fresh-repo", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: expanded } }));
    assert.match(client.getInstructions() ?? "", /bound to team\//);
    assert.equal((await call(client, "list_skills")).isError, false);
    await client.close();
  });

  test("attributes feedback to its token, with the role the agent gave", async () => {
    const client = await connect(s.base, agent);
    await call(client, "submit_feedback", { name: "docs/x", feedback: "make it", files: [{ path: "SKILL.md", content: "---\nname: x\ndescription: d\n---\n" }], author: "reviewer on PR 3" });
    await s.hub.idle();
    await call(client, "submit_feedback", { name: "docs/x", quote: "description: d", evidence: [{ command: "gh pr list --state merged", output: "#12 Fix login" }], what_changed: "Grouped by PR instead." });
    await s.hub.idle();
    assert.deepEqual(s.hub.store.feedback("docs/x").map((f) => f.author).sort(), ["ci-agent", "ci-agent (reviewer on PR 3)"]);
    await client.close();
  });

  test("lets only an admin revert, and records who did", async () => {
    const client = await connect(s.base, agent);
    await call(client, "submit_feedback", { name: "docs/x", quote: "description: d", evidence: [{ command: "gh pr list --state merged", output: "#12 Fix login" }], what_changed: "Grouped by PR instead.", feedback: "v2", files: [{ path: "SKILL.md", content: "---\nname: x\ndescription: d2\n---\n" }] });
    await client.close();
    await s.hub.idle();
    const asAgent = await fetch(`${s.base}/api/skills/docs/x/revert`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${agent}` }, body: JSON.stringify({ version: 1 }) });
    assert.equal(asAgent.status, 403);
    assert.match(((await asAgent.json()) as { error: string }).error, /admin token/);
    const asAdmin = await fetch(`${s.base}/api/skills/docs/x/revert`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${admin}` }, body: JSON.stringify({ version: 1 }) });
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
    const asAgent = await fetch(`${s.base}/api/skills/docs/x/edit`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${agent}` }, body: JSON.stringify({ path: "SKILL.md", content: "---\nname: x\ndescription: e\n---\n" }) });
    assert.equal(asAgent.status, 403);
    const edited = await fetch(`${s.base}/api/skills/docs/x/edit`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${admin}` }, body: JSON.stringify({ path: "SKILL.md", content: "---\nname: x\ndescription: edited\n---\n", reason: "typo" }) });
    assert.equal(edited.status, 200);
    assert.equal(s.hub.list().find((k) => k.name === "docs/x")?.description, "edited");
    const client = await connect(s.base, agent);
    assert.match((await call(client, "submit_feedback", { name: "docs/x", quote: "description: edited", evidence: [{ command: "gh pr list --state merged", output: "#12 Fix login" }], what_changed: "Grouped by PR instead." })).value, /revised once 2 more pieces of feedback arrive/);
    await client.close();
    const deleted = await fetch(`${s.base}/api/skills/docs/x/delete`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${admin}` }, body: JSON.stringify({ reason: "done" }) });
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(`${s.base}/api/skills/docs/x`, { headers: { authorization: `Bearer ${admin}` } })).status, 404);
  });

  test("lets only an admin set a skill's size limit, shown on its page", async () => {
    const set = (token: string, maxChars: string) => fetch(`${s.base}/api/skills/team/deploys/limit`, { method: "POST", headers: { ...WRITE, authorization: `Bearer ${token}` }, body: JSON.stringify({ maxChars }) });
    assert.equal((await set(agent, "5000")).status, 403);
    assert.equal((await set(admin, "5000")).status, 200);
    assert.equal(s.hub.skill("team/deploys").maxChars, 5000);
    const page = await (await fetch(`${s.base}/skills/team/deploys`, { headers: { authorization: `Bearer ${admin}` } })).text();
    assert.match(page, /\d+ of 5000 characters/);
    assert.match(page, /action="\/api\/skills\/team\/deploys\/limit"/);
    assert.equal((await set(admin, "nope")).status, 400);
    assert.equal((await set(admin, "")).status, 200);
    assert.equal(s.hub.skill("team/deploys").maxChars, null);
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
    assert.match(home, /Then set <code>HONED_TOKEN<\/code> in your environment to your token/);
  });
});

test("no plugin or hooks ship in the repo or the package: a repo connects with .mcp.json alone", async () => {
  const root = new URL("../", import.meta.url);
  for (const gone of ["plugin", ".claude-plugin", "src/plugin.spec.ts"]) assert.equal(existsSync(new URL(gone, root)), false, gone);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { files: string[] };
  for (const shipped of pkg.files) assert.doesNotMatch(shipped, /plugin|hooks/, shipped);
  assert.doesNotMatch(readFileSync(new URL("README.md", root), "utf8"), /claude plugin|\/plugin configure/);
});

test("a shared server refuses everyone until it has a token", async () => {
  const s = await start({ shared: true });
  try {
    assert.equal((await fetch(`${s.base}/api/skills`)).status, 401);
  } finally {
    await s.close();
  }
});
