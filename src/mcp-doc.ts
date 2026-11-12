import { DEFAULT_URL } from "./banner.ts";
import { NAMESPACES_HEADER } from "./domain.ts";
import { mcpJson } from "./mcp.ts";
import { withApp } from "./spec.ts";

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  anyOf?: JsonSchema[];
  maximum?: number;
  exclusiveMinimum?: number;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpDocument {
  instructions: string;
  tools: McpTool[];
}

/**
 * The MCP server as a client meets it: initialize, then `tools/list`, through the app, so the file cannot differ from
 * what is served. Asked at the default address, which the served page replaces with the deployment's own, with no
 * namespaces bound, on an empty library.
 */
export async function mcpDocument(): Promise<McpDocument> {
  return withApp(async (fetch) => {
    const rpc = async (id: number, method: string, params: object) => {
      const res = await fetch(
        new Request(`${DEFAULT_URL}/mcp`, {
          method: "POST",
          headers: { host: new URL(DEFAULT_URL).host, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        }),
      );
      const { result, error } = (await res.json()) as { result?: unknown; error?: unknown };
      if (!result) throw new Error(`${method} failed: ${JSON.stringify(error)}`);
      return result;
    };
    const init = (await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "honed-spec", version: "0" } })) as { instructions: string };
    const { tools } = (await rpc(2, "tools/list", {})) as { tools: McpTool[] };
    return { instructions: init.instructions, tools };
  });
}

const typeOf = (schema: JsonSchema): string => {
  if (schema.enum) return schema.enum.map((value) => `\`${String(value)}\``).join(", ");
  if (schema.const !== undefined) return `\`${String(schema.const)}\``;
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(" or ");
  if (schema.type === "array") return `${schema.items ? typeOf(schema.items) : "any"}[]`;
  const type = Array.isArray(schema.type) ? schema.type.join(" or ") : (schema.type ?? "any");
  // zod gives every integer a maximum, the largest safe one, which says nothing.
  return schema.maximum !== undefined && schema.maximum < Number.MAX_SAFE_INTEGER ? `${type}, at most ${schema.maximum}` : type;
};

const cell = (text: string | undefined) => (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Each input, and the fields of an object or of an array of objects beneath it. */
function inputs(schema: JsonSchema, prefix = ""): { name: string; type: string; required: boolean; description: string }[] {
  return Object.entries(schema.properties ?? {}).flatMap(([name, property]) => {
    const nested = property.type === "object" ? property : property.type === "array" && property.items?.type === "object" ? property.items : undefined;
    const below = nested ? inputs(nested, `${prefix}${name}${nested === property ? "" : "[]"}.`) : [];
    return [{ name: prefix + name, type: typeOf(property), required: schema.required?.includes(name) ?? false, description: property.description ?? "" }, ...below];
  });
}

/** What a repo's `.mcp.json` says to reach honed; served, the address is the deployment's own. */
const config = mcpJson(DEFAULT_URL, ["your-project", "shared"]);

const CONNECT = [
  "Streamable HTTP at `/mcp`, stateless, answering JSON. A honed with no tokens, started on this machine alone, needs none and",
  "answers only `127.0.0.1`, `localhost` or `[::1]`; once it has tokens, every request carries one as",
  "`Authorization: Bearer honed_…`, from `honed token create`. Feedback is recorded as from that token's name.",
  `\`${NAMESPACES_HEADER}\` names the namespaces a session's repo uses, comma-separated: it sees the skills in them and honed's own`,
  "`honed/`, and no others. Without it, a session sees only `honed/`.",
  "A refusal comes back as the tool's error, in the server's words.",
];

/** `docs/MCP.md`: how to connect, the server's instructions, then each tool and its input. */
export function renderMcp(doc: McpDocument): string {
  const lines = [
    "# honed's MCP server",
    "",
    "<!-- Generated from src/mcp.ts by `npm run spec`; do not edit. -->",
    "",
    ...CONNECT,
    "",
    "Claude Code connects with the honed plugin (`claude plugin install honed@honed`), which also asks each session for",
    "feedback. A repo binds its sessions to its namespaces by committing a `.mcp.json` at its root, with each person's",
    "token in `HONED_TOKEN` in their environment (on a honed with no tokens, leave out `Authorization`):",
    "",
    "```json",
    config,
    "```",
    "",
    "The contract is [`mcp.json`](../mcp.json); a running honed serves it at `/mcp.json` and this page at `/docs/mcp`.",
    "Its JSON API is described in [`API.md`](./API.md).",
    "",
    "## Instructions",
    "",
    "What the server tells an agent when it connects. The first part is the same for every session; the rest names the",
    "skills the session is bound to. Here, as a session bound to no namespace sees it, on an empty library:",
    "",
    ...doc.instructions.split("\n").map((line) => (line ? `> ${line}` : ">")),
    "",
    "## Tools",
    "",
    "| Tool | Does | Reads only |",
    "| --- | --- | --- |",
    ...doc.tools.map((tool) => `| [\`${tool.name}\`](#${tool.name}) | ${cell(tool.title)} | ${tool.annotations?.readOnlyHint ? "yes" : ""} |`),
    "",
  ];
  for (const tool of doc.tools) {
    lines.push(`### ${tool.name}`, "", tool.description ?? "", "");
    const rows = inputs(tool.inputSchema);
    if (rows.length) lines.push("| Input | Type | Required | |", "| --- | --- | --- | --- |", ...rows.map((r) => `| \`${r.name}\` | ${cell(r.type)} | ${r.required ? "yes" : ""} | ${cell(r.description)} |`), "");
    else lines.push("No input.", "");
  }
  return lines.join("\n");
}

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Inline code in a description, as Markdown writes it. */
const inline = (text: string | undefined) => esc(text ?? "").replace(/`([^`]+)`/g, "<code>$1</code>");

/** `docs/mcp.html`, served at `/docs/mcp`: what `docs/MCP.md` says, as a page. */
export function renderMcpHtml(doc: McpDocument): string {
  const tools = doc.tools
    .map((tool) => {
      const rows = inputs(tool.inputSchema).map((r) => `<tr><td><code>${esc(r.name)}</code></td><td>${inline(r.type)}</td><td>${r.required ? "yes" : ""}</td><td>${inline(r.description)}</td></tr>`);
      const input = rows.length ? `<table><thead><tr><th>Input</th><th>Type</th><th>Required</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>` : "<p>No input.</p>";
      const read = tool.annotations?.readOnlyHint ? ' <span class="ro">reads only</span>' : "";
      return `<section id="${esc(tool.name)}"><h3><code>${esc(tool.name)}</code>${read}</h3><p>${inline(tool.description)}</p>${input}</section>`;
    })
    .join("\n");
  const index = doc.tools.map((tool) => `<li><a href="#${esc(tool.name)}"><code>${esc(tool.name)}</code></a> ${esc(tool.title ?? "")}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>honed MCP server</title>
