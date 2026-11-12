import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorOf } from "./auth.ts";
import { checkName, NAMESPACES_HEADER, OWN_NAMESPACE, Refusal, Scope, SKILL_FILE, type Caller } from "./domain.ts";
import type { Hub } from "./hub.ts";

/** When an agent reports on a skill: two things it can tell happened, not a judgment of how the skill did. */
export const TRIGGER = "If you edited something a skill mentions, or a skill gave you wrong information, report it before you finish, quoting the skill's text and showing the evidence.";

export const INSTRUCTIONS = `honed is your organization's shared skills library, and it improves from your reports.

- Before a task, search_skills for what it is about (or list_skills), and get_skill any whose description fits. Follow what you read.
- ${TRIGGER} Use submit_feedback: quote is the skill's exact text, evidence the file as it is now or the command and what it printed, what_changed what you did or changed. Otherwise send nothing. Include files when you know the exact fix. Never include secrets or personal details.
- To add a skill, read honed/skill-writing first, then submit_feedback under the new name with a draft of its ${SKILL_FILE}.`;

/** The most skills the instructions name; the rest are a list_skills away. */
const LISTED = 100;

/** The .mcp.json a repo commits to connect to this server and bind its sessions to `namespaces`. */
export function mcpJson(origin: string, namespaces: string[]): string {
  const config = {
    mcpServers: {
      honed: {
        type: "http",
        url: `${origin}/mcp`,
        headers: { Authorization: "Bearer ${HONED_TOKEN}", "X-Honed-Namespaces": namespaces.join(", ") },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/** The instructions for one connection: how to use honed, then which skills it is bound to, or how to bind its repo. */
export function instructions(hub: Hub, scope: Scope, origin: string): string {
  const skills = hub.list(scope.prefixes);
  const listed = skills.slice(0, LISTED).map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const more = skills.length > LISTED ? `\n- …and ${skills.length - LISTED} more: list_skills to see them all.` : "";
  const binding = scope.bound
    ? `This repo is bound to ${scope.namespaces.map((n) => `${n}/`).join(", ")} (and honed's own ${OWN_NAMESPACE}/). Its skills:\n${listed || "- none yet"}${more}`
    : `This session's repo is bound to no namespace, so it sees only honed's own ${OWN_NAMESPACE}/ skills:\n${listed || "- none"}${more}\n\nTo bind a repo to the namespaces it uses (its own, plus any shared ones), commit this .mcp.json at its root, with your namespaces in ${NAMESPACES_HEADER}, and set HONED_TOKEN in each person's environment:\n${mcpJson(origin, ["your-project", "shared"])}`;
  return `${INSTRUCTIONS}\n\n${binding}`;
}

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
export function mcpServer(hub: Hub, version: string, caller: Caller, local: boolean, scope = new Scope([]), origin = ""): McpServer {
  const server = new McpServer({ name: "honed", version }, { instructions: instructions(hub, scope, origin) });
  /** A skill outside the scope is answered as one that does not exist, so a repo learns nothing of another's. */
  const visible = (name: string) => {
    if (!scope.sees(name)) throw new Refusal(`no skill is named ${name}`, 404);
    return hub.skill(name);
  };

  server.registerTool(
    "list_skills",
    {
      title: "List skills",
      description: "Every skill this repo is bound to, with its description.",
      annotations: { readOnlyHint: true },
    },
    () => answer(() => hub.list(scope.prefixes).map(({ name, description, version }) => ({ name, description, version }))),
  );

  server.registerTool(
    "search_skills",
    {
      title: "Search skills",
      description: "Skills whose name, description or text match any word of query, best first, with where each matched.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) => answer(() => hub.search(query, limit ?? 10, scope.prefixes).map(({ name, description, version, snippet }) => ({ name, description, version, matched: snippet }))),
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
        const skill = visible(name);
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
      description: `${TRIGGER} quote is that text exactly, evidence what shows it is wrong, and what_changed what you did instead or changed. A report missing any of these, or quoting text the skill does not have, is refused with how to fix it; resubmit it fixed. Include files to suggest exact text. Under a name no skill has yet, it asks for that skill: say what it is for in feedback, follow honed/skill-writing and draft its ${SKILL_FILE}; no quote is needed. Skills are revised from these reports.`,
      inputSchema: {
        name: z.string().describe("The skill, e.g. team/code-review: an optional prefix for its group, then lowercase letters, digits and hyphens."),
        quote: z.string().optional().describe("The exact text in the skill that is wrong or that your edit made out of date, copied from get_skill: a whole sentence or line. Not needed for a new skill."),
        evidence: z
          .array(
            z.object({
              path: z.string().optional().describe("A file that shows the quote is wrong, e.g. src/api.ts."),
              content: z.string().optional().describe("That file's current contents, or the part that shows it."),
              command: z.string().optional().describe("A command you ran, e.g. npm run lint."),
              output: z.string().optional().describe("What the command actually printed."),
            }),
          )
          .optional()
          .describe("What shows the quote is wrong: each a file with its current contents, or a command with what it printed. Not needed for a new skill."),
        what_changed: z.string().optional().describe("What you did instead of what the quote says, or what you changed that it describes. Not needed for a new skill."),
        feedback: z.string().optional().describe("Anything else worth knowing. For a new skill: what it is for."),
        files: z
          .array(z.object({ path: z.string(), content: z.string(), executable: z.boolean().optional() }))
          .optional()
          .describe("Optional: files you suggest, each with its whole content."),
        author: z.string().optional().describe("Your role or task, e.g. reviewer on PR 12."),
      },
    },
    ({ name, quote, evidence, what_changed, feedback, files, author }) =>
      answer(async () => {
        if (!scope.sees(checkName(name))) {
          throw new Refusal(
            scope.bound
              ? `${name} is outside the namespaces this repo is bound to (${scope.namespaces.map((n) => `${n}/`).join(", ")}): name a skill under one of them`
              : `this session's repo is bound to no namespace, so it can report only on honed's own ${OWN_NAMESPACE}/ skills: bind the repo as your instructions say`,
          );
        }
        const { next } = await hub.submitFeedback({ skill: name, quote, evidence, whatChanged: what_changed, text: feedback, files, author: authorOf(caller, local, author) });
        if (next.kind === "off") return "Recorded. Revision is off on this server, so it will be read by a person.";
        if (next.kind === "admin") return `Recorded. ${name} is revised only when an admin asks; your feedback will be there when they do.`;
        if (next.kind === "waiting") return `Recorded. ${name} is revised once ${next.more} more piece${next.more === 1 ? "" : "s"} of feedback arrive, or sooner if someone includes a draft.`;
        return hub.store.skill(name) ? `Recorded. ${name} is being revised from it now.` : `Recorded. The new skill ${name} is being considered now.`;
      }),
  );

  return server;
}
