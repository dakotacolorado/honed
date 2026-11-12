import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToken } from "./auth.ts";
import { Hub } from "./hub.ts";
import { INSTRUCTIONS } from "./mcp.ts";
import { mcpDocument, renderMcp, renderMcpHtml } from "./mcp-doc.ts";
import { MCP_DOC, MCP_FILE, MCP_PAGE } from "./spec.ts";
import { app } from "./web.ts";

const served = mcpDocument();

test("the committed mcp.json and its renderings are what honed serves: npm run spec writes them", async () => {
  const doc = await served;
  assert.deepEqual(JSON.parse(readFileSync(MCP_FILE, "utf8")), doc);
  assert.equal(readFileSync(MCP_DOC, "utf8"), renderMcp(doc));
  assert.equal(readFileSync(MCP_PAGE, "utf8"), renderMcpHtml(doc));
});

test("the docs give every tool with its arguments, and the instructions an agent is given", async () => {
  const doc = await served;
  assert.equal(doc.instructions, INSTRUCTIONS);
  assert.deepEqual(doc.tools.map((t) => t.name), ["list_skills", "search_skills", "get_skill", "submit_feedback"]);
  const md = renderMcp(doc);
  for (const tool of doc.tools) {
    assert.match(md, new RegExp(`### ${tool.name}\\n`));
    for (const arg of Object.keys(tool.inputSchema.properties ?? {})) assert.ok(md.includes(`| \`${arg}\` |`), `${tool.name} lacks ${arg}`);
  }
  assert.ok(md.includes("> - To add a skill, read honed/skill-writing first"));
});

test("mcp.json and the MCP docs need no token, on a honed that has tokens, and give the deployment's own address", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honed-mcp-doc-"));
  const hub = await Hub.open(dir, null, { starters: false });
  try {
    createToken(hub.store, "dakota", true);
    const web = app(hub, "test", { shared: true });
    const get = (path: string, headers: Record<string, string> = {}) => web.fetch(new Request(`http://honed.example.com${path}`, { headers: { host: "honed.example.com", ...headers } }));
    assert.equal((await get("/mcp")).status, 401);
    const contract = await get("/mcp.json");
    assert.equal(contract.status, 200);
    assert.deepEqual(await contract.json(), await served);
    const page = await get("/docs/mcp", { "x-forwarded-proto": "https" });
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.ok(text.includes("https://honed.example.com/mcp"));
    assert.ok(!text.includes("127.0.0.1:4321"));
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
