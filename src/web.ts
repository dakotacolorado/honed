import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { callerOf } from "./auth.ts";
import { TAGLINE, WORDMARK } from "./banner.ts";
import { JUDGE_SKILL, LOCAL_CALLER, NAME_ROUTE, prefixOf, Refusal, SKILL_FILE, type Caller, type Feedback, type Judgment } from "./domain.ts";
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
:root {
  --bg:#f5f7f8; --fg:#1b2328; --muted:#62707a; --line:#dde3e7; --card:#ffffff; --sunk:#eef2f4;
  --edge:#0b7a75; --edge-soft:#dcf1ef; --sage:#0b7a75; --sage-soft:#dcf1ef; --rust:#b42e3a; --rust-soft:#fbe3e5;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1417; --fg:#e3eaee; --muted:#8a99a3; --line:#253038; --card:#151c20; --sunk:#0b1013;
    --edge:#4fd1c5; --edge-soft:#123331; --sage:#4fd1c5; --sage-soft:#123331; --rust:#f39aa2; --rust-soft:#3a1a1f; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:920px; margin:0 auto; padding:20px 16px 72px; }
a { color:var(--edge); text-decoration:none; } a:hover { text-decoration:underline; }
:focus-visible { outline:2px solid var(--edge); outline-offset:2px; border-radius:4px; }
.mono, code, pre, h1, h2, .name, .pill, button, .brand { font-family:var(--mono); }
header.top { display:flex; gap:12px; align-items:center; padding-bottom:14px; margin-bottom:28px; border-bottom:1px dashed var(--line); flex-wrap:wrap; }
.brand { font-weight:700; color:var(--fg); letter-spacing:.02em; }
.brand .star { color:var(--edge); }
header.top .who { margin-left:auto; }
h1 { font-size:22px; margin:0 0 6px; letter-spacing:-.01em; }
h2 { font-size:14px; margin:36px 0 10px; color:var(--muted); font-weight:600; text-transform:lowercase; }
h2::before { content:"✦ "; color:var(--edge); }
.muted { color:var(--muted); } .small { font-size:13px; }
.hero { margin:8px 0 24px; }
.wordmark { color:var(--edge); font-size:clamp(10px, 3vw, 15px); line-height:1.25; margin:0; background:none; border:0; padding:0; overflow:visible; }
.edge { display:flex; align-items:center; width:31ch; max-width:100%; font-family:var(--mono); font-size:clamp(10px, 3vw, 15px); margin:4px 0 16px; color:var(--edge); }
.edge::before { content:""; flex:1; border-top:2px solid var(--muted); opacity:.5; margin-right:4px; }
.tagline { font-size:18px; font-weight:600; margin:0 0 4px; }
pre { background:var(--sunk); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow-x:auto; font-size:12.5px; line-height:1.5; margin:8px 0; white-space:pre-wrap; overflow-wrap:anywhere; }
pre.diff { white-space:pre; overflow-wrap:normal; }
pre.diff span { display:block; } .d-add { background:var(--sage-soft); color:var(--sage); } .d-del { background:var(--rust-soft); color:var(--rust); } .d-hunk { color:var(--muted); }
details { margin:8px 0; } summary { cursor:pointer; } summary:hover { color:var(--edge); }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:10px 0; }
.connect summary { font-weight:600; }
.connect p { margin:10px 0 4px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px; }
a.skill { display:block; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; transition:border-color .15s, transform .15s; }
a.skill:hover { text-decoration:none; border-color:var(--edge); transform:translateY(-1px); }
.name { font-weight:700; color:var(--fg); }
.desc { margin:4px 0 10px; font-size:14px; }
.meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:12.5px; color:var(--muted); }
.snippet { font-size:13px; color:var(--muted); margin:-4px 0 10px; }
.snippet mark { background:var(--edge-soft); color:var(--fg); border-radius:3px; padding:0 2px; }
.bar { display:inline-block; width:64px; height:6px; border-radius:3px; background:var(--line); vertical-align:middle; overflow:hidden; }
.bar i { display:block; height:100%; background:var(--edge); }
.pill { display:inline-block; font-size:11.5px; padding:1px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
.pill.changed { color:var(--sage); background:var(--sage-soft); border-color:transparent; }
.pill.failed { color:var(--rust); background:var(--rust-soft); border-color:transparent; }
.pill.waiting { color:var(--edge); background:var(--edge-soft); border-color:transparent; }
.pill.running { color:var(--edge); border-color:var(--edge); }
.pill.running::before { content:"✦ "; display:inline-block; animation:spin 1.6s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .pill.running::before { animation:none; } a.skill { transition:none; } a.skill:hover { transform:none; } }
form.search { display:flex; gap:8px; margin:20px 0 6px; }
form.act { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:10px 0 0; }
input[type=search], input[type=text], input[type=password] { font:inherit; padding:9px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); flex:1; min-width:0; }
input::placeholder { color:var(--muted); font-family:var(--mono); font-size:13.5px; }
kbd { font-family:var(--mono); font-size:11px; border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 5px; color:var(--muted); }
button { font-size:13px; padding:8px 14px; border-radius:8px; border:1px solid var(--edge); background:transparent; color:var(--edge); cursor:pointer; }
button:hover { background:var(--edge-soft); }
button.primary { background:var(--edge); color:var(--bg); } button.primary:hover { filter:brightness(1.08); }
.refusal { color:var(--rust); font-size:13px; width:100%; }
button.danger { color:var(--rust); border-color:var(--rust); } button.danger:hover { background:var(--rust-soft); }
form.act textarea { width:100%; min-height:240px; font:12.5px/1.5 var(--mono); padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); }
form.act label { width:100%; font-size:13px; color:var(--muted); }
.refusal:empty { display:none; }
.quote { border-left:3px solid var(--edge); padding:2px 0 2px 12px; margin:0 0 8px; white-space:pre-wrap; }
.by { font-family:var(--mono); font-size:12px; color:var(--muted); }
.timeline { position:relative; margin-left:6px; padding-left:20px; border-left:1px dashed var(--line); }
.event { position:relative; margin:0 0 18px; }
.event::before { content:"✦"; position:absolute; left:-27px; top:0; color:var(--edge); background:var(--bg); font-size:13px; line-height:1.4; }
.event.person::before { content:"↺"; }
.feed div { margin:6px 0; }
.prose { white-space:pre-wrap; }
.empty { border:1px dashed var(--line); border-radius:10px; padding:22px; text-align:center; color:var(--muted); }
.back { font-family:var(--mono); font-size:13px; }
h3.group { font-family:var(--mono); font-size:13px; font-weight:600; color:var(--muted); margin:18px 0 8px; }
footer { margin-top:56px; padding-top:14px; border-top:1px dashed var(--line); font-family:var(--mono); font-size:12px; color:var(--muted); }
footer details { display:inline; margin:0; }
footer details[open] { display:block; margin-top:8px; font-family:initial; }
footer summary { font-family:var(--mono); display:inline; color:var(--edge); list-style:none; }
footer summary::-webkit-details-marker { display:none; }
.note { border-left:3px solid var(--edge); background:var(--edge-soft); border-radius:6px; padding:10px 14px; margin:14px 0; font-size:14px; }
`;

/** Sends a form as JSON with the write header and shows a refusal beside it in the server's words; "/" focuses search. */
const SCRIPT = `
document.addEventListener("submit", async (ev) => {
  const form = ev.target.closest("form.act"); if (!form) return;
  ev.preventDefault();
  const out = form.querySelector(".refusal"); if (out) out.textContent = "";
  const button = form.querySelector("button"); if (button) button.disabled = true;
  const body = Object.fromEntries(new FormData(form));
  const res = await fetch(form.getAttribute("action"), { method: "POST", headers: { "content-type": "application/json", "${WRITE_HEADER}": "1" }, body: JSON.stringify(body) });
  if (res.ok) { form.dataset.then ? location.assign(form.dataset.then) : location.reload(); return; }
  if (button) button.disabled = false;
  const err = await res.json().catch(() => ({ error: res.statusText }));
  if (out) out.textContent = err.error;
});
document.addEventListener("keydown", (ev) => {
  const q = document.querySelector("input[type=search]");
  if (ev.key === "/" && q && document.activeElement?.tagName !== "INPUT") { ev.preventDefault(); q.focus(); }
});
`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="16" y="25" font-size="26" text-anchor="middle" fill="#14a39a">✦</text></svg>')}`;

