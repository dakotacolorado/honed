#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createToken } from "./auth.ts";
import { banner, palette, TAGLINE, WORDMARK } from "./banner.ts";
import { DEFAULT_MAX_CHARS, Refusal } from "./domain.ts";
import { Hub } from "./hub.ts";
import { ClaudeJudge } from "./judge.ts";
import { Store } from "./store.ts";
import { app } from "./web.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = palette(color);

const USAGE = `${c.edge(WORDMARK)}  ${c.dim(`v${version}`)}

${c.bold(TAGLINE)}
A shared skills library over MCP. Agents get skills and submit feedback; each skill is revised from it.

Usage:
  honed [serve] [options]              run the server: the page, and MCP at /mcp
  honed token create <name> [--admin]  make a token; printed once, kept only as a hash
  honed token list
  honed token revoke <name>

Options:
  --host <addr>       address to listen on (default 127.0.0.1). Anything else shares it, and needs a token first.
  --port <n>          port (default 4321, or HONED_PORT)
  --dir <path>        where the skills and their records are kept (default ~/.honed, or HONED_DIR)
  --max-chars <n>     the hard cap on a skill's text, all its files together (default ${DEFAULT_MAX_CHARS})
  --judge-model <m>   the model that revises skills (default: Claude Code's own)
  --claude <path>     the Claude Code executable that revises skills (default: claude)
  --no-judge          never revise skills from feedback (they change only by revert)
  -h, --help          this

With no tokens, honed answers only its own machine and needs none. Once a token exists, every request needs one:
agents send it as a bearer token, people paste it into the page. Only an admin token can revert a skill.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    port: { type: "string" },
    dir: { type: "string" },
    "max-chars": { type: "string" },
    "judge-model": { type: "string" },
    claude: { type: "string" },
    "no-judge": { type: "boolean" },
    admin: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const fail = (message: string): never => {
  process.stderr.write(`honed: ${message}\n`);
  process.exit(1);
};

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const dir = resolve(values.dir ?? process.env.HONED_DIR ?? join(homedir(), ".honed"));
const [command = "serve", sub, name] = positionals;

if (command === "token") {
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "honed.db"));
  try {
    if (sub === "create" && name) {
      const token = createToken(store, name, values.admin ?? false);
      console.log(`${token}\n\nThe token for ${name}${values.admin ? " (admin)" : ""}. It is shown this once; honed keeps only its hash.`);
    } else if (sub === "list") {
      const tokens = store.tokens();
      console.log(tokens.length ? tokens.map((t) => `${t.name}${t.admin ? " (admin)" : ""}  made ${t.createdAt}`).join("\n") : "No tokens: honed answers only this machine.");
    } else if (sub === "revoke" && name) {
      if (!store.revokeToken(name)) fail(`no token is named ${name}`);
      console.log(`Revoked ${name}.`);
    } else {
      fail("usage: honed token create <name> [--admin] | list | revoke <name>");
    }
  } catch (e) {
    fail(e instanceof Refusal ? e.message : String(e));
  } finally {
    store.close();
  }
  process.exit(0);
}

if (command !== "serve") fail(`no command ${command}; see honed --help`);

const host = values.host ?? process.env.HONED_HOST ?? "127.0.0.1";
const shared = !["127.0.0.1", "localhost", "::1"].includes(host);
const port = Number(values.port ?? process.env.HONED_PORT ?? 4321);
const maxChars = Number(values["max-chars"] ?? process.env.HONED_MAX_CHARS ?? DEFAULT_MAX_CHARS);
if (!Number.isInteger(maxChars) || maxChars < 1000) fail("--max-chars must be a whole number of at least 1000");
const judge = values["no-judge"] ? null : new ClaudeJudge({ model: values["judge-model"], command: values.claude });
const log = (line: string) => console.log(`${c.dim(new Date().toTimeString().slice(0, 8))} ${c.edge("✦")} ${line}`);

const hub = await Hub.open(dir, judge, { log, maxChars });
if (shared && hub.store.tokens().length === 0) {
  hub.close();
  fail(`listening on ${host} shares honed beyond this machine, so it needs a token first:\n  honed token create <your-name> --admin${values.dir ? ` --dir ${values.dir}` : ""}`);
}

const server = serve({ fetch: app(hub, version, { shared }).fetch, port, hostname: host }, () => {
  const url = `http://${shared ? host : "127.0.0.1"}:${port}`;
  console.log(banner({ version, url, dir, tokens: hub.store.tokens().length, judge: judge !== null, color }));
});
server.on("error", (e: NodeJS.ErrnoException) => {
  hub.close();
  fail(e.code === "EADDRINUSE" ? `port ${port} is in use (is honed already running?). Try --port ${port + 1}.` : e.message);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    hub.close();
    process.exit(0);
  });
}
