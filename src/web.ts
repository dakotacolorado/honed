import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import type { Context, Handler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { COOKIE, deleteRoute, describeApi, editRoute, getJudgmentRoute, getSkillRoute, honoPath, judgeRoute, limitRoute, listSkillsRoute, previewRoute, revertRoute, WRITE_HEADER } from "./api.ts";
import { callerOf } from "./auth.ts";
import { DEFAULT_URL, LETTERS_ONLY, SUMMARY, SWORD_PIXELS, TAGLINE } from "./banner.ts";
import { baseName, HONER_SKILL, reportName, NAMESPACES_HEADER, parseNamespaces, Scope, LOCAL_CALLER, NAME_ROUTE, prefixOf, Refusal, SKILL_FILE, type Caller, type Feedback, type Judgment } from "./domain.ts";
import { parseDiff } from "./diffview.ts";
import { renderMarkdown, withoutFrontmatter } from "./markdown.ts";
import type { Hub, SkillSummary } from "./hub.ts";
import { mcpJson, mcpServer } from "./mcp.ts";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Only these may name a server with no tokens, so a page on another site cannot reach it by rebinding a hostname to 127.0.0.1. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export { WRITE_HEADER };

/** A file `npm run spec` writes and the package ships, read when first asked for: `npm run spec` builds an app before it has written them. */
function shipped(path: string): () => string {
  let content: string | undefined;
  return () => (content ??= readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

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
  --edge:#0b7a75; --edge-soft:#dcf1ef; --sage:#0b7a75; --sage-soft:#dcf1ef; --rust:#b42e3a; --rust-soft:#fbe3e5; --amber:#8a5a00; --amber-soft:#fbf0d9;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1417; --fg:#e3eaee; --muted:#8a99a3; --line:#253038; --card:#151c20; --sunk:#0b1013;
    --edge:#4fd1c5; --edge-soft:#123331; --sage:#4fd1c5; --sage-soft:#123331; --rust:#f39aa2; --rust-soft:#3a1a1f; --amber:#e8c37a; --amber-soft:#33280f; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:920px; margin:0 auto; padding:20px 16px 72px; }
a { color:var(--edge); text-decoration:none; } a:hover { text-decoration:underline; }
:focus-visible { outline:2px solid var(--edge); outline-offset:2px; border-radius:4px; }
.mono, code, pre, h1, h2, .name, .pill, button, .brand, .tabs a, .tag { font-family:var(--mono); }
a.wordmark { display:flex; align-items:flex-end; gap:1.4em; width:fit-content; color:var(--edge); line-height:1; margin:8px 0 14px; font-size:clamp(7px, 2.2vw, 13px); }
a.wordmark:hover { text-decoration:none; opacity:.85; }
a.wordmark pre { margin:0; padding:0; background:none; border:0; overflow:visible; white-space:pre; font-size:1em; line-height:1; }
a.wordmark svg { height:6em; width:auto; flex:none; }
a.wordmark.small { margin:0 0 18px; font-size:clamp(4px, 1vw, 6px); }
h1 { font-size:22px; margin:0 0 6px; letter-spacing:-.01em; }
h2 { font-size:14px; margin:36px 0 10px; color:var(--muted); font-weight:600; text-transform:lowercase; }
.muted { color:var(--muted); } .small { font-size:13px; }
.hero { margin:8px 0 24px; }
.tagline { font-size:18px; font-weight:600; margin:0 0 4px; }
pre { background:var(--sunk); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow-x:auto; font-size:12.5px; line-height:1.5; margin:8px 0; white-space:pre-wrap; overflow-wrap:anywhere; }
pre.cmd { white-space:pre; overflow-wrap:normal; }
details { margin:8px 0; } summary { cursor:pointer; } summary:hover { color:var(--edge); }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:10px 0; }
.connect summary { font-weight:600; }
.connect p { margin:10px 0 4px; }
.chips { display:flex; gap:8px; flex-wrap:wrap; margin:16px 0 4px; }
.chips a { font-family:var(--mono); font-size:13px; padding:4px 12px; border-radius:999px; border:1px solid var(--line); color:var(--muted); background:var(--card); }
.chips a:hover { text-decoration:none; border-color:var(--edge); color:var(--edge); }
.chips a[aria-current] { background:var(--edge); border-color:var(--edge); color:var(--bg); }
.chips a[aria-current] .muted { color:inherit; opacity:.75; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px; margin-top:12px; }
a.skill { display:block; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; transition:border-color .15s, transform .15s; }
a.skill:hover { text-decoration:none; border-color:var(--edge); transform:translateY(-1px); }
.tag { font-size:11.5px; color:var(--muted); }
.name { font-weight:700; color:var(--fg); }
.desc { margin:4px 0 10px; font-size:14px; }
.meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:12.5px; color:var(--muted); }
.snippet { font-size:13px; color:var(--muted); margin:-4px 0 10px; }
.snippet mark { background:var(--edge-soft); color:var(--fg); border-radius:3px; padding:0 2px; }
.pill { display:inline-block; font-size:11.5px; padding:1px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
.pill.changed { color:var(--sage); background:var(--sage-soft); border-color:transparent; }
.pill.failed { color:var(--rust); background:var(--rust-soft); border-color:transparent; }
.pill.waiting, .pill.warn { color:var(--amber); background:var(--amber-soft); border-color:transparent; }
.pill.running { color:var(--edge); border-color:var(--edge); }
.pill.running::before { content:"🗡 "; display:inline-block; animation:pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity:.25; } }
@media (prefers-reduced-motion: reduce) { .pill.running::before { animation:none; } a.skill { transition:none; } a.skill:hover { transform:none; } }
form.search { display:flex; gap:8px; margin:20px 0 6px; }
input[type=search], input[type=text], input[type=password] { font:inherit; padding:9px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); flex:1; min-width:0; }
input::placeholder { color:var(--muted); font-family:var(--mono); font-size:13.5px; }
kbd { font-family:var(--mono); font-size:11px; border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 5px; color:var(--muted); }
button, a.button { font-family:var(--mono); font-size:13px; padding:7px 14px; border-radius:8px; border:1px solid var(--edge); background:transparent; color:var(--edge); cursor:pointer; display:inline-block; }
button:hover, a.button:hover { background:var(--edge-soft); text-decoration:none; }
button.primary { background:var(--edge); color:var(--bg); } button.primary:hover { filter:brightness(1.08); }
button.danger { color:var(--rust); border-color:var(--rust); } button.danger:hover { background:var(--rust-soft); }
button.quiet, a.button.quiet { border-color:var(--line); color:var(--muted); }
button[hidden] { display:none; }
form.act { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:10px 0 0; }
form.act label { width:100%; font-size:13px; color:var(--muted); display:flex; flex-direction:column; gap:4px; }
form.act textarea { width:100%; min-height:320px; font:12.5px/1.5 var(--mono); padding:10px 12px; border:1px solid var(--edge); border-radius:8px; background:var(--card); color:var(--fg); }
.refusal { color:var(--rust); font-size:13px; width:100%; }
.refusal:empty { display:none; }
.tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin:24px 0 16px; }
.tabs a { padding:8px 14px; font-size:13px; color:var(--muted); border-bottom:2px solid transparent; margin-bottom:-1px; }
.tabs a:hover { text-decoration:none; color:var(--fg); }
.tabs a[aria-current] { color:var(--fg); border-bottom-color:var(--edge); font-weight:600; }
.file { background:var(--card); border:1px solid var(--line); border-radius:10px; margin:12px 0; overflow:hidden; }
.file > header { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--line); background:var(--sunk); font-family:var(--mono); font-size:13px; }
.file > header .grow { flex:1; }
.file > .body { padding:4px 18px 12px; }
.file > .body pre { margin:8px 0; }
.file.editing { border-color:var(--edge); }
.md h3 { font-size:18px; margin:18px 0 8px; } .md h4 { font-size:15px; margin:16px 0 6px; } .md h5, .md h6 { font-size:14px; margin:14px 0 4px; }
.md p, .md ul, .md ol { margin:6px 0; } .md li { margin:3px 0; } .md .sub { display:block; margin-left:16px; }
.md code { background:var(--sunk); border-radius:4px; padding:1px 4px; font-size:13px; }
.md blockquote { border-left:3px solid var(--line); margin:8px 0; padding-left:12px; color:var(--muted); }
.diff { margin:8px 0; }
.diff .path { font-family:var(--mono); font-size:12.5px; color:var(--muted); margin:10px 0 4px; }
.diff pre span { display:block; } .d-add { background:var(--sage-soft); color:var(--sage); } .d-del { background:var(--rust-soft); color:var(--rust); text-decoration:line-through; text-decoration-color:color-mix(in srgb, var(--rust) 40%, transparent); } .d-gap { color:var(--muted); }
.quote { border-left:3px solid var(--edge); padding:2px 0 2px 12px; margin:0 0 8px; white-space:pre-wrap; }
.by { font-family:var(--mono); font-size:12px; color:var(--muted); }
.timeline { position:relative; margin-left:8px; padding-left:22px; border-left:1px dashed var(--line); }
.event { position:relative; margin:0 0 18px; }
.event::before { content:"🗡"; position:absolute; left:-31px; top:0; background:var(--bg); font-size:14px; line-height:1.4; }
.event.person::before { content:"↺"; color:var(--muted); left:-28px; }
.event.starter::before { content:"◆"; color:var(--muted); left:-28px; font-size:12px; }
.feed div { margin:6px 0; }
.prose { white-space:pre-wrap; }
.empty { border:1px dashed var(--line); border-radius:10px; padding:22px; text-align:center; color:var(--muted); }
.back { font-family:var(--mono); font-size:13px; }
.bar-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:space-between; }
footer { margin-top:56px; padding-top:14px; border-top:1px dashed var(--line); font-family:var(--mono); font-size:12px; color:var(--muted); }
footer details { display:inline; margin:0; }
footer details[open] { display:block; margin-top:8px; font-family:initial; }
footer summary { font-family:var(--mono); display:inline; color:var(--edge); list-style:none; }
footer summary::-webkit-details-marker { display:none; }
.note { border-left:3px solid var(--edge); background:var(--edge-soft); border-radius:6px; padding:10px 14px; margin:14px 0; font-size:14px; }
`;

/**
 * Sends a form as JSON with the write header and shows a refusal beside it in the server's words. An edit form shows
 * its change first: Preview asks the server for the diff, and Save appears only once the diff shown is the one saved.
 * "/" focuses search.
 */
const SCRIPT = `
const send = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "${WRITE_HEADER}": "1" }, body: JSON.stringify(body) });
document.addEventListener("submit", async (ev) => {
  const form = ev.target.closest("form.act"); if (!form) return;
  ev.preventDefault();
  const out = form.querySelector(".refusal"); if (out) out.textContent = "";
  const button = ev.submitter || form.querySelector("button[type=submit]"); if (button) button.disabled = true;
  const res = await send(form.getAttribute("action"), Object.fromEntries(new FormData(form)));
  if (res.ok) { location.assign(form.dataset.then || location.href); return; }
  if (button) button.disabled = false;
  const err = await res.json().catch(() => ({ error: res.statusText }));
  if (out) out.textContent = err.error;
});
document.addEventListener("click", async (ev) => {
  const preview = ev.target.closest("button[data-preview]"); if (!preview) return;
  const form = preview.closest("form"); const out = form.querySelector(".refusal"); const shown = form.querySelector(".preview");
  out.textContent = ""; preview.disabled = true;
  const res = await send(preview.dataset.preview, Object.fromEntries(new FormData(form)));
  preview.disabled = false;
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) { out.textContent = body.error; return; }
  shown.innerHTML = body.html;
  form.querySelector("button[type=submit]").hidden = false;
});
document.addEventListener("input", (ev) => {
  const form = ev.target.closest("form.act.edit"); if (!form) return;
  form.querySelector(".preview").innerHTML = "";
  form.querySelector("button[type=submit]").hidden = true;
});
document.addEventListener("keydown", (ev) => {
  const q = document.querySelector("input[type=search]");
  if (ev.key === "/" && q && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") { ev.preventDefault(); q.focus(); }
});
`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="16" y="26" font-size="26" text-anchor="middle">🗡️</text></svg>')}`;

function page(title: string, body: Html, opts: { refresh?: boolean; viewer?: Viewer; version?: string; footer?: Html; home?: boolean } = {}): Html {
  const who = opts.viewer && !opts.viewer.local ? html` · ${opts.viewer.caller.name}${opts.viewer.caller.admin ? " (admin)" : ""} · <a href="/logout">sign out</a>` : "";
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
      <a class="wordmark ${opts.home ? "" : "small"}" href="/" aria-label="honed, all skills"><pre aria-hidden="true">${LETTERS_ONLY}</pre>${SWORD_SVG}</a>
      ${body}
      <footer>🗡 honed${opts.version ? ` v${opts.version}` : ""}${who}${opts.footer ?? ""}</footer>
    </main>
    <script>${raw(SCRIPT)}</script>
  </body>
</html>`;
}

/** The sword beside the wordmark, drawn from its pixel grid: square pixels, crisp edges, in the page's accent color. */
const SWORD_SVG = raw(
  `<svg aria-hidden="true" viewBox="0 0 ${SWORD_PIXELS[0]!.length} ${SWORD_PIXELS.length}" shape-rendering="crispEdges" fill="currentColor">${SWORD_PIXELS.flatMap((row, y) =>
    [...row].flatMap((p, x) => (p === "#" ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : [])),
  ).join("")}</svg>`,
);

/** "3h ago", with the exact time on hover. */
function ago(iso: string | null): Html {
  if (!iso) return html``;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const text = s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : s < 86400 * 30 ? `${Math.floor(s / 86400)}d ago` : iso.slice(0, 10);
  return html`<time datetime="${iso}" title="${iso.replace("T", " ").slice(0, 19)} UTC">${text}</time>`;
}

const pill = (text: string, kind = "") => html`<span class="pill ${kind}">${text}</span>`;

/** Only said when it matters: a skill past 80% of its cap. */
function capWarning(chars: number, cap: number): Html {
  return chars > cap * 0.8 ? html`<span class="pill warn" title="${chars} of ${cap} characters">near its size cap</span>` : html``;
}

/** Search snippets mark matches with «»; the page shows them highlighted, everything else escaped. */
function snippet(text: string): Html {
  const parts = text.split(/«|»/);
  return html`<div class="snippet">${parts.map((p, i) => (i % 2 ? html`<mark>${p}</mark>` : p))}</div>`;
}

/** A diff as people read it: per file, created files shown whole, and none of git's bookkeeping. */
function diffView(text: string, prefix = ""): Html {
  const files = parseDiff(text, prefix);
  if (files.length === 0) return html`<p class="muted small">No difference.</p>`;
  return html`<div class="diff">${files.map((f) => {
    if (f.status === "created") {
      const content = f.lines.map((l) => l.text).join("\n");
      return html`<div class="path">created ${f.path}</div>${f.path.endsWith(".md") ? html`<div class="file"><div class="body md">${raw(renderMarkdown(withoutFrontmatter(content)))}</div></div>` : html`<pre>${content}</pre>`}`;
    }
    if (f.status === "removed") return html`<div class="path">removed ${f.path}</div>`;
    return html`<div class="path">${f.path}</div><pre>${f.lines.map((l) => html`<span class="d-${l.kind}">${l.text || " "}</span>`)}</pre>`;
  })}</div>`;
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
  return html`<div class="card" id="report-${f.id.slice(0, 8)}">
    ${f.quote !== null
      ? html`<div class="small muted">says</div><div class="quote">${f.quote}</div>
          ${f.evidence.map((e) => html`<div class="by">${"path" in e ? e.path : html`$ ${e.command}`}</div><pre>${"path" in e ? e.content : e.output}</pre>`)}
          <div class="small muted">instead</div><div>${f.whatChanged}</div>`
      : ""}
    ${f.text ? html`<div class="${f.quote !== null ? "" : "quote"}">${f.text}</div>` : ""}
    ${f.draft.length
      ? html`<details><summary class="small">with a draft: ${f.draft.map((d) => d.path).join(", ")}</summary>${f.draft.map((d) => html`<div class="by">${d.path}</div><pre>${d.content}</pre>`)}</details>`
      : ""}
    <div class="by">${reportName(f)} · on ${f.version ? `v${f.version}` : "a new skill"} · ${ago(f.at)} ·
      ${f.judgment ? html`<a href="/judgments/${f.judgment}">considered</a>` : pill("waiting", "waiting")}</div>
  </div>`;
}

/** A search snippet worth showing: one that matched more than the description already on the card. */
const addsToDescription = (snip: string, description: string) => !description.toLowerCase().includes(snip.replace(/[«»…]/g, "").trim().toLowerCase());

function skillCard(s: SkillSummary, match?: string): Html {
  const prefix = prefixOf(s.name);
  return html`<a class="skill" href="/skills/${s.name}">
    ${prefix ? html`<div class="tag">${prefix}/</div>` : ""}
    <div class="name">${baseName(s.name)}</div>
    <div class="desc">${s.description}</div>
    ${match && addsToDescription(match, s.description) ? snippet(match) : ""}
    <div class="meta"><span>v${s.version}</span>${s.waiting ? pill(`${s.waiting} waiting`, "waiting") : ""}${capWarning(s.chars, s.limit)}<span>${ago(s.updatedAt)}</span></div>
  </a>`;
}

/** Ungrouped skills first, then your groups, and honed/'s own last. */
const groupRank = (p: string) => (p === "" ? 0 : p === "honed" ? 2 : 1);
const byGroup = (a: SkillSummary, b: SkillSummary) =>
  groupRank(prefixOf(a.name)) - groupRank(prefixOf(b.name)) || prefixOf(a.name).localeCompare(prefixOf(b.name)) || a.name.localeCompare(b.name);

function chips(skills: SkillSummary[], current: string): Html {
  const prefixes = [...new Set(skills.map((s) => prefixOf(s.name)))].sort((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b));
  if (prefixes.length < 2) return html``;
  const chip = (label: string, group: string, count: number) =>
    html`<a href="${group ? `/?group=${encodeURIComponent(group)}` : "/"}" ${current === group ? html`aria-current="true"` : ""}>${label} <span class="muted">${count}</span></a>`;
  return html`<nav class="chips" aria-label="Filter by group">${chip("all", "", skills.length)}${prefixes.map((p) =>
    chip(p ? `${p}/` : "ungrouped", p || "-", skills.filter((s) => prefixOf(s.name) === p).length),
  )}</nav>`;
}

function connect(origin: string, viewer: Viewer, open: boolean, inline = false): Html {
  return html`<details class="${inline ? "" : "card"} connect" ${open ? "open" : ""}><summary>${inline ? "connect Claude Code" : "Connect Claude Code"}</summary>
    <p class="small ${open && !inline ? "" : "muted"}">${open && !inline ? "honed is running, and no agent has connected yet. " : ""}Commit this <code>.mcp.json</code> at a repo's root, with the namespaces it uses in <code>X-Honed-Namespaces</code>: its own, plus any shared ones. Every Claude Code session in the repo then sees those skills, and nothing else needs installing.</p>
    <pre class="cmd">${mcpJson(origin, ["your-project", "shared"])}</pre>
    <p class="small muted">${viewer.local ? "Then set HONED_TOKEN in your environment to any value: this honed has no tokens." : html`Then set <code>HONED_TOKEN</code> in your environment to your token, so none is committed.`}</p>
  </details>`;
}

function home(hub: Hub, origin: string, viewer: Viewer, q: string, group: string, version: string): Html {
  const results = q.trim() ? hub.search(q, 50) : null;
  const skills = hub.list().sort(byGroup);
  const shown = group ? skills.filter((s) => prefixOf(s.name) === (group === "-" ? "" : group)) : skills;
  const judgments = hub.store.recentJudgments(30).filter((j) => j.by !== "starter").slice(0, 12);
  const connected = hub.store.anyFeedback();
  return page(
    "honed",
    html`<div class="hero">
        <p class="tagline">${TAGLINE}</p>
        <p class="muted">${SUMMARY}</p>
      </div>
      ${connected ? "" : connect(origin, viewer, true)}
      <form class="search" method="get" action="/" role="search">
        <input type="search" name="q" value="${q}" placeholder="search skills…  ( / )" aria-label="Search skills" />
        <button type="submit">Search</button>
      </form>
      ${results
        ? html`<h2>${results.length} matching “${q}” · <a href="/">clear</a></h2>
            ${results.length ? html`<div class="grid">${results.map((r) => skillCard(r, r.snippet))}</div>` : html`<div class="empty">No skill mentions that. <a href="/">See them all</a>.</div>`}`
        : skills.length
          ? html`${chips(skills, group)}<div class="grid">${shown.map((s) => skillCard(s))}</div>`
          : html`<div class="empty">No skills yet.<br />Ask an agent to <code>submit_feedback</code> under a new name with a draft <code>SKILL.md</code>, and the first one will be honed into shape.</div>`}
      ${judgments.length ? html`<h2>recently honed</h2><div class="feed">${judgments.map(feedLine)}</div>` : ""}`,
    { refresh: !results && judgments.some((j) => j.state === "running"), viewer, version, home: true, footer: connected ? html` · ${connect(origin, viewer, false, true)}` : undefined },
  );
}

type Tab = "skill" | "feedback" | "history";

interface SkillView {
  tab?: string;
  edit?: string;
  add?: boolean;
  raw?: boolean;
}

/** An editor in place of a file's view: Preview shows the change as a diff, and only then can it be saved. */
function editor(name: string, opts: { path?: string; content: string; removable: boolean }): Html {
  const cancel = `/skills/${name}`;
  return html`<form class="act edit" action="/api/skills/${name}/edit" data-then="${cancel}">
    ${opts.path === undefined
      ? html`<label>Path in the skill<input type="text" name="path" placeholder="scripts/check.sh" required /></label>`
      : html`<input type="hidden" name="path" value="${opts.path}" />`}
    <label>Content<textarea name="content" spellcheck="false">${opts.content}</textarea></label>
    <label>What you changed, and why (kept in the history)<input type="text" name="reason" /></label>
    <div class="preview" aria-live="polite"></div>
    <button type="button" data-preview="/api/skills/${name}/preview">Preview change</button>
    <button type="submit" class="primary" hidden>Save as v-next</button>
    <a class="button quiet" href="${cancel}">Cancel</a>
    <div class="refusal" role="alert"></div>
  </form>
  ${opts.removable && opts.path ? html`<details><summary class="small muted">remove ${opts.path} instead</summary>${action(`/api/skills/${name}/edit`, `Remove ${opts.path}`, { reason: "Why (kept in the history)", danger: true, then: cancel, extra: html`<input type="hidden" name="remove" value="${opts.path}" />` })}</details>` : ""}`;
}

async function skillPage(hub: Hub, name: string, viewer: Viewer, version: string, view: SkillView): Promise<HtmlEscapedString> {
  const skill = hub.skill(name);
  const summary = hub.list().find((s) => s.name === name)!;
  const files = await hub.files(name, skill.version);
  const versions = hub.store.versions(name);
  const feedback = hub.store.feedback(name, 50);
  const judging = hub.isJudging(name);
  const admin = viewer.caller.admin;
  const editing = admin ? view.edit : undefined;
  const adding = admin && view.add && !editing;
  const tab: Tab = view.tab === "feedback" || view.tab === "history" || view.tab === "skill" ? view.tab : name === HONER_SKILL && admin && summary.waiting ? "feedback" : "skill";
  const tabLink = (t: Tab, label: Html) => html`<a href="/skills/${name}${t === "skill" ? "" : `?tab=${t}`}" ${tab === t ? html`aria-current="page"` : ""}>${label}</a>`;
  const prefix = prefixOf(name);

  const skillTab = async () => html`
    ${files.map((f) => {
      const md = f.path.endsWith(".md") && !view.raw;
      const content = f.path === SKILL_FILE ? withoutFrontmatter(f.content) : f.content;
      if (editing === f.path) {
        return html`<section class="file editing"><header><span class="grow">editing ${f.path}</span></header><div class="body">${editor(name, { path: f.path, content: f.content, removable: f.path !== SKILL_FILE })}</div></section>`;
      }
      return html`<section class="file">
        <header><span class="grow">${f.path}${f.executable ? " · executable" : ""}</span>
          ${f.path.endsWith(".md") ? html`<a class="small" href="/skills/${name}${view.raw ? "" : "?raw=1"}">${view.raw ? "rendered" : "raw"}</a>` : ""}
          ${admin && !editing ? html`<a class="button quiet" href="/skills/${name}?edit=${encodeURIComponent(f.path)}">Edit</a>` : ""}
        </header>
        <div class="body ${md ? "md" : ""}">${md ? raw(renderMarkdown(content)) : html`<pre>${f.content}</pre>`}</div>
      </section>`;
    })}
    ${adding
      ? html`<section class="file editing"><header><span class="grow">new file</span></header><div class="body">${editor(name, { content: "", removable: false })}</div></section>`
      : admin && !editing
        ? html`<a class="button quiet" href="/skills/${name}?add=1">+ Add a file</a>`
        : ""}
    ${admin && name !== HONER_SKILL && !editing && !adding
      ? html`<details style="margin-top:32px"><summary class="small muted">delete this skill</summary>
          <p class="small muted">Takes it out of the library and search. Its history stays in git, and feedback under its name can bring it back.</p>
          ${action(`/api/skills/${name}/delete`, `Delete ${name}`, { reason: "Why (kept in the history)", danger: true, then: "/" })}</details>`
      : ""}`;

  const feedbackTab = () => html`
    ${summary.waiting
      ? html`<div class="bar-row card"><span>${pill(`${summary.waiting} waiting`, "waiting")} <span class="small muted">${name === HONER_SKILL ? "revised only when an admin asks" : "revised when enough arrives, or now"}</span></span>
          ${admin && !judging ? action(`/api/skills/${name}/judge`, "Revise now") : judging ? pill("honing", "running") : ""}</div>`
      : ""}
    ${feedback.length ? feedback.map(feedbackCard) : html`<div class="empty">No feedback yet. It arrives as agents use the skill.</div>`}`;

  const historyTab = async () => {
    const diffs = await Promise.all(versions.map((v) => hub.library.diff(name, v.commit)));
    return html`<div class="timeline">
      ${versions.map((v, i) => {
        const j = hub.store.judgment(v.judgment);
        const kind = j?.by === "person" ? "person" : j?.by === "starter" ? "starter" : "";
        const reverted = v.note.startsWith("Revert");
        const how = j?.by === "person" ? `${personName(j)} ${reverted ? "reverted" : "edited"} it` : j?.by === "starter" ? "shipped with honed" : reverted ? "reverted by the honer" : "honed";
        const reports = hub.store.feedbackOf(v.judgment);
        return html`<div class="event ${kind}">
          <div><b class="mono">v${v.version}</b> ${v.note} <span class="muted small">· ${how} ${ago(v.at)} · <a href="/judgments/${v.judgment}">why</a></span></div>
          ${reports.length ? html`<div class="by">from ${reports.map((f, k) => html`${k ? ", " : ""}${reportName(f)}${f.quote !== null ? html` on “${f.quote.length > 80 ? `${f.quote.slice(0, 80)}…` : f.quote}”` : ""}`)}</div>` : ""}
          <details><summary class="small muted">what changed</summary>${diffView(diffs[i] ?? "", name)}</details>
          ${admin && v.version < skill.version
            ? html`<details><summary class="small muted">revert to v${v.version}</summary>${action(`/api/skills/${name}/revert`, `Revert to v${v.version}`, { reason: "Why? (kept in the history)", extra: html`<input type="hidden" name="version" value="${v.version}" />` })}</details>`
            : ""}
        </div>`;
      })}
    </div>`;
  };

  return page(
    `${name} · honed`,
    html`<a class="back" href="/">← all skills</a>
      ${prefix ? html`<div class="tag" style="margin-top:14px">${prefix}/</div>` : ""}
      <h1 style="${prefix ? "" : "margin-top:14px"}">${baseName(name)} ${pill(`v${skill.version}`)} ${judging ? pill("honing", "running") : ""} ${capWarning(summary.chars, summary.limit)}</h1>
      <p>${summary.description}</p>
      <div class="meta"><span>updated ${ago(summary.updatedAt)}</span><span title="${skill.maxChars === null ? "the library's default limit" : "this skill's own limit"}">${summary.chars} of ${summary.limit} characters</span></div>
      ${admin && !editing && !adding
        ? html`<details><summary class="small muted">set its size limit</summary>
            <p class="small muted">The most text this skill may hold, all its files together, for the honer's revisions and people's edits alike. Leave it empty for the library's default (${hub.maxChars}). Text already over a lowered limit may only shrink.</p>
            ${action(`/api/skills/${name}/limit`, "Set limit", { extra: html`<input type="number" name="maxChars" min="1" value="${skill.maxChars ?? ""}" placeholder="${hub.maxChars}" aria-label="Limit in characters" />` })}</details>`
        : ""}
      ${name === HONER_SKILL
        ? html`<div class="note">This is the honer's own guidance: how honed revises every skill. Agents and the honer itself leave feedback on it as they work; it changes only when an admin chooses <b>Revise now</b>, and the honer never reviews its own review. Its safety rules and the cap live in honed itself and can't be edited away.</div>`
        : ""}
      <nav class="tabs" aria-label="Skill sections">
        ${tabLink("skill", html`skill`)}
        ${tabLink("feedback", html`feedback ${summary.waiting ? pill(String(summary.waiting), "waiting") : html`<span class="muted">${feedback.length}</span>`}`)}
        ${tabLink("history", html`history <span class="muted">${versions.length}</span>`)}
      </nav>
      ${tab === "skill" ? await skillTab() : tab === "feedback" ? feedbackTab() : await historyTab()}`,
    { refresh: judging && !editing && !adding, viewer, version },
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
    html`<a class="back" href="${exists ? `/skills/${j.skill}?tab=history` : "/"}">← ${exists ? j.skill : "all skills"}</a>
      <h1 style="margin-top:14px">${heading}</h1>
      <p class="muted small">${ago(j.startedAt)}</p>
      ${j.reasoning ? html`<h2>why</h2><div class="card prose">${j.reasoning}</div>` : ""}
      ${j.error ? html`<h2>what went wrong</h2><pre>${j.error}</pre><p class="small muted">The feedback is still waiting, and is revised again when more arrives.</p>` : ""}
      ${made ? html`<h2>what changed</h2>${diffView(await hub.library.diff(j.skill, made.commit), j.skill)}` : ""}
      ${feedback.length ? html`<h2>the feedback behind it</h2>${feedback.map(feedbackCard)}` : ""}`,
    { refresh: j.state === "running", viewer, version },
  );
}

function loginPage(error?: string): Html {
  return page(
    "Sign in · honed",
    html`<h1>Sign in</h1>
      <p class="muted">This honed is shared. Paste the token you were given; <code>honed token create &lt;name&gt;</code> on the server makes one.</p>
      <form method="post" action="/login" class="search"><input type="password" name="token" placeholder="honed_…" aria-label="Token" autocomplete="current-password" /><button type="submit" class="primary">Sign in</button></form>
      ${error ? html`<p class="refusal" role="alert">${error}</p>` : ""}`,
    { home: true },
  );
}

function notFound(message: string): Html {
  return page("Not found · honed", html`<h1>Nothing here</h1><p class="muted">${message}.</p><p><a class="back" href="/">← all skills</a></p>`);
}

/** Where the caller reached this honed, as `https://host` behind a proxy that says it took HTTPS. */
const originOf = (c: Context) => {
  const url = new URL(c.req.url);
  return c.req.header("x-forwarded-proto") === "https" ? `https://${url.host}` : url.origin;
};

const field = (body: Record<string, unknown>, key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");

export function app(hub: Hub, version: string, opts: AppOptions = {}): OpenAPIHono<Env> {
  const web = new OpenAPIHono<Env>();
  /** Answers at a route declared in `api.ts`, and puts it in the contract; the handler reads the request as it always has. */
  const declare = (route: RouteConfig, handler: Handler<Env>) => {
    web.openAPIRegistry.registerPath(route);
    web.on(route.method.toUpperCase(), honoPath(route.path), handler);
  };
  const shared = opts.shared ?? false;

  web.onError((e, c) => {
    if (e instanceof Refusal) {
      const status = e.status as 400;
      return c.req.path.startsWith("/api") || c.req.path === "/mcp" ? c.json({ error: e.message }, status) : c.html(notFound(e.message), status);
    }
    console.error(e);
    return c.json({ error: "something went wrong in the server; its log says what" }, 500);
  });

  // The contract and docs need no token and hold no data, so they are served before the auth that would ask for one.
  describeApi(web, version);
  const apiDocs = shipped("docs/index.html");
  web.get("/docs/api", (c) => c.html(apiDocs()));
  const mcpContract = shipped("mcp.json");
  web.get("/mcp.json", (c) => c.body(mcpContract(), 200, { "content-type": "application/json; charset=utf-8" }));
  // The page's example address is the default local one; served, it gives this deployment's own.
  const mcpDocs = shipped("docs/mcp.html");
  web.get("/docs/mcp", (c) => c.html(mcpDocs().replaceAll(DEFAULT_URL, originOf(c))));

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
    const scope = new Scope(parseNamespaces(c.req.header(NAMESPACES_HEADER)));
    await mcpServer(hub, version, caller, local, scope, new URL(c.req.url).origin).connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  declare(listSkillsRoute, (c) => {
    const q = c.req.query("q");
    return c.json(q ? hub.search(q, Number(c.req.query("limit") ?? 20)) : hub.list());
  });
  declare(getSkillRoute, async (c) => {
    const name = c.req.param("name")!;
    return c.json({ ...hub.skill(name), files: await hub.current(name), versions: hub.store.versions(name), feedback: hub.store.feedback(name) });
  });
  declare(getJudgmentRoute, (c) => c.json({ ...hub.judgment(c.req.param("id")!), feedback: hub.store.feedbackOf(c.req.param("id")!) }));

  web.use("/api/*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    if (c.req.header(WRITE_HEADER) !== "1") return c.json({ error: `a write must carry the ${WRITE_HEADER} header` }, 403);
    if (!c.get("viewer").caller.admin) return c.json({ error: "this takes an admin token" }, 403);
    return next();
  });
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  declare(revertRoute, async (c) => {
    const b = await body(c);
    return c.json(await hub.revert(c.req.param("name")!, Number(field(b, "version") || b.version), field(b, "reason"), c.get("viewer").caller.name));
  });
  declare(editRoute, async (c) => {
    const b = await body(c);
    const remove = field(b, "remove");
    const change = remove ? { remove: [remove] } : { write: [{ path: field(b, "path").trim(), content: field(b, "content") }] };
    if (!remove && !change.write![0]!.path) throw new Refusal("a file needs a path");
    return c.json(await hub.edit(c.req.param("name")!, change, field(b, "reason"), c.get("viewer").caller.name));
  });
  declare(previewRoute, async (c) => {
    const b = await body(c);
    const remove = field(b, "remove");
    const change = remove ? { remove: [remove] } : { write: [{ path: field(b, "path").trim(), content: field(b, "content") }] };
    if (!remove && !change.write![0]!.path) throw new Refusal("a file needs a path");
    const shown = await diffView(await hub.preview(c.req.param("name")!, change));
    return c.json({ html: String(shown) });
  });
  declare(limitRoute, async (c) => {
    const b = await body(c);
    const raw = typeof b.maxChars === "number" ? String(b.maxChars) : field(b, "maxChars").trim();
    return c.json(hub.setLimit(c.req.param("name")!, raw === "" ? null : Number(raw)));
  });
  declare(deleteRoute, async (c) => c.json(await hub.delete(c.req.param("name")!, field(await body(c), "reason"), c.get("viewer").caller.name)));
  declare(judgeRoute, (c) => (hub.judgeNow(c.req.param("name")!), c.json({ revising: true })));

  web.get("/", (c) => c.html(home(hub, new URL(c.req.url).origin, c.get("viewer"), c.req.query("q") ?? "", c.req.query("group") ?? "", version)));
  web.get(`/skills/:name${NAME_ROUTE}`, async (c) =>
    c.html(await skillPage(hub, c.req.param("name"), c.get("viewer"), version, { tab: c.req.query("tab"), edit: c.req.query("edit"), add: c.req.query("add") === "1", raw: c.req.query("raw") === "1" })),
  );
  web.get("/judgments/:id", async (c) => c.html(await judgmentPage(hub, c.req.param("id"), c.get("viewer"), version)));

  return web;
}
