import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorOf } from "./auth.ts";
import { Refusal, SKILL_FILE, VERDICTS, VOTES, type Caller } from "./domain.ts";
import type { Hub } from "./hub.ts";

export const INSTRUCTIONS = `honed is a library of skills shared by every agent that uses this server, and honed by them.

- Before a task, call search_skills with what the task is about (or list_skills to see them all), and read_skill for any whose description fits. Follow what you read. To run a skill's script, read it with read_file and run your copy; never edit the library's own files.
- After using a skill, call give_feedback once: helped, hurt (it led you wrong), or missing (it lacked something you needed), with what happened. Be concrete; this is how skills improve.
- To change a skill, or to add one, call write_skill. It does not write: it opens a proposal, which a judge rules on with the votes, comments and feedback it has. Say in why what happened that the change would have helped with.
- Open proposals are listed in read_skill. Vote or comment on one when your own work bears on it, with your reason.
- Name your role or task in author (e.g. "reviewer on PR 12"), so the history says who said what.
- Skills have a hard cap on their text and get stickier as they grow: in a mature skill, a change has to make the whole better, not just add to it.`;

const author = z.string().optional().describe("Who you are, e.g. your role or task. Kept with what you write.");

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

async function answer(fn: () => Promise<unknown> | unknown) {
  try {
    return text(await fn());
  } catch (e) {
    if (e instanceof Refusal) return { ...text(e.message), isError: true };
    throw e;
  }
}

/** The MCP server for one request, speaking for `caller`. On a local server with no tokens, the caller is whoever is at this machine. */
export function mcpServer(hub: Hub, version: string, caller: Caller, local: boolean): McpServer {
  const server = new McpServer({ name: "honed", version }, { instructions: INSTRUCTIONS });
  const by = (given: string | undefined) => authorOf(caller, local, given);

  server.registerTool(
    "list_skills",
    {
      title: "List skills",
      description: "Every skill in the library: name, description, version, stage and open proposals.",
      annotations: { readOnlyHint: true },
    },
    () =>
      answer(() =>
        hub.list().map(({ name, description, version, maturity, openProposals }) => ({ name, description, version, stage: maturity.stage, openProposals })),
      ),
  );

  server.registerTool(
    "search_skills",
    {
      title: "Search skills",
      description: "Skills whose name, description or text match any word of query, best first, each with where it matched.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      answer(() => hub.search(query, limit ?? 10).map(({ name, description, version, snippet }) => ({ name, description, version, matched: snippet }))),
  );

  server.registerTool(
    "read_skill",
    {
      title: "Read a skill",
      description: `A skill's ${SKILL_FILE}, the paths of its other files, its stage and its open proposals. Give version for an earlier one.`,
      inputSchema: { name: z.string(), version: z.number().int().positive().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ name, version }) =>
      answer(async () => {
        const skill = hub.skill(name);
        const v = version ?? skill.version;
        const files = await hub.files(name, v);
        return {
          name,
          version: v,
          latestVersion: skill.version,
          ...(local && v === skill.version ? { folder: hub.library.path(name) } : {}),
          ...(v === skill.version ? { stage: hub.maturity(name).stage } : {}),
          [SKILL_FILE]: files.find((f) => f.path === SKILL_FILE)?.content ?? "",
          files: files.filter((f) => f.path !== SKILL_FILE).map((f) => ({ path: f.path, executable: f.executable, bytes: Buffer.byteLength(f.content) })),
          openProposals: hub.store.proposals(name, "open").map((p) => ({ id: p.id, title: p.title, by: p.author, votes: hub.store.votes(p.id).length })),
        };
      }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a skill's file",
      description: "One file of a skill, at its latest version or at version.",
      inputSchema: { name: z.string(), path: z.string(), version: z.number().int().positive().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ name, path, version }) =>
      answer(async () => {
        const file = (await hub.files(name, version ?? hub.skill(name).version)).find((f) => f.path === path);
        if (!file) throw new Refusal(`${name} has no file ${path}`, 404);
        return file.content;
      }),
  );

  server.registerTool(
    "write_skill",
    {
      title: "Propose a change to a skill",
      description: `Proposes a change to a skill, or a new skill: files to write whole and paths to remove. A new skill needs a ${SKILL_FILE} whose frontmatter has its name and a description. Nothing changes until the judge merges it; get_proposal says how it went.`,
      inputSchema: {
        name: z.string().describe("The skill: lowercase letters, digits and hyphens."),
        title: z.string().describe("What the change does, in a line."),
        why: z.string().describe("What happened in your work that this change would have helped with."),
        write: z
          .array(z.object({ path: z.string(), content: z.string(), executable: z.boolean().optional() }))
          .default([])
          .describe("Each file to write, with its whole new content."),
        remove: z.array(z.string()).default([]).describe("Paths to delete."),
        author,
      },
    },
    ({ name, title, why, write, remove, author }) =>
      answer(async () => {
        const p = await hub.propose({ skill: name, title, why, change: { write, remove }, author: by(author) });
        return { proposal: p.id, state: p.state, note: "The judge rules on it shortly. Call get_proposal to see the ruling." };
      }),
  );

  server.registerTool(
    "get_proposal",
    {
      title: "Read a proposal",
      description: "A proposal's state, its change as a diff against the current skill, its votes and comments, and the rulings on it.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      answer(async () => {
        const p = hub.proposal(id);
        return {
          id: p.id,
          skill: p.skill,
          title: p.title,
          why: p.why,
          by: p.author,
          state: p.state,
          diff: p.state === "open" ? await hub.proposalDiff(p) : undefined,
          votes: hub.store.votes(id),
          comments: hub.store.comments(id),
          rulings: hub.store.rulingsOn(id),
          judging: hub.isJudging(p.skill),
        };
      }),
  );

  server.registerTool(
    "vote",
    {
      title: "Vote on a proposal",
      description: "Votes up or down on an open proposal, with the reason from your own work. A second vote replaces your first.",
      inputSchema: { proposal: z.string(), vote: z.enum(VOTES), reason: z.string(), author },
    },
    ({ proposal, vote, reason, author }) => answer(() => (hub.vote({ proposal, vote, reason, author: by(author) }), "Your vote is recorded.")),
  );

  server.registerTool(
    "comment",
    {
      title: "Comment on a proposal",
      description: "Comments on an open proposal: a question, a concern, or what it would need to be merged.",
      inputSchema: { proposal: z.string(), body: z.string(), author },
    },
    ({ proposal, body, author }) => answer(() => (hub.comment({ proposal, body, author: by(author) }), "Your comment is recorded.")),
  );

  server.registerTool(
    "give_feedback",
    {
      title: "Give feedback on a skill",
      description: "Says how a skill did in your work: helped, hurt (it led you wrong) or missing (it lacked what you needed), and what happened.",
      inputSchema: {
        name: z.string(),
        verdict: z.enum(VERDICTS),
        reason: z.string(),
        version: z.number().int().positive().optional().describe("The version you used, if not the latest."),
        author,
      },
    },
    ({ name, verdict, reason, version, author }) =>
      answer(async () => (await hub.giveFeedback({ skill: name, verdict, reason, version, author: by(author) }), "Thanks: your feedback is recorded.")),
  );

  return server;
}
