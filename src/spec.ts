import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC_PATH } from "./api.ts";
import { Hub } from "./hub.ts";
import { mcpDocument, renderMcp, renderMcpHtml } from "./mcp-doc.ts";
import { app } from "./web.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/** `openapi.json`, committed so a client can be written without a running honed, and so a change to the contract shows in review. */
export const SPEC_FILE = fileURLToPath(new URL("../openapi.json", import.meta.url));
/** The MCP server's contract, `tools/list` as served, beside its renderings. */
export const MCP_FILE = fileURLToPath(new URL("../mcp.json", import.meta.url));
export const MCP_DOC = fileURLToPath(new URL("../docs/MCP.md", import.meta.url));
export const MCP_PAGE = fileURLToPath(new URL("../docs/mcp.html", import.meta.url));

/** Runs `fn` against an app on an empty library, as `npm run spec` and the drift tests see it. */
export async function withApp<T>(fn: (fetch: (req: Request) => Response | Promise<Response>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "honed-spec-"));
  const hub = await Hub.open(dir, null, { starters: false });
  try {
    return await fn(app(hub, version).fetch);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fetched through the app, so the file cannot differ from what is served. */
export const openApiDocument = (): Promise<unknown> => withApp(async (fetch) => (await fetch(new Request(`http://127.0.0.1${SPEC_PATH}`))).json());

if (import.meta.main) {
  await writeFile(SPEC_FILE, `${JSON.stringify(await openApiDocument(), null, 2)}\n`);
  const mcp = await mcpDocument();
  await writeFile(MCP_FILE, `${JSON.stringify(mcp, null, 2)}\n`);
  await writeFile(MCP_DOC, renderMcp(mcp));
  await writeFile(MCP_PAGE, renderMcpHtml(mcp));
  console.log(`wrote ${SPEC_FILE}, ${MCP_FILE}, ${MCP_DOC} and ${MCP_PAGE}`);
}
