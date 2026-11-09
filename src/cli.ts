#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Hub } from "./hub.ts";
import { ClaudeJudge } from "./judge.ts";
import { app } from "./web.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const USAGE = `honed ${version}: skills your agents share, propose changes to and govern, with a judge that rules on every change.

Usage: honed [options]

  --port <n>          port to serve the page and /mcp on (default 4321, or HONED_PORT)
  --dir <path>        where the skills and their records are kept (default ~/.honed, or HONED_DIR)
  --judge-model <m>   the model the judge runs on (default: Claude Code's own default)
  --claude <path>     the Claude Code executable the judge runs with (default: claude)
  --no-judge          rule on every proposal by hand
  -h, --help          this
`;

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    dir: { type: "string" },
    "judge-model": { type: "string" },
    claude: { type: "string" },
    "no-judge": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const port = Number(values.port ?? process.env.HONED_PORT ?? 4321);
const dir = resolve(values.dir ?? process.env.HONED_DIR ?? join(homedir(), ".honed"));
const judge = values["no-judge"] ? null : new ClaudeJudge({ model: values["judge-model"], command: values.claude });
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const hub = await Hub.open(dir, judge, { log });
const server = serve({ fetch: app(hub, version).fetch, port, hostname: "127.0.0.1" }, () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`honed ${version} on ${url}, keeping ${dir}${judge ? "" : " (no judge: every proposal is ruled on by hand)"}

  Connect Claude Code:   claude mcp add --transport http --scope user honed ${url}/mcp
`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    hub.close();
    process.exit(0);
  });
}
