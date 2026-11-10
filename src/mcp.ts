import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorOf } from "./auth.ts";
import { Refusal, SKILL_FILE, type Caller } from "./domain.ts";
import type { Hub } from "./hub.ts";

export const INSTRUCTIONS = `honed is your organization's shared skills library, and it improves from your feedback.

- Before a task, search_skills for what it is about (or list_skills), and get_skill any whose description fits. Follow what you read.
- After using a skill, submit_feedback once: what happened, and what should change. Be concrete: an error, a reviewer's comment, or what you did differently beats an opinion. If it simply worked, say so briefly. Include files when you know the exact fix. Never include secrets or personal details.
- To add a skill, read honed/skill-writing first, then submit_feedback under the new name with a draft of its ${SKILL_FILE}.`;

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

async function answer(fn: () => Promise<unknown> | unknown) {
  try {
    return text(await fn());
  } catch (e) {
    if (e instanceof Refusal) return { ...text(e.message), isError: true };
    throw e;
  }
}

/** The MCP server for one request, speaking for `caller`. */
export function mcpServer(hub: Hub, version: string, caller: Caller, local: boolean): McpServer {
  const server = new McpServer({ name: "honed", version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_skills",
    {
      title: "List skills",
      description: "Every skill in the library, with its description.",
      annotations: { readOnlyHint: true },
    },
    () => answer(() => hub.list().map(({ name, description, version }) => ({ name, description, version }))),
  );

  server.registerTool(
    "search_skills",
    {
      title: "Search skills",
      description: "Skills whose name, description or text match any word of query, best first, with where each matched.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) => answer(() => hub.search(query, limit ?? 10).map(({ name, description, version, snippet }) => ({ name, description, version, matched: snippet }))),
  );

  server.registerTool(
    "get_skill",
    {
      title: "Get a skill",
      description: `A skill's ${SKILL_FILE} and the paths of its other files; with path, that one file instead. To run a script, get it and run your copy.`,
      inputSchema: {
        name: z.string(),
        path: z.string().optional().describe(`One file of the skill, e.g. scripts/check.sh. Omit for ${SKILL_FILE} and the file list.`),
        version: z.number().int().positive().optional().describe("An earlier version; omit for the latest."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ name, path, version }) =>
      answer(async () => {
        const skill = hub.skill(name);
        const files = await hub.files(name, version ?? skill.version);
        if (path) {
          const file = files.find((f) => f.path === path);
          if (!file) throw new Refusal(`${name} has no file ${path}`, 404);
          return file.content;
        }
        return {
          name,
          version: version ?? skill.version,
          [SKILL_FILE]: files.find((f) => f.path === SKILL_FILE)?.content ?? "",
          files: files.filter((f) => f.path !== SKILL_FILE).map((f) => ({ path: f.path, executable: f.executable })),
        };
      }),
  );

  server.registerTool(
    "submit_feedback",
    {
      title: "Submit feedback on a skill",
      description: `What happened when you used a skill, and what should change: the task, what the skill said, the result, and what would have helped, with evidence where you have it. Include files to suggest exact text. Under a name no skill has yet, it asks for that skill: follow honed/skill-writing and draft its ${SKILL_FILE}. Skills are revised from this feedback.`,
      inputSchema: {
        name: z.string().describe("The skill, e.g. team/code-review: an optional prefix for its group, then lowercase letters, digits and hyphens."),
        feedback: z.string().describe("What happened in your work, and what should change."),
        files: z
          .array(z.object({ path: z.string(), content: z.string(), executable: z.boolean().optional() }))
          .optional()
          .describe("Optional: files you suggest, each with its whole content."),
        author: z.string().optional().describe("Your role or task, e.g. reviewer on PR 12."),
      },
    },
    ({ name, feedback, files, author }) =>
      answer(async () => {
        const { next } = await hub.submitFeedback({ skill: name, text: feedback, files, author: authorOf(caller, local, author) });
        if (next.kind === "off") return "Recorded. Revision is off on this server, so it will be read by a person.";
        if (next.kind === "admin") return `Recorded. ${name} is revised only when an admin asks; your feedback will be there when they do.`;
        if (next.kind === "waiting") return `Recorded. ${name} is revised once ${next.more} more piece${next.more === 1 ? "" : "s"} of feedback arrive, or sooner if someone includes a draft.`;
        return hub.store.skill(name) ? `Recorded. ${name} is being revised from it now.` : `Recorded. The new skill ${name} is being considered now.`;
      }),
  );

  return server;
}
