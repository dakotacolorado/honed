import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { callerOf } from "./auth.ts";
import { LOCAL_CALLER, Refusal, SKILL_FILE, type Caller, type Feedback, type Judgment } from "./domain.ts";
import type { Hub, SkillSummary } from "./hub.ts";
import { mcpServer } from "./mcp.ts";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Only these may name a server with no tokens, so a page on another site cannot reach it by rebinding a hostname to 127.0.0.1. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Sent by the page with every write. A cross-site form cannot set it, and a cross-site fetch that does is refused by CORS. */
export const WRITE_HEADER = "x-honed";
const COOKIE = "honed_token";

export interface AppOptions {
  /** Bound beyond this machine: every request then needs a token, even before any exists. */
  shared?: boolean;
}

/** Who is asking, and whether the server is local: no tokens, and answering only its own machine. */
interface Viewer {
  caller: Caller;
  local: boolean;
}

type Env = { Variables: { viewer: Viewer } };

const CSS = `
:root { --bg:#fbfaf8; --fg:#1d1d1f; --muted:#6b6b70; --line:#e3e1dc; --card:#fff; --accent:#3b5bdb; --add:#e6f4ea; --add-fg:#1e6b34; --del:#fdecea; --del-fg:#a1281d; --warn:#8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg:#151517; --fg:#ececee; --muted:#9a9aa2; --line:#2c2c31; --card:#1d1d21; --accent:#8ea2ff; --add:#15301f; --add-fg:#8fd6a4; --del:#3a1a17; --del-fg:#f0a39b; --warn:#e2b45c; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
main { max-width:960px; margin:0 auto; padding:24px 16px 64px; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
header.top { display:flex; gap:16px; align-items:baseline; border-bottom:1px solid var(--line); padding-bottom:12px; margin-bottom:24px; flex-wrap:wrap; }
header.top a.home { font-weight:700; color:var(--fg); }
header.top .who { margin-left:auto; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:17px; margin:32px 0 8px; }
.muted { color:var(--muted); } .small { font-size:13px; }
table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:600; }
pre { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:12px; overflow-x:auto; font:12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin:8px 0; white-space:pre; }
pre.diff span { display:block; } .d-add { background:var(--add); color:var(--add-fg); } .d-del { background:var(--del); color:var(--del-fg); } .d-hunk { color:var(--muted); }
details { margin:6px 0; } summary { cursor:pointer; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:8px 0; }
.pill { display:inline-block; font-size:12px; padding:1px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
.pill.changed { color:var(--add-fg); } .pill.failed { color:var(--del-fg); } .pill.running, .pill.waiting { color:var(--warn); }
form.act, form.search { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:8px 0; }
form.search { margin:16px 0; }
input[type=text], input[type=password] { font:inherit; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); flex:1; min-width:180px; }
button { font:inherit; padding:5px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:var(--bg); }
.refusal { color:var(--del-fg); font-size:13px; width:100%; }
.bar { display:inline-block; width:80px; height:6px; border-radius:3px; background:var(--line); vertical-align:middle; overflow:hidden; }
.bar i { display:block; height:100%; background:var(--accent); }
.snippet { font-size:13px; color:var(--muted); }
code { font:13px ui-monospace, Menlo, monospace; }
.prose { white-space:pre-wrap; }
`;

/** Sends a form as JSON with the write header, and shows a refusal beside the form, in the server's words. */
const SCRIPT = `
document.addEventListener("submit", async (ev) => {
  const form = ev.target.closest("form.act"); if (!form) return;
  ev.preventDefault();
  const out = form.querySelector(".refusal"); if (out) out.textContent = "";
  const body = Object.fromEntries(new FormData(form));
  const res = await fetch(form.getAttribute("action"), { method: "POST", headers: { "content-type": "application/json", "${WRITE_HEADER}": "1" }, body: JSON.stringify(body) });
  if (res.ok) { location.reload(); return; }
  const err = await res.json().catch(() => ({ error: res.statusText }));
  if (out) out.textContent = err.error;
});
`;