function page(title: string, body: Html, opts: { refresh?: boolean; viewer?: Viewer; version?: string; footer?: Html } = {}): Html {
  const who = opts.viewer && !opts.viewer.local ? html`<span class="who small muted">${opts.viewer.caller.name}${opts.viewer.caller.admin ? " (admin)" : ""} · <a href="/logout">sign out</a></span>` : "";
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${opts.refresh ? html`<meta http-equiv="refresh" content="4" />` : ""}
    <title>${title}</title>
    <link rel="icon" href="${FAVICON}" />
    <style>${raw(CSS)}</style>
  </head>
  <body>
    <main>
      <header class="top"><a class="brand" href="/"><span class="star">✦</span> honed</a><span class="muted small">share and hone skills across your organization</span>${who}</header>
      ${body}
      <footer>honed${opts.version ? ` v${opts.version}` : ""}${opts.footer ?? ""}</footer>
    </main>
    <script>${raw(SCRIPT)}</script>
  </body>
</html>`;
}

/** "3h ago", with the exact time on hover. */
function ago(iso: string | null): Html {
  if (!iso) return html``;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const text = s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : s < 86400 * 30 ? `${Math.floor(s / 86400)}d ago` : iso.slice(0, 10);
  return html`<time datetime="${iso}" title="${iso.replace("T", " ").slice(0, 19)} UTC">${text}</time>`;
}

const pill = (text: string, kind = "") => html`<span class="pill ${kind}">${text}</span>`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function size(chars: number, cap: number): Html {
  return html`<span title="${chars} of ${cap} characters, the cap"><span class="bar"><i style="width:${Math.min(100, Math.round((chars / cap) * 100))}%"></i></span> ${k(chars)}/${k(cap)}</span>`;
}

/** Search snippets mark matches with «»; the page shows them highlighted, everything else escaped. */
function snippet(text: string): Html {
  const parts = text.split(/«|»/);
  return html`<div class="snippet">${parts.map((p, i) => (i % 2 ? html`<mark>${p}</mark>` : p))}</div>`;
}

function diff(text: string): Html {
  if (!text.trim()) return html`<p class="muted small">No difference.</p>`;
  const lines = text.split("\n").map((l) => {
    const kind = /^(\+\+\+|---|diff |index |@@)/.test(l) ? "d-hunk" : l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : "";
    return html`<span class="${kind}">${l || " "}</span>`;
  });
  return html`<pre class="diff">${lines}</pre>`;
}

function action(path: string, label: string, opts: { reason?: string; extra?: Html; then?: string; danger?: boolean } = {}): Html {
  return html`<form class="act" action="${path}" ${opts.then ? html`data-then="${opts.then}"` : ""}>
    ${opts.extra ?? ""}
    ${opts.reason !== undefined ? html`<input type="text" name="reason" placeholder="${opts.reason}" aria-label="${opts.reason}" />` : ""}
    <button type="submit" class="${opts.danger ? "danger" : ""}">${label}</button>
    <div class="refusal" role="alert"></div>
  </form>`;
}

const personName = (j: Judgment) => (j.actor && j.actor !== "you" ? j.actor : "You");

function outcome(j: Judgment): Html {
  if (j.state === "running") return pill("honing", "running");
  if (j.state === "failed") return pill("failed", "failed");
  if (j.by === "person") return j.version ? pill(`changed by hand → v${j.version}`, "changed") : pill("deleted", "failed");
  if (j.by === "starter") return pill("shipped with honed");
  return j.changed ? pill(`honed → v${j.version}`, "changed") : pill("unchanged");
}

function feedLine(j: Judgment): Html {
  return html`<div><a href="/judgments/${j.id}" class="mono">${j.skill}</a> ${outcome(j)} <span class="muted small">${ago(j.startedAt)}</span></div>`;
}

function feedbackCard(f: Feedback): Html {
  return html`<div class="card">
    <div class="quote">${f.text}</div>
    ${f.draft.length
      ? html`<details><summary class="small">with a draft: ${f.draft.map((d) => d.path).join(", ")}</summary>${f.draft.map((d) => html`<div class="by">${d.path}</div><pre>${d.content}</pre>`)}</details>`
      : ""}
    <div class="by">${f.author} · on ${f.version ? `v${f.version}` : "a new skill"} · ${ago(f.at)} ·
      ${f.judgment ? html`<a href="/judgments/${f.judgment}">considered</a>` : pill("waiting", "waiting")}</div>
  </div>`;
}

function skillCard(s: SkillSummary, cap: number, match?: string): Html {
  return html`<a class="skill" href="/skills/${s.name}">
    <div class="name">${s.name}</div>
    <div class="desc">${s.description}</div>
    ${match ? snippet(match) : ""}
    <div class="meta"><span>v${s.version}</span><span>${size(s.chars, cap)}</span><span>${s.feedback} feedback</span><span>${ago(s.updatedAt)}</span></div>
  </a>`;
}

/** Skills by prefix: your own groups first, then default/, then honed/'s, and unprefixed skills before all of them. */
function groups(skills: SkillSummary[]): [string, SkillSummary[]][] {
  const by = new Map<string, SkillSummary[]>();
  for (const s of skills) by.set(prefixOf(s.name), [...(by.get(prefixOf(s.name)) ?? []), s]);
  const rank = (p: string) => (p === "" ? 0 : p === "default" ? 2 : p === "honed" ? 3 : 1);
  return [...by.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

function connect(origin: string, viewer: Viewer, open: boolean, inline = false): Html {
  return html`<details class="${inline ? "" : "card"} connect" ${open ? "open" : ""}><summary>${inline ? "connect an agent" : "Connect an agent"}</summary>
    ${open && !inline ? html`<p class="small">honed is running, and no agent has connected yet. Any MCP client works; for Claude Code, one command, once:</p>` : html`<p class="small muted">Any MCP client works at <code>${origin}/mcp</code>. For Claude Code, one command, once:</p>`}
    <pre>claude mcp add --transport http --scope user honed ${origin}/mcp${viewer.local ? "" : ' --header "Authorization: Bearer <your token>"'}</pre>
    <p class="small muted">Or the plugin, which also asks each session for feedback on the skills it used:</p>
    <pre>claude plugin marketplace add dakotacolorado/honed
claude plugin install honed@honed --config url=${origin}</pre>
    ${viewer.local ? "" : html`<p class="small muted">Then <code>/plugin configure honed@honed</code> in a session to give it your token.</p>`}
  </details>`;
}

function home(hub: Hub, origin: string, viewer: Viewer, q: string, version: string): Html {
  const results = q.trim() ? hub.search(q, 50) : null;
  const skills = hub.list();
  const judgments = hub.store.recentJudgments(30).filter((j) => j.by !== "starter").slice(0, 12);
  const connected = hub.store.anyFeedback();
  return page(
    "honed",
    html`<div class="hero">
        <pre class="wordmark" aria-label="honed">${WORDMARK}</pre>
        <div class="edge" aria-hidden="true">✦</div>
        <p class="tagline">${TAGLINE}</p>
        <p class="muted">Agents get a skill before a task and submit feedback after. Each skill is revised from what they say, and every version is kept.</p>
      </div>
      ${connected ? "" : connect(origin, viewer, true)}
      <form class="search" method="get" action="/" role="search">
        <input type="search" name="q" value="${q}" placeholder="search skills…" aria-label="Search skills" />
        <button type="submit">Search</button>
      </form>
      <p class="small muted">Press <kbd>/</kbd> to search.</p>
      ${results
        ? html`<h2>${results.length} matching “${q}”</h2>
            ${results.length ? html`<div class="grid">${results.map((r) => skillCard(r, hub.maxChars, r.snippet))}</div>` : html`<div class="empty">No skill mentions that. <a href="/">See them all</a>.</div>`}`
        : html`<h2>skills${skills.length ? ` (${skills.length})` : ""}</h2>
            ${skills.length
              ? groups(skills).map(([prefix, list]) => html`${prefix ? html`<h3 class="group">${prefix}/</h3>` : ""}<div class="grid">${list.map((s) => skillCard(s, hub.maxChars))}</div>`)
              : html`<div class="empty">No skills yet.<br />Ask an agent to <code>submit_feedback</code> under a new name with a draft <code>SKILL.md</code>, and the first one will be honed into shape.</div>`}`}
      ${judgments.length ? html`<h2>recently honed</h2><div class="feed">${judgments.map(feedLine)}</div>` : ""}`,
    { refresh: !results && judgments.some((j) => j.state === "running"), viewer, version, footer: connected ? html` · ${connect(origin, viewer, false, true)}` : undefined },
  );
}

async function skillPage(hub: Hub, name: string, viewer: Viewer, version: string): Promise<HtmlEscapedString> {
  const skill = hub.skill(name);
  const summary = hub.list().find((s) => s.name === name)!;
  const files = await hub.files(name, skill.version);
  const versions = hub.store.versions(name);
  const diffs = await Promise.all(versions.map((v) => hub.library.diff(name, v.commit)));
  const feedback = hub.store.feedback(name, 50);
  const waiting = feedback.filter((f) => !f.judgment).length;
  const judging = hub.isJudging(name);
  const admin = viewer.caller.admin;
  return page(
    `${name} · honed`,
    html`<a class="back" href="/">← all skills</a>
      <h1 style="margin-top:14px">${name} ${pill(`v${skill.version}`)} ${judging ? pill("honing", "running") : ""}</h1>
      <p>${summary.description}</p>
      <div class="meta">${size(summary.chars, hub.maxChars)}<span>${summary.feedback} feedback on this version</span>${waiting ? pill(`${waiting} waiting`, "waiting") : ""}</div>
      ${name === JUDGE_SKILL
        ? html`<div class="note">This is how honed revises every skill, including this one. Feedback on it is welcome, and waits for an admin to choose <b>Revise now</b>; honed never revises its own judgment on its own. Its safety rules and the cap live in honed itself and can't be edited away.</div>`
        : ""}
      ${admin && !judging && waiting ? action(`/api/skills/${name}/judge`, "Revise now") : ""}

      <h2>files</h2>
      ${files.map(
        (f) => html`<details ${f.path === SKILL_FILE ? "open" : ""}><summary class="mono small">${f.path}${f.executable ? " (executable)" : ""}</summary><pre>${f.content}</pre>
          ${admin
            ? html`<details><summary class="small muted">edit ${f.path}</summary>${action(`/api/skills/${name}/edit`, "Save as a new version", {
                reason: "What you changed, and why",
                extra: html`<input type="hidden" name="path" value="${f.path}" /><textarea name="content" aria-label="${f.path}">${f.content}</textarea>`,
              })}${f.path === SKILL_FILE ? "" : action(`/api/skills/${name}/edit`, `Remove ${f.path}`, { reason: "Why", danger: true, extra: html`<input type="hidden" name="remove" value="${f.path}" />` })}</details>`
            : ""}
        </details>`,
      )}
      ${admin
        ? html`<details><summary class="small muted">add a file</summary>${action(`/api/skills/${name}/edit`, "Add it as a new version", {
            reason: "What it is for",
            extra: html`<input type="text" name="path" placeholder="scripts/check.sh" aria-label="Path" /><textarea name="content" aria-label="Content"></textarea>`,
          })}</details>`
        : ""}

      <h2>feedback</h2>
      ${feedback.length ? feedback.map(feedbackCard) : html`<div class="empty">No feedback yet. It arrives as agents use the skill.</div>`}

      <h2>history</h2>
      <div class="timeline">
        ${versions.map((v, i) => {
          const j = hub.store.judgment(v.judgment);
          const person = j?.by === "person";
          const how = person ? `${personName(j!)} ${v.note.startsWith("Revert") ? "reverted" : "edited"} it` : j?.by === "starter" ? "shipped with honed" : "honed";
          return html`<div class="event ${person ? "person" : ""}">
            <div><b class="mono">v${v.version}</b> ${v.note} <span class="muted small">· ${how} ${ago(v.at)} · <a href="/judgments/${v.judgment}">why</a></span></div>
            <details><summary class="small muted">what changed</summary>${diff(diffs[i] ?? "")}</details>
            ${admin && v.version < skill.version
              ? html`<details><summary class="small muted">revert to v${v.version}</summary>${action(`/api/skills/${name}/revert`, `Revert to v${v.version}`, { reason: "Why? (kept in the history)", extra: html`<input type="hidden" name="version" value="${v.version}" />` })}</details>`
              : ""}
          </div>`;
        })}
      </div>
      ${admin && name !== JUDGE_SKILL
        ? html`<h2>delete</h2><details><summary class="small muted">delete ${name}</summary>
            <p class="small muted">Takes it out of the library and search. Its history stays in git, and feedback under its name can bring it back.</p>
            ${action(`/api/skills/${name}/delete`, `Delete ${name}`, { reason: "Why (kept in the history)", danger: true, then: "/" })}</details>`
        : ""}`,
    { refresh: judging, viewer, version },
  );
}

async function judgmentPage(hub: Hub, id: string, viewer: Viewer, version: string): Promise<HtmlEscapedString> {
  const j = hub.judgment(id);
  const feedback = hub.store.feedbackOf(id);
  const made = j.version ? hub.store.version(j.skill, j.version) : undefined;
  const exists = hub.store.skill(j.skill) !== undefined;
  const heading =
    j.state === "running" ? `Honing ${j.skill}…` :
    j.state === "failed" ? `${j.skill} could not be revised` :
    j.by === "person" && !j.version ? `${personName(j)} deleted ${j.skill}` :
    j.by === "person" ? `${personName(j)} changed ${j.skill} → v${j.version}` :
    j.by === "starter" ? `${j.skill} shipped with honed` :
    j.changed ? `${j.skill} honed → v${j.version}` : `${j.skill} left unchanged`;
  return page(
    `${j.skill}${j.version ? ` v${j.version}` : ""} · honed`,
    html`<a class="back" href="${exists ? `/skills/${j.skill}` : "/"}">← ${exists ? j.skill : "all skills"}</a>
      <h1 style="margin-top:14px">${heading}</h1>
      <p class="muted small">${ago(j.startedAt)}</p>
      ${j.reasoning ? html`<h2>why</h2><div class="card prose">${j.reasoning}</div>` : ""}
      ${j.error ? html`<h2>what went wrong</h2><pre>${j.error}</pre><p class="small muted">The feedback is still waiting, and is revised again when more arrives.</p>` : ""}
      ${made ? html`<h2>what changed</h2>${diff(await hub.library.diff(j.skill, made.commit))}` : ""}
      ${feedback.length ? html`<h2>the feedback behind it</h2>${feedback.map(feedbackCard)}` : ""}`,
    { refresh: j.state === "running", viewer, version },
  );
}

function loginPage(error?: string): Html {
  return page(
    "Sign in · honed",
    html`<div class="hero">
        <pre class="wordmark" aria-label="honed">${WORDMARK}</pre>
        <div class="edge" aria-hidden="true">✦</div>
      </div>
      <h1>Sign in</h1>
      <p class="muted">This honed is shared. Paste the token you were given; <code>honed token create &lt;name&gt;</code> on the server makes one.</p>
      <form method="post" action="/login" class="search"><input type="password" name="token" placeholder="honed_…" aria-label="Token" autocomplete="current-password" /><button type="submit" class="primary">Sign in</button></form>
      ${error ? html`<p class="refusal" role="alert">${error}</p>` : ""}`,
  );
}

function notFound(message: string): Html {
  return page("Not found · honed", html`<h1>Nothing here</h1><p class="muted">${message}.</p><p><a class="back" href="/">← all skills</a></p>`);
}

const field = (body: Record<string, unknown>, key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");

export function app(hub: Hub, version: string, opts: AppOptions = {}): Hono<Env> {
  const web = new Hono<Env>();
  const shared = opts.shared ?? false;

  web.onError((e, c) => {
    if (e instanceof Refusal) {
      const status = e.status as 400;
      return c.req.path.startsWith("/api") || c.req.path === "/mcp" ? c.json({ error: e.message }, status) : c.html(notFound(e.message), status);
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
  writes.post(`/skills/:name${NAME_ROUTE}/revert`, async (c) => {
    const b = await body(c);
    return c.json(await hub.revert(c.req.param("name"), Number(field(b, "version") || b.version), field(b, "reason"), c.get("viewer").caller.name));
  });
  writes.post(`/skills/:name${NAME_ROUTE}/edit`, async (c) => {
    const b = await body(c);
    const remove = field(b, "remove");
    const change = remove ? { remove: [remove] } : { write: [{ path: field(b, "path").trim(), content: field(b, "content") }] };
    if (!remove && !change.write![0]!.path) throw new Refusal("a file needs a path");
    return c.json(await hub.edit(c.req.param("name"), change, field(b, "reason"), c.get("viewer").caller.name));
  });
  writes.post(`/skills/:name${NAME_ROUTE}/delete`, async (c) => c.json(await hub.delete(c.req.param("name"), field(await body(c), "reason"), c.get("viewer").caller.name)));
  writes.post(`/skills/:name${NAME_ROUTE}/judge`, (c) => (hub.judgeNow(c.req.param("name")), c.json({ revising: true })));
  web.route("/api", writes);

  web.get("/api/skills", (c) => {
    const q = c.req.query("q");
    return c.json(q ? hub.search(q, Number(c.req.query("limit") ?? 20)) : hub.list());
  });
  web.get(`/api/skills/:name${NAME_ROUTE}`, async (c) => {
    const name = c.req.param("name");
    return c.json({ ...hub.skill(name), files: await hub.current(name), versions: hub.store.versions(name), feedback: hub.store.feedback(name) });
  });
  web.get("/api/judgments/:id", (c) => c.json({ ...hub.judgment(c.req.param("id")), feedback: hub.store.feedbackOf(c.req.param("id")) }));

  web.get("/", (c) => c.html(home(hub, new URL(c.req.url).origin, c.get("viewer"), c.req.query("q") ?? "", version)));
  web.get(`/skills/:name${NAME_ROUTE}`, async (c) => c.html(await skillPage(hub, c.req.param("name"), c.get("viewer"), version)));
  web.get("/judgments/:id", async (c) => c.html(await judgmentPage(hub, c.req.param("id"), c.get("viewer"), version)));

  return web;
}
