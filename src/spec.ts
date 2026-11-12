import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC_PATH } from "./api.ts";
import { Hub } from "./hub.ts";
import { app } from "./web.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/** `openapi.json`, committed so a client can be written without a running honed, and so a change to the contract shows in review. */
export const SPEC_FILE = fileURLToPath(new URL("../openapi.json", import.meta.url));

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
  console.log(`wrote ${SPEC_FILE}`);
}
