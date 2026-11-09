import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { POLICIES, Refusal, SKILL_FILE, type Judgment, type Policy, type Proposal } from "./domain.ts";
import type { Hub } from "./hub.ts";
import { mcpServer } from "./mcp.ts";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Only these may name the server, so a page on another site cannot reach it by rebinding a hostname to 127.0.0.1. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Sent by the page with every write. A cross-site form cannot set it, and a cross-site fetch that does is refused by CORS. */
export const WRITE_HEADER = "x-skillhub";

const CSS = `
:root { --bg:#fbfaf8; --fg:#1d1d1f; --muted:#6b6b70; --line:#e3e1dc; --card:#fff; --accent:#3b5bdb; --add:#e6f4ea; --add-fg:#1e6b34; --del:#fdecea; --del-fg:#a1281d; --warn:#8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg:#151517; --fg:#ececee; --muted:#9a9aa2; --line:#2c2c31; --card:#1d1d21; --accent:#8ea2ff; --add:#15301f; --add-fg:#8fd6a4; --del:#3a1a17; --del-fg:#f0a39b; --warn:#e2b45c; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
main { max-width:960px; margin:0 auto; padding:24px 16px 64px; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
header.top { display:flex; gap:16px; align-items:baseline; border-bottom:1px solid var(--line); padding-bottom:12px; margin-bottom:24px; }
header.top a.home { font-weight:700; color:var(--fg); }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:17px; margin:32px 0 8px; }
.muted { color:var(--muted); } .small { font-size:13px; }
table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:600; }
pre { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:12px; overflow-x:auto; font:12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin:8px 0; white-space:pre; }
pre.diff span { display:block; } .d-add { background:var(--add); color:var(--add-fg); } .d-del { background:var(--del); color:var(--del-fg); } .d-hunk { color:var(--muted); }
details { margin:6px 0; } summary { cursor:pointer; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:8px 0; }
.pill { display:inline-block; font-size:12px; padding:1px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
.pill.open { color:var(--accent); border-color:var(--accent); } .pill.merged, .pill.helped, .pill.change { color:var(--add-fg); } .pill.rejected, .pill.hurt, .pill.failed { color:var(--del-fg); } .pill.missing, .pill.running { color:var(--warn); }
form.act { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:8px 0; }
input[type=text], select { font:inherit; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); }
input[type=text] { flex:1; min-width:180px; }
button { font:inherit; padding:5px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:var(--bg); }
.refusal { color:var(--del-fg); font-size:13px; width:100%; }
code { font:13px ui-monospace, Menlo, monospace; }
.reasoning { white-space:pre-wrap; }
`;

/** Sends a form as JSON with the write header, and shows a refusal beside the form, in the server's words. */
const SCRIPT = `
document.addEventListener("submit", async (ev) => {
  const form = ev.target.closest("form.act"); if (!form) return;
  ev.preventDefault();
  const out = form.querySelector(".refusal"); if (out) out.textContent = "";
  const body = Object.fromEntries(new FormData(form));
  const res = await fetch(form.getAttribute("action"), { method: "POST", headers: { "content-type": "application/json", "${WRITE_HEADER}": "1" }, body: JSON.stringify(body) });
  if (res.ok) { const to = form.dataset.then; to ? location.assign(to) : location.reload(); return; }
  const err = await res.json().catch(() => ({ error: res.statusText }));
  if (out) out.textContent = err.error;
});
`;

