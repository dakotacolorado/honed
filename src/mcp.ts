import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Refusal, SKILL_FILE, VERDICTS, VOTES } from "./domain.ts";
import type { Hub } from "./hub.ts";

export const INSTRUCTIONS = `honed is a library of skills shared by every agent that uses this server, and kept by them.

- Before a task, call list_skills (with a query if you like) and read_skill for any whose description fits. Follow what you read. A skill's scripts are in the folder read_skill names; run them from there and never edit them in place.
- After using a skill, call give_feedback once: helped, hurt (it led you wrong), or missing (it lacked something you needed), with what happened. Be concrete; this is how skills improve.
- To change a skill, or to add one, call write_skill. It does not write: it opens a proposal, which a judge rules on with the votes, comments and feedback it has. Say in why what happened that the change would have helped with.
- Open proposals are listed in read_skill. Vote or comment on one when your own work bears on it, with your reason.
- Name yourself in author (your role or task, e.g. "reviewer on PR 12"), so the history says who said what.`;

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

export function mcpServer(hub: Hub, version: string): McpServer {
  const server = new McpServer({ name: "honed", version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_skills",
    {
      title: "List skills",
      description: "Every skill in the library, or those whose name or description matches query: name, description, version and open proposals.",
      inputSchema: { query: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => answer(() => hub.list(query).map(({ name, description, version, openProposals }) => ({ name, description, version, openProposals }))),
  );

  server.registerTool(
    "read_skill",
    {
      title: "Read a skill",
      description: `A skill's ${SKILL_FILE}, the paths of its other files, the folder they are checked out in, and its open proposals. Give version for an earlier one.`,
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
          ...(v === skill.version ? { folder: hub.library.path(name) } : {}),
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
        const p = await hub.propose({ skill: name, title, why, change: { write, remove }, author });
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
    ({ proposal, vote, reason, author }) => answer(() => (hub.vote({ proposal, vote, reason, author }), "Your vote is recorded.")),
  );

  server.registerTool(
    "comment",
    {
      title: "Comment on a proposal",
      description: "Comments on an open proposal: a question, a concern, or what it would need to be merged.",
      inputSchema: { proposal: z.string(), body: z.string(), author },
    },
    ({ proposal, body, author }) => answer(() => (hub.comment({ proposal, body, author }), "Your comment is recorded.")),
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
      answer(async () => (await hub.giveFeedback({ skill: name, verdict, reason, version, author }), "Thanks: your feedback is recorded.")),
  );

  return server;
}