function page(title: string, body: Html, opts: { refresh?: boolean; viewer?: Viewer } = {}): Html {
  const who = opts.viewer && !opts.viewer.local ? html`<span class="who small muted">${opts.viewer.caller.name}${opts.viewer.caller.admin ? " (admin)" : ""} · <a href="/logout">sign out</a></span>` : "";
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${opts.refresh ? html`<meta http-equiv="refresh" content="4" />` : ""}
    <title>${title} · honed</title>
    <style>${raw(CSS)}</style>
  </head>
  <body>
    <main>
      <header class="top"><a class="home" href="/">honed</a><span class="muted small">share and hone skills across your organization</span>${who}</header>
      ${body}
    </main>
    <script>${raw(SCRIPT)}</script>
  </body>
</html>`;
}

const when = (iso: string | null) => (iso ? html`<span class="muted small" title="${iso}">${iso.replace("T", " ").slice(0, 16)}</span>` : "");
const pill = (text: string, kind = text) => html`<span class="pill ${kind}">${text}</span>`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function size(chars: number, cap: number): Html {
  return html`<span title="${chars} of ${cap} characters"><span class="bar"><i style="width:${Math.min(100, Math.round((chars / cap) * 100))}%"></i></span> <span class="muted small">${k(chars)} / ${k(cap)}</span></span>`;
}

function diff(text: string): Html {
  if (!text.trim()) return html`<p class="muted small">No difference.</p>`;
  const lines = text.split("\n").map((l) => {
    const kind = /^(\+\+\+|---|diff |index |@@)/.test(l) ? "d-hunk" : l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : "";
    return html`<span class="${kind}">${l || " "}</span>`;
  });
  return html`<pre class="diff">${lines}</pre>`;
}

function action(path: string, label: string, opts: { reason?: string; extra?: Html } = {}): Html {
  return html`<form class="act" action="${path}">
    ${opts.extra ?? ""}
    ${opts.reason !== undefined ? html`<input type="text" name="reason" placeholder="${opts.reason}" />` : ""}
    <button type="submit">${label}</button>
    <div class="refusal"></div>
  </form>`;
}

const rulerName = (j: Judgment) => (j.by === "person" ? (j.actor && j.actor !== "you" ? j.actor : "You") : "The judge");

function outcome(j: Judgment): Html {
  if (j.state !== "done") return pill(j.state);
  return j.changed ? pill(`made v${j.version}`, "changed") : pill("no change");
}

function judgmentLine(j: Judgment): Html {
  return html`<div><a href="/judgments/${j.id}">${rulerName(j)} on ${j.skill}</a> ${outcome(j)} ${when(j.startedAt)}</div>`;
}

function feedbackCard(f: Feedback): Html {
  return html`<div class="card">
    <div class="prose">${f.text}</div>
    ${f.draft.length
      ? html`<details><summary class="small">Their draft: ${f.draft.map((d) => d.path).join(", ")}</summary>${f.draft.map((d) => html`<div class="small"><code>${d.path}</code></div><pre>${d.content}</pre>`)}</details>`
      : ""}
    <div class="muted small">${f.author} · on ${f.version ? `v${f.version}` : "a new skill"} · ${when(f.at)} ·
      ${f.judgment ? html`<a href="/judgments/${f.judgment}">considered</a>` : pill("waiting")}</div>
  </div>`;
}

function skillRow(s: SkillSummary, cap: number, snippet?: string): Html {
  return html`<tr>
    <td><a href="/skills/${s.name}"><b>${s.name}</b></a><div class="muted small">${s.description}</div>${snippet ? html`<div class="snippet">${snippet}</div>` : ""}</td>
    <td>v${s.version}</td>
    <td class="small">${size(s.chars, cap)}</td>
    <td class="small">${s.feedback} on this version</td>
  </tr>`;
}

const SKILL_HEAD = html`<tr><th>Skill</th><th>Version</th><th>Size</th><th>Feedback</th></tr>`;

function connect(origin: string, viewer: Viewer): Html {
  return html`<details class="card small"><summary>Connect Claude Code</summary>
    <pre>claude mcp add --transport http --scope user honed ${origin}/mcp${viewer.local ? "" : ' --header "Authorization: Bearer <your token>"'}</pre>
    <p>Or the plugin, which also asks each session for feedback on the skills it used:</p>
    <pre>claude plugin marketplace add dakotacolorado/honed
claude plugin install honed@honed --config url=${origin}</pre>
    ${viewer.local ? "" : html`<p>Then <code>/plugin configure honed@honed</code> in a session to give it your token.</p>`}
  </details>`;
}

function home(hub: Hub, origin: string, viewer: Viewer, q: string): Html {
  const results = q.trim() ? hub.search(q, 50) : null;
  const skills = hub.list();
  const judgments = hub.store.recentJudgments(15);
  return page(
    "Skills",
    html`<h1>Skills</h1>
      <p class="muted">Your agents use these, and submit feedback when they do. Each skill is revised from that feedback, and every version is kept.</p>
      ${connect(origin, viewer)}
      <form class="search" method="get" action="/"><input type="text" name="q" value="${q}" placeholder="Search every skill" /><button type="submit">Search</button></form>
      ${results
        ? results.length
          ? html`<table>${SKILL_HEAD}${results.map((r) => skillRow(r, hub.maxChars, r.snippet))}</table>`
          : html`<p class="muted">No skill mentions that.</p>`
        : skills.length
          ? html`<table>${SKILL_HEAD}${skills.map((s) => skillRow(s, hub.maxChars))}</table>`
          : html`<p class="muted">No skills yet. An agent adds one by submitting feedback under a new name with a draft.</p>`}
      <h2>Recent changes</h2>
      ${judgments.length ? judgments.map(judgmentLine) : html`<p class="muted small">None yet.</p>`}`,
    { refresh: !results && judgments.some((j) => j.state === "running"), viewer },
  );
}

async function skillPage(hub: Hub, name: string, viewer: Viewer): Promise<HtmlEscapedString> {
  const skill = hub.skill(name);
  const summary = hub.list().find((s) => s.name === name)!;
  const files = await hub.files(name, skill.version);
  const versions = hub.store.versions(name);
  const diffs = await Promise.all(versions.map((v) => hub.library.diff(name, v.commit)));
  const feedback = hub.store.feedback(name, 50);
  const judging = hub.isJudging(name);
  const admin = viewer.caller.admin;
  return page(
    name,
    html`<h1>${name} <span class="muted">v${skill.version}</span></h1>
      <p>${summary.description}</p>
      <p class="small">${size(summary.chars, hub.maxChars)} ${judging ? pill("revising", "running") : ""}</p>
      ${admin && !judging ? action(`/api/skills/${name}/judge`, "Revise from feedback now") : ""}

      <h2>Files</h2>
      ${files.map(
        (f) => html`<details ${f.path === SKILL_FILE ? "open" : ""}><summary><code>${f.path}</code>${f.executable ? " (executable)" : ""}</summary><pre>${f.content}</pre></details>`,
      )}

      <h2>Feedback</h2>
      ${feedback.length ? feedback.map(feedbackCard) : html`<p class="muted small">None yet.</p>`}

      <h2>History</h2>
      ${versions.map(
        (v, i) => html`<div class="card">
          <b>v${v.version}</b> ${v.note} · <a class="small" href="/judgments/${v.judgment}">why</a> ${when(v.at)}
          <details><summary class="small">What changed</summary>${diff(diffs[i] ?? "")}</details>
          ${admin && v.version < skill.version
            ? action(`/api/skills/${name}/revert`, `Revert to v${v.version}`, { reason: "Why (kept in the history)", extra: html`<input type="hidden" name="version" value="${v.version}" />` })
            : ""}
        </div>`,
      )}`,
    { refresh: judging, viewer },
  );
}

async function judgmentPage(hub: Hub, id: string, viewer: Viewer): Promise<HtmlEscapedString> {
  const j = hub.judgment(id);
  const feedback = hub.store.feedbackOf(id);
  const version = j.version ? hub.store.version(j.skill, j.version) : undefined;
  const exists = hub.store.skill(j.skill) !== undefined;
  return page(
    `${j.skill}: ${j.by === "person" ? "revert" : "revision"}`,
    html`<p class="small">${exists ? html`<a href="/skills/${j.skill}">${j.skill}</a>` : j.skill}</p>
      <h1>${j.by === "person" ? `${rulerName(j)} reverted it` : "Revision from feedback"}</h1>
      <p>${outcome(j)} ${when(j.startedAt)}</p>
      ${j.reasoning ? html`<h2>Why</h2><p class="prose">${j.reasoning}</p>` : ""}
      ${j.error ? html`<h2>Why it failed</h2><pre>${j.error}</pre>` : ""}
      ${version ? html`<h2>What v${version.version} changed</h2>${diff(await hub.library.diff(j.skill, version.commit))}` : ""}
      ${feedback.length ? html`<h2>The feedback it considered</h2>${feedback.map(feedbackCard)}` : ""}`,
    { refresh: j.state === "running", viewer },
  );
}

function loginPage(error?: string): Html {
  return page(
    "Sign in",
    html`<h1>Sign in</h1>
      <p class="muted">This honed is shared: paste the token you were given. <code>honed token create &lt;name&gt;</code> on the server makes one.</p>
      <form method="post" action="/login" class="search"><input type="password" name="token" placeholder="honed_…" autocomplete="current-password" /><button type="submit" class="primary">Sign in</button></form>
      ${error ? html`<p class="refusal">${error}</p>` : ""}`,
  );
}

const field = (body: Record<string, unknown>, key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");

export function app(hub: Hub, version: string, opts: AppOptions = {}): Hono<Env> {
  const web = new Hono<Env>();
  const shared = opts.shared ?? false;

  web.onError((e, c) => {
    if (e instanceof Refusal) {
      const status = e.status as 400;
      return c.req.path.startsWith("/api") || c.req.path === "/mcp" ? c.json({ error: e.message }, status) : c.html(page("Not found", html`<h1>${e.message}</h1>`), status);
    }
    console.error(e);
    return c.json({ error: "something went wrong in the server; its log says what" }, 500);
  });

  web.get("/login", (c) => c.html(loginPage()));
  web.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const token = typeof form.token === "string" ? form.token.trim() : "";
    if (!callerOf(hub.store, token)) return c.html(loginPage("That token is not one this server issued, or it was revoked."), 401);
    const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Strict", path: "/", secure, maxAge: 60 * 60 * 24 * 30 });
    return c.redirect("/");
  });
  web.get("/logout", (c) => (deleteCookie(c, COOKIE, { path: "/" }), c.redirect("/login")));

  // No tokens and not shared: local, open to this machine alone. Otherwise every request names its token.
  web.use("*", async (c, next) => {
    const local = !shared && hub.store.tokens().length === 0;
    if (local) {
      const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
      if (!LOCAL_HOSTS.has(host)) return c.json({ error: `honed answers only to localhost, not ${host || "no host"}, until it has tokens` }, 403);
      c.set("viewer", { caller: LOCAL_CALLER, local });
      return next();
    }
    const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const caller = callerOf(hub.store, bearer ?? getCookie(c, COOKIE));
    if (!caller) {
      if (c.req.method === "GET" && !c.req.path.startsWith("/api") && c.req.path !== "/mcp") return c.redirect("/login");
      c.header("WWW-Authenticate", 'Bearer realm="honed"');
      return c.json({ error: bearer ? "that token is not one this server issued, or it was revoked" : "this honed is shared: send Authorization: Bearer <token>" }, 401);
    }
    c.set("viewer", { caller, local });
    return next();
  });

  web.all("/mcp", async (c) => {
    const { caller, local } = c.get("viewer");
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcpServer(hub, version, caller, local).connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  const writes = new Hono<Env>();
  writes.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    if (c.req.header(WRITE_HEADER) !== "1") return c.json({ error: `a write must carry the ${WRITE_HEADER} header` }, 403);
    if (!c.get("viewer").caller.admin) return c.json({ error: "this takes an admin token" }, 403);
    return next();
  });
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  writes.post("/skills/:name/revert", async (c) => {
    const b = await body(c);
    return c.json(await hub.revert(c.req.param("name"), Number(field(b, "version") || b.version), field(b, "reason"), c.get("viewer").caller.name));
  });
  writes.post("/skills/:name/judge", (c) => (hub.judgeNow(c.req.param("name")), c.json({ revising: true })));
  web.route("/api", writes);

  web.get("/api/skills", (c) => {
    const q = c.req.query("q");
    return c.json(q ? hub.search(q, Number(c.req.query("limit") ?? 20)) : hub.list());
  });
  web.get("/api/skills/:name", async (c) => {
    const name = c.req.param("name");
    return c.json({ ...hub.skill(name), files: await hub.current(name), versions: hub.store.versions(name), feedback: hub.store.feedback(name) });
  });
  web.get("/api/judgments/:id", (c) => c.json({ ...hub.judgment(c.req.param("id")), feedback: hub.store.feedbackOf(c.req.param("id")) }));

  web.get("/", (c) => c.html(home(hub, new URL(c.req.url).origin, c.get("viewer"), c.req.query("q") ?? "")));
  web.get("/skills/:name", async (c) => c.html(await skillPage(hub, c.req.param("name"), c.get("viewer"))));
  web.get("/judgments/:id", async (c) => c.html(await judgmentPage(hub, c.req.param("id"), c.get("viewer"))));

  return web;
}