function page(title: string, body: Html, opts: { refresh?: boolean } = {}): Html {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${opts.refresh ? html`<meta http-equiv="refresh" content="4" />` : ""}
    <title>${title} · skillhub</title>
    <style>${raw(CSS)}</style>
  </head>
  <body>
    <main>
      <header class="top"><a class="home" href="/">skillhub</a><span class="muted small">skills agents learn for themselves</span></header>
      ${body}
    </main>
    <script>${raw(SCRIPT)}</script>
  </body>
</html>`;
}

const when = (iso: string | null) => (iso ? html`<span class="muted small" title="${iso}">${iso.replace("T", " ").slice(0, 16)}</span>` : "");
const pill = (text: string, kind = text) => html`<span class="pill ${kind}">${text}</span>`;
const short = (id: string) => id.slice(0, 8);

function diff(text: string): Html {
  if (!text.trim()) return html`<p class="muted small">No difference.</p>`;
  const lines = text.split("\n").map((l) => {
    const kind = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? "d-hunk" : l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : l.startsWith("@@") ? "d-hunk" : "";
    return html`<span class="${kind}">${l || " "}</span>`;
  });
  return html`<pre class="diff">${lines}</pre>`;
}

function action(path: string, label: string, opts: { reason?: string; primary?: boolean; extra?: Html; then?: string } = {}): Html {
  return html`<form class="act" action="${path}" ${opts.then ? html`data-then="${opts.then}"` : ""}>
    ${opts.extra ?? ""}
    ${opts.reason !== undefined ? html`<input type="text" name="reason" placeholder="${opts.reason}" />` : ""}
    <button type="submit" class="${opts.primary ? "primary" : ""}">${label}</button>
    <div class="refusal"></div>
  </form>`;
}

function judgmentLine(j: Judgment): Html {
  const what = j.state === "done" ? pill(j.outcome === "change" ? `made v${j.version}` : "no change", j.outcome ?? "") : pill(j.state);
  return html`<a href="/judgments/${j.id}">${j.by === "human" ? "You" : "Judge"} on ${j.skill}</a> ${what} ${when(j.startedAt)}`;
}

function proposalRow(p: Proposal, hub: Hub): Html {
  const votes = hub.store.votes(p.id);
  const up = votes.filter((v) => v.vote === "up").length;
  return html`<tr>
    <td><a href="/proposals/${p.id}">${p.title}</a><div class="muted small">by ${p.author}, on v${p.baseVersion}</div></td>
    <td>${pill(p.state)}</td>
    <td class="small">${up} up, ${votes.length - up} down · ${hub.store.comments(p.id).length} comments</td>
    <td>${when(p.createdAt)}</td>
  </tr>`;
}

function home(hub: Hub, origin: string): Html {
  const skills = hub.list();
  const known = new Set(skills.map((s) => s.name));
  const newSkills = hub.store.openProposals().filter((p) => !known.has(p.skill));
  const judgments = hub.store.recentJudgments(15);
  return page(
    "Skills",
    html`<h1>Skills</h1>
      <p class="muted">Agents read these, give feedback on them and propose changes; the judge decides what becomes the next version.</p>
      <div class="card small">Connect Claude Code: <code>claude mcp add --transport http skillhub ${origin}/mcp</code></div>
      ${skills.length === 0
        ? html`<p class="muted">No skills yet. An agent adds one by proposing it with <code>write_skill</code>.</p>`
        : html`<table>
            <tr><th>Skill</th><th>Version</th><th>Feedback on it</th><th>Open</th><th>Updated</th></tr>
            ${skills.map(
              (s) => html`<tr>
                <td><a href="/skills/${s.name}"><b>${s.name}</b></a>${s.policy === "human" ? html` ${pill("ruled by hand")}` : ""}<div class="muted small">${s.description}</div></td>
                <td>v${s.version}</td>
                <td class="small">${s.verdicts.helped} helped · ${s.verdicts.hurt} hurt · ${s.verdicts.missing} missing</td>
                <td>${s.openProposals ? pill(`${s.openProposals} proposals`, "open") : ""}</td>
                <td>${when(s.updatedAt)}</td>
              </tr>`,
            )}
          </table>`}
      ${newSkills.length
        ? html`<h2>Proposed skills</h2><table>${newSkills.map((p) => html`<tr><td><b>${p.skill}</b></td></tr>${proposalRow(p, hub)}`)}</table>`
        : ""}
      <h2>Recent judgments</h2>
      ${judgments.length ? html`${judgments.map((j) => html`<div>${judgmentLine(j)}</div>`)}` : html`<p class="muted small">None yet.</p>`}`,
    { refresh: judgments.some((j) => j.state === "running") },
  );
}

async function skillPage(hub: Hub, name: string): Promise<HtmlEscapedString> {
  const skill = hub.skill(name);
  const files = await hub.files(name, skill.version);
  const versions = hub.store.versions(name);
  const proposals = hub.store.proposals(name);
  const feedback = hub.store.feedback(name, 50);
  const judging = hub.isJudging(name);
  const diffs = await Promise.all(versions.map((v) => hub.library.diff(name, v.commit)));
  const summary = hub.list().find((s) => s.name === name)!;
  const policySelect = html`<select name="policy">${POLICIES.map(
    (p) => html`<option value="${p}" ${p === skill.policy ? "selected" : ""}>${p === "judge" ? "The judge rules" : "I rule by hand"}</option>`,
  )}</select>`;
  return page(
    name,
    html`<h1>${name} <span class="muted">v${skill.version}</span></h1>
      <p>${summary.description}</p>
      <p class="small muted">Checked out at <code>${hub.library.path(name)}</code> · on this version: ${summary.verdicts.helped} helped, ${summary.verdicts.hurt} hurt, ${summary.verdicts.missing} missing</p>
      ${judging ? html`<p>${pill("the judge is ruling", "running")}</p>` : ""}
      <div class="card">
        ${action(`/api/skills/${name}/policy`, "Save", { extra: policySelect })}
        ${skill.policy === "judge" && !judging ? action(`/api/skills/${name}/judge`, "Ask the judge to rule now") : ""}
      </div>

      <h2>Proposals</h2>
      ${proposals.length ? html`<table>${proposals.slice(0, 30).map((p) => proposalRow(p, hub))}</table>` : html`<p class="muted small">None.</p>`}

      <h2>Files</h2>
      ${files.map(
        (f) => html`<details ${f.path === SKILL_FILE ? "open" : ""}><summary><code>${f.path}</code>${f.executable ? html` ${pill("executable")}` : ""}</summary><pre>${f.content}</pre></details>`,
      )}

      <h2>History</h2>
      ${versions.map(
        (v, i) => html`<div class="card">
          <b>v${v.version}</b> ${v.note} <span class="small">· <a href="/judgments/${v.judgment}">${v.by === "human" ? "by you" : "by the judge"}</a></span> ${when(v.at)}
          <details><summary class="small">What changed</summary>${diff(diffs[i] ?? "")}</details>
          ${v.version < skill.version ? action(`/api/skills/${name}/revert`, `Revert to v${v.version}`, { reason: "Why (kept in the history)", extra: html`<input type="hidden" name="version" value="${v.version}" />` }) : ""}
        </div>`,
      )}

      <h2>Feedback</h2>
      ${feedback.length
        ? html`<table>
            <tr><th>Verdict</th><th>What happened</th><th>Considered</th></tr>
            ${feedback.map(
              (f) => html`<tr>
                <td>${pill(f.verdict)}<div class="muted small">on v${f.version}</div></td>
                <td>${f.reason}<div class="muted small">${f.author} · ${when(f.at)}</div></td>
                <td class="small">${f.judgment ? html`<a href="/judgments/${f.judgment}">${short(f.judgment)}</a>` : html`<span class="muted">waiting</span>`}</td>
              </tr>`,
            )}
          </table>`
        : html`<p class="muted small">None yet.</p>`}

      <h2>Judgments</h2>
      ${hub.store.judgments(name, 20).map((j) => html`<div>${judgmentLine(j)}</div>`)}`,
    { refresh: judging },
  );
}

async function proposalPage(hub: Hub, id: string): Promise<HtmlEscapedString> {
  const p = hub.proposal(id);
  const votes = hub.store.votes(id);
  const comments = hub.store.comments(id);
  const rulings = hub.store.rulingsOn(id);
  const exists = hub.store.skill(p.skill) !== undefined;
  return page(
    p.title,
    html`<p class="small">${exists ? html`<a href="/skills/${p.skill}">${p.skill}</a>` : html`${p.skill} (a new skill)`}</p>
      <h1>${p.title}</h1>
      <p>${pill(p.state)} <span class="muted small">by ${p.author}, on v${p.baseVersion}, ${when(p.createdAt)}</span></p>
      <h2>Why</h2>
      <p class="reasoning">${p.why}</p>
      <h2>${p.state === "open" ? "What it changes in the current version" : "What it proposed"}</h2>
      ${p.state === "open"
        ? diff(await hub.proposalDiff(p))
        : html`${p.change.remove.map((r) => html`<div class="small">Remove <code>${r}</code></div>`)}${p.change.write.map(
            (w) => html`<details><summary><code>${w.path}</code></summary><pre>${w.content}</pre></details>`,
          )}`}
      ${p.state === "open"
        ? html`<div class="card">
            <b>Override the judge</b>
            ${action(`/api/proposals/${id}/merge`, "Merge it", { reason: "Why (kept in the history)", primary: true })}
            ${action(`/api/proposals/${id}/reject`, "Reject it", { reason: "Why (the proposer reads this)" })}
          </div>`
        : ""}
      <h2>Votes</h2>
      ${votes.length ? html`${votes.map((v) => html`<div class="card">${pill(v.vote, v.vote === "up" ? "merged" : "rejected")} ${v.reason}<div class="muted small">${v.author} · ${when(v.at)}</div></div>`)}` : html`<p class="muted small">None.</p>`}
      <h2>Comments</h2>
      ${comments.length ? html`${comments.map((c) => html`<div class="card">${c.body}<div class="muted small">${c.author} · ${when(c.at)}</div></div>`)}` : html`<p class="muted small">None.</p>`}
      <h2>Rulings</h2>
      ${rulings.length
        ? html`${rulings.map((r) => html`<div class="card">${pill(r.ruling)} ${r.reason} <a class="small" href="/judgments/${r.judgment}">judgment ${short(r.judgment)}</a></div>`)}`
        : html`<p class="muted small">${hub.isJudging(p.skill) ? "The judge is ruling." : "None yet."}</p>`}`,
    { refresh: p.state === "open" && hub.isJudging(p.skill) },
  );
}

async function judgmentPage(hub: Hub, id: string): Promise<HtmlEscapedString> {
  const j = hub.judgment(id);
  const rulings = hub.store.rulingsOf(id);
  const feedback = hub.store.feedbackOf(id);
  const version = j.version ? hub.store.version(j.skill, j.version) : undefined;
  return page(
    `Judgment ${short(id)}`,
    html`<p class="small"><a href="/skills/${j.skill}">${j.skill}</a></p>
      <h1>${j.by === "human" ? "Your ruling" : "The judge's ruling"}</h1>
      <p>${pill(j.state)} ${j.outcome ? pill(j.outcome === "change" ? `made v${j.version}` : "no change", j.outcome) : ""} ${when(j.startedAt)}</p>
      ${j.reasoning ? html`<h2>Reasoning</h2><p class="reasoning">${j.reasoning}</p>` : ""}
      ${j.error ? html`<h2>Why it failed</h2><pre>${j.error}</pre>` : ""}
      ${rulings.length
        ? html`<h2>Proposals</h2>${rulings.map((r) => html`<div class="card">${pill(r.ruling)} <a href="/proposals/${r.proposal}">${hub.store.proposal(r.proposal)?.title ?? r.proposal}</a><div>${r.reason}</div></div>`)}`
        : ""}
      ${feedback.length
        ? html`<h2>Feedback it considered</h2>${feedback.map((f) => html`<div class="card">${pill(f.verdict)} ${f.reason}<div class="muted small">${f.author} · on v${f.version}</div></div>`)}`
        : ""}
      ${version ? html`<h2>What v${version.version} changed</h2>${diff(await hub.library.diff(j.skill, version.commit))}` : ""}`,
    { refresh: j.state === "running" },
  );
}

const field = (body: Record<string, unknown>, key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");

export function app(hub: Hub, version: string): Hono {
  const web = new Hono();

  web.onError((e, c) => {
    if (e instanceof Refusal) {
      const status = e.status as 400;
      return c.req.path.startsWith("/api") || c.req.path === "/mcp" ? c.json({ error: e.message }, status) : c.html(page("Not found", html`<h1>${e.message}</h1>`), status);
    }
    console.error(e);
    return c.json({ error: "something went wrong in the server; its log says what" }, 500);
  });

  web.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (!LOCAL_HOSTS.has(host)) return c.json({ error: `skillhub answers only to localhost, not ${host || "no host"}` }, 403);
    await next();
  });

  web.all("/mcp", async (c) => {
    const server = mcpServer(hub, version);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  const writes = new Hono();
  writes.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header(WRITE_HEADER) !== "1") return c.json({ error: `a write must carry the ${WRITE_HEADER} header` }, 403);
    await next();
  });
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  writes.post("/proposals/:id/merge", async (c) => c.json(await hub.merge(c.req.param("id"), field(await body(c), "reason"))));
  writes.post("/proposals/:id/reject", async (c) => c.json(await hub.reject(c.req.param("id"), field(await body(c), "reason"))));
  writes.post("/skills/:name/revert", async (c) => {
    const b = await body(c);
    return c.json(await hub.revert(c.req.param("name"), Number(field(b, "version") || b.version), field(b, "reason")));
  });
  writes.post("/skills/:name/policy", async (c) => {
    const policy = field(await body(c), "policy");
    if (!POLICIES.includes(policy as Policy)) throw new Refusal(`policy must be one of ${POLICIES.join(", ")}`);
    return c.json(hub.setPolicy(c.req.param("name"), policy as Policy));
  });
  writes.post("/skills/:name/judge", (c) => (hub.judgeNow(c.req.param("name")), c.json({ judging: true })));
  web.route("/api", writes);

  web.get("/api/skills", (c) => c.json(hub.list(c.req.query("q"))));
  web.get("/api/skills/:name", async (c) => {
    const name = c.req.param("name");
    return c.json({ ...hub.skill(name), files: await hub.current(name), versions: hub.store.versions(name), proposals: hub.store.proposals(name) });
  });
  web.get("/api/proposals/:id", (c) => {
    const id = c.req.param("id");
    return c.json({ ...hub.proposal(id), votes: hub.store.votes(id), comments: hub.store.comments(id), rulings: hub.store.rulingsOn(id) });
  });
  web.get("/api/judgments/:id", (c) => c.json(hub.judgment(c.req.param("id"))));

  web.get("/", (c) => c.html(home(hub, new URL(c.req.url).origin)));
  web.get("/skills/:name", async (c) => c.html(await skillPage(hub, c.req.param("name"))));
  web.get("/proposals/:id", async (c) => c.html(await proposalPage(hub, c.req.param("id"))));
  web.get("/judgments/:id", async (c) => c.html(await judgmentPage(hub, c.req.param("id"))));

  return web;
}
