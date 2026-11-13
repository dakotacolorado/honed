import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { honoPath } from "./api.ts";
import { createToken } from "./auth.ts";
import { Hub } from "./hub.ts";
import { openApiDocument, SPEC_FILE } from "./spec.ts";
import { app } from "./web.ts";

interface Spec {
  paths: Record<string, Record<string, { operationId?: string }>>;
}

const served = openApiDocument() as Promise<Spec>;

test("the committed openapi.json is what honed serves: npm run spec writes it", async () => {
  assert.deepEqual(JSON.parse(readFileSync(SPEC_FILE, "utf8")), await served);
});

test("every /api route honed answers is in the contract, and nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honed-api-"));
  const hub = await Hub.open(dir, null, { starters: false });
  try {
    const answered = app(hub, "test")
      .routes.filter((r) => r.path.startsWith("/api/") && r.method !== "ALL")
      .map((r) => `${r.method.toLowerCase()} ${r.path}`);
    const declared = Object.entries((await served).paths).flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method} ${honoPath(path)}`));
    assert.deepEqual([...answered].sort(), [...declared].sort());
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// A backstop for the pre-commit hook, which regenerates them.
test("docs/API.md and docs/index.html document every operation", async () => {
  const { paths } = await served;
  const markdown = readFileSync(new URL("../docs/API.md", import.meta.url), "utf8");
  const page = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");
  for (const [path, ops] of Object.entries(paths)) {
    assert.ok(markdown.includes(path), `docs/API.md lacks ${path}`);
    for (const op of Object.values(ops)) assert.ok(page.includes(op.operationId!), `docs/index.html lacks ${op.operationId}`);
  }
});

test("the contract and the API's docs need no token, on a honed that has tokens, under any host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honed-api-"));
  const hub = await Hub.open(dir, null, { starters: false });
  try {
    createToken(hub.store, "dakota", true);
    const web = app(hub, "test", { shared: true });
    const get = (path: string) => web.fetch(new Request(`https://honed.example.com${path}`, { headers: { host: "honed.example.com" } }));
    assert.equal((await get("/api/skills")).status, 401);
    const spec = await get("/openapi.json");
    assert.equal(spec.status, 200);
    assert.equal(((await spec.json()) as { info: { title: string } }).info.title, "honed");
    const docs = await get("/docs/api");
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get("content-type") ?? "", /text\/html/);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("every page links the API and MCP docs from its docs menu, the sign-in page included", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honed-api-"));
  const hub = await Hub.open(dir, null, { starters: false });
  try {
    const local = app(hub, "test");
    const home = await (await local.fetch(new Request("http://127.0.0.1/", { headers: { host: "127.0.0.1" } }))).text();
    createToken(hub.store, "dakota", true);
    const signIn = await (await app(hub, "test", { shared: true }).fetch(new Request("https://honed.example.com/login", { headers: { host: "honed.example.com" } }))).text();
    for (const page of [home, signIn]) {
      assert.match(page, /<details class="docs-menu">/);
      assert.match(page, /href="\/docs\/api"/);
      assert.match(page, /href="\/docs\/mcp"/);
    }
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("every operation is named in at most three words, for the docs' index", async () => {
  const long = Object.values((await served).paths)
    .flatMap((ops) => Object.values(ops) as { summary?: string }[])
    .map((op) => op.summary ?? "")
    .filter((summary) => !summary || summary.split(/\s+/).length > 3);
  assert.deepEqual(long, []);
});