<!-- Generated from src/mcp.ts by \`npm run spec\`; do not edit. -->
<style>
:root{color-scheme:light dark}
body{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:0 auto;padding:24px;color:#1b2328;background:#f5f7f8}
a{color:#0b7a75}code,pre{font-family:ui-monospace,monospace;font-size:13px}pre,blockquote{background:#eef2f4;padding:10px 14px;border-radius:6px;overflow:auto}
blockquote{white-space:pre-wrap;margin:0}table{border-collapse:collapse;width:100%;margin:8px 0 20px}td,th{border:1px solid #dde3e7;padding:4px 8px;text-align:left;vertical-align:top}
.ro{font-size:11px;border:1px solid #0b7a75;color:#0b7a75;border-radius:4px;padding:0 6px;font-weight:normal}section{border-top:1px solid #dde3e7;padding-top:6px}
@media (prefers-color-scheme: dark){body{color:#e3eaee;background:#0f1417}a{color:#4fd1c5}pre,blockquote{background:#0b1013}td,th,section{border-color:#253038}.ro{border-color:#4fd1c5;color:#4fd1c5}}
</style></head><body>
<h1>honed's MCP server</h1>
<p>${inline(CONNECT.join(" "))}</p>
<p>Claude Code connects with the honed plugin (<code>claude plugin install honed@honed</code>), which also asks each session for feedback. A repo binds its sessions to its namespaces by committing a <code>.mcp.json</code> at its root, with each person's token in <code>HONED_TOKEN</code> in their environment (on a honed with no tokens, leave out <code>Authorization</code>):</p>
<pre>${esc(config)}</pre>
<p>The contract is <a href="../mcp.json"><code>mcp.json</code></a>; the JSON API's docs are <a href="./api">here</a>.</p>
<h2>Instructions</h2><p>What the server tells an agent when it connects. The first part is the same for every session; the rest names the skills the session is bound to. Here, as a session bound to no namespace sees it, on an empty library:</p><blockquote>${esc(doc.instructions)}</blockquote>
<h2>Tools</h2><ul>${index}</ul>
${tools}
</body></html>
`;
}
