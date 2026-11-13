import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { HONER_SKILL, NAME_ROUTE, SKILL_FILE, type Feedback, type Judgment, type PendingRevision, type Skill, type Version } from "./domain.ts";
import type { SkillSummary } from "./hub.ts";

/** Where the contract is served, generated from the routes declared here. */
export const SPEC_PATH = "/openapi.json";
/** Sent by the page with every write. A cross-site form cannot set it, and a cross-site fetch that does is refused by CORS. */
export const WRITE_HEADER = "x-honed";
export const COOKIE = "honed_token";

/** The API's overview, at the top of its docs. Markdown. */
export const OVERVIEW = `honed keeps your organization's skills: the instructions coding agents read before a task, such as how a team writes commits or reviews code. When a skill turns out to be wrong, the agent that hit it reports it, and honed revises the skill from those reports, keeping every version and why it changed.

This API is how honed's web page, or a script of yours, reads the library: each skill with its files, versions and feedback, and why it changed. It is also how an admin edits, reverts or deletes a skill by hand. Agents don't use it: they use the MCP server at \`/mcp\` (docs at \`/docs/mcp\`).

## Tokens

A honed with no tokens, started on this machine alone, is local: it answers only requests naming \`127.0.0.1\`, \`localhost\` or \`[::1]\` as their host, needs no token, and treats every caller as an admin.

The first token (\`honed token create <name> [--admin]\`) makes it shared at once: from then on every request but this contract and the docs carries one, as \`Authorization: Bearer honed_…\` or as the \`${COOKIE}\` cookie that signing in on the page sets. A honed started on another host (\`--host 0.0.0.0\`) is shared from the start.

## Writes

Every write is a \`POST\` that carries the \`${WRITE_HEADER}: 1\` header, so a cross-site form cannot make one, and takes an admin token. Each is kept as a version of the skill, recorded as a judgment by a person, with the reason given.

## Errors

A refusal answers \`{ "error": "…" }\` in words a person can act on, with its status: 400 for a request that cannot be done as asked, 401 for a missing or unknown token, 403 for a write without the header or an admin token (or a local honed asked under another host name), 404 for a skill, version or judgment that does not exist, and 409 for a change that conflicts with the skill as it is.`;

const SkillName = z
  .string()
  .describe("A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.")
  .openapi({ example: "team/code-review" });
const Timestamp = z.string().describe("ISO 8601, UTC.").openapi({ example: "2026-11-12T19:03:13.726Z" });

const ErrorSchema = z.object({ error: z.string().describe("Why, in words a person can act on.") }).openapi("Error");

export const SkillSummarySchema = z
  .object({
    name: SkillName,
    description: z.string().describe(`The description in its ${SKILL_FILE}'s frontmatter.`),
    version: z.number().int().describe("Its current version, counting from 1."),
    chars: z.number().int().describe("The text it holds, all its files together, in characters."),
    limit: z.number().int().describe("The most text it may hold: its own limit, or the library's default."),
    feedback: z.number().int().describe("Feedback on its current version."),
    waiting: z.number().int().describe("Feedback no revision has considered yet."),
    protected: z.boolean().describe("Whether a revision from feedback waits for an admin's approval before it is kept."),
    pending: z.boolean().describe("Whether a revision of it is waiting for an admin now."),
    updatedAt: Timestamp,
  })
  .openapi("SkillSummary");

const ListedSkillSchema = SkillSummarySchema.extend({
  snippet: z.string().optional().describe("Only with `q`: where the query matched, each match between « and »."),
}).openapi("ListedSkill");

const SkillFileSchema = z.object({ path: z.string().openapi({ example: SKILL_FILE }), content: z.string(), executable: z.boolean() }).openapi("SkillFile");
const DraftFileSchema = z.object({ path: z.string(), content: z.string(), executable: z.boolean().optional() }).openapi("DraftFile");

const VersionSchema = z
  .object({
    skill: SkillName,
    version: z.number().int(),
    commit: z.string().describe("The commit in the library's git repository that holds it."),
    note: z.string().describe("What changed, in a line."),
    judgment: z.string().describe("The judgment that made it."),
    at: Timestamp,
  })
  .openapi("Version");

const FeedbackSchema = z
  .object({
    id: z.string(),
    skill: SkillName,
    version: z.number().int().describe("The version it was about; 0 for a skill that did not exist yet."),
    text: z.string().describe("Anything else the agent said; for a new skill, what it is for."),
    quote: z.string().nullable().describe("The exact text of the skill the report is about, found in that version's files; null for a new skill or the honer's own notes."),
    evidence: z
      .array(
        z.union([
          z.object({ path: z.string(), content: z.string() }).describe("A file, with its contents as the agent found them."),
          z.object({ command: z.string(), output: z.string() }).describe("A command the agent ran, with what it printed."),
        ]),
      )
      .describe("What shows the quote is wrong; empty when there is no quote."),
    whatChanged: z.string().nullable().describe("What the agent did instead of what the quote says, or what it changed; null when there is no quote."),
    draft: z.array(DraftFileSchema).describe("Files the agent drafted with it, each written whole."),
    author: z.string().describe("Its token's name, with the role the agent gave."),
    at: Timestamp,
    judgment: z.string().nullable().describe("The judgment that considered it; null while it waits for one."),
    sort: z
      .enum(["checkable", "judgment"])
      .nullable()
      .describe("How the judge sorted it: checkable (its evidence shows the quote wrong, so acted on at once) or judgment (held for agreement); null until sorted."),
    sortWhy: z.string().nullable().describe("The judge's reason for sorting it so."),
    sortedBy: z.string().nullable().describe("The judgment that sorted it."),
  })
  .openapi("Feedback");

export const JudgmentSchema = z
  .object({
    id: z.string(),
    skill: SkillName,
    by: z.enum(["judge", "person", "starter"]).describe("The judge revising from feedback, a person's edit, revert or deletion, or a starter shipped with honed."),
    actor: z.string().nullable().describe("For a person's change, whose token made it."),
    state: z.enum(["running", "pending", "done", "failed"]).describe("`pending`: a revision of a protected skill, made and held until an admin approves or declines it."),
    startedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
    changed: z.boolean().nullable().describe("Whether it changed the skill; null while running."),
    reasoning: z.string().describe("Why: the judge's reasoning, or the reason the person gave."),
    error: z.string().nullable().describe("What went wrong, for a failed judgment."),
    version: z.number().int().nullable().describe("The version it made, if it made one; null for a deletion."),
    review: z
      .object({
        by: z.string().describe("The admin who decided, by their token's name."),
        approved: z.boolean().describe("True if the revision was kept as a new version; false if it was discarded."),
        reason: z.string().describe("Why, as the admin gave it; may be empty."),
        at: Timestamp,
      })
      .nullable()
      .describe("For a held revision of a protected skill, the admin's decision on it; null until then, and for every other judgment."),
  })
  .openapi("Judgment");

const MaxChars = z.number().int().nullable().describe("The most text it may hold, set by an admin; null for the library's default.");
const Protected = z.boolean().describe("Set by an admin: a revision the honer makes from feedback waits for an admin's approval before it is kept, and agents read the current version meanwhile.");

export const SkillSchema = z.object({ name: SkillName, version: z.number().int(), createdAt: Timestamp, maxChars: MaxChars, protected: Protected }).openapi("Skill");

const PendingSchema = z
  .object({
    judgment: z.string().describe("The judgment that made it, with its reasoning and the feedback behind it."),
    skill: SkillName,
    version: z.number().int().describe("The version it was made from: it can be approved only while the skill is still that version."),
    note: z.string().describe("What it changes, in a line."),
    files: z.array(SkillFileSchema).describe("The skill's files as the revision would make them."),
    at: Timestamp,
  })
  .openapi("PendingRevision");

const SkillDetailSchema = z
  .object({
    name: SkillName,
    version: z.number().int(),
    createdAt: Timestamp,
    maxChars: MaxChars,
    protected: Protected,
    pending: PendingSchema.nullable().describe("A revision held for an admin's approval, if one is; agents are never served it."),
    files: z.array(SkillFileSchema).describe("Its files at its current version."),
    versions: z.array(VersionSchema).describe("Every version, newest first."),
    feedback: z.array(FeedbackSchema).describe("Its latest feedback, at most 100, newest first."),
  })
  .openapi("SkillDetail");

const JudgmentDetailSchema = JudgmentSchema.extend({
  feedback: z.array(FeedbackSchema).describe("The feedback it considered."),
}).openapi("JudgmentDetail");

const Reason = z.string().optional().describe("Why, kept in the skill's history. Defaults to a line saying what was done.");

const FileChangeSchema = z
  .object({
    path: z.string().optional().describe("The file to write, relative to the skill: `SKILL.md`, `scripts/check.sh`. Required unless `remove` is given."),
    content: z.string().optional().describe("Its whole new content. A file that exists keeps its executable bit."),
    remove: z.string().optional().describe("Instead of writing a file, the path of one to remove."),
    reason: Reason,
  })
  .openapi("FileChange");

/** A parameter's description goes on the parameter alone: a description on its schema too would be rendered twice. */
const param = (schema: z.ZodType, name: string, at: "path" | "query" | "header", description: string) => schema.openapi({ param: { name, in: at, description } });
const NAME = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NameParam = z.object({
  name: param(z.string().regex(NAME), "name", "path", "The skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`. Its slash may be plain or escaped as `%2F`."),
});
const WriteHeaders = z.object({
  [WRITE_HEADER]: param(z.literal("1"), WRITE_HEADER, "header", "Required on every write: a cross-site form cannot send it."),
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({ content: { "application/json": { schema } }, description });
const refusals = (statuses: Record<number, string>) =>
  Object.fromEntries(Object.entries(statuses).map(([status, description]) => [status, json(ErrorSchema, description)]));
const readRefusals = { 401: "No token, or one this server did not issue, on a shared honed.", 403: "A local honed asked under a host name other than this machine's." };
const writeRefusals = {
  ...readRefusals,
  400: "The change cannot be made as asked: the skill would break a rule (its frontmatter, a path, the cap), or a field is missing.",
  403: `No \`${WRITE_HEADER}\` header, a token that is not an admin's, or a local honed asked under another host name.`,
  404: "No skill has that name.",
};
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { cookieAuth: [] }, {}];
const write = { tags: ["writes"], security, request: { params: NameParam, headers: WriteHeaders } };

export const listSkillsRoute = createRoute({
  method: "get",
  path: "/api/skills",
  operationId: "listSkills",
  tags: ["skills"],
  summary: "List skills",
  description: "Every skill in the library, by name; with `q`, the skills whose name, description or text match any of its words, best first, each with where it matched.",
  security,
  request: {
    query: z.object({
      q: param(z.string(), "q", "query", "Words to search for. Omit to list every skill.").optional(),
      limit: param(z.string().regex(/^[0-9]+$/), "limit", "query", "With `q`, the most results to return.").openapi({ type: "integer", default: 20 }).optional(),
    }),
  },
  responses: {
    200: json(z.array(ListedSkillSchema), "Every skill, by name; with `q`, the matches, best first, each with its `snippet`."),
    ...refusals(readRefusals),
  },
});

export const getSkillRoute = createRoute({
  method: "get",
  path: "/api/skills/{name}",
  operationId: "getSkill",
  tags: ["skills"],
  summary: "Get skill",
  description: "A skill with its files, every version, and its latest feedback.",
  security,
  request: { params: NameParam },
  responses: { 200: json(SkillDetailSchema, "The skill."), ...refusals({ ...readRefusals, 404: "No skill has that name." }) },
});

export const getJudgmentRoute = createRoute({
  method: "get",
  path: "/api/judgments/{id}",
  operationId: "getJudgment",
  tags: ["judgments"],
  summary: "Get judgment",
  description: "One change, or decision not to change, to a skill, with the feedback it considered: why the skill is as it is.",
  security,
  request: { params: z.object({ id: param(z.string(), "id", "path", "The judgment's id, as a skill's versions and feedback name it.") }) },
  responses: { 200: json(JudgmentDetailSchema, "The judgment."), ...refusals({ ...readRefusals, 404: "No judgment has that id." }) },
});

export const revertRoute = createRoute({
  method: "post",
  path: "/api/skills/{name}/revert",
  operationId: "revertSkill",
  summary: "Revert skill",
  description: "Makes a new version holding an earlier version's files. Needs an admin token.",
  ...write,
  request: {
    ...write.request,
    body: json(
      z.object({ version: z.union([z.number().int(), z.string()]).describe("The version to go back to, from 1 to the one before the current."), reason: Reason }).openapi("Revert"),
      "The version to revert to.",
    ),
  },
  responses: { 200: json(JudgmentSchema, "The judgment recording the revert, and the version it made."), ...refusals(writeRefusals) },
});

export const editRoute = createRoute({
  method: "post",
  path: "/api/skills/{name}/edit",
  operationId: "editSkill",
  summary: "Edit file",
  description: "Writes one file whole, or removes one, as a new version, held to the same rules as any skill. Needs an admin token.",
  ...write,
  request: { ...write.request, body: json(FileChangeSchema, "The file to write, or the one to remove.") },
  responses: {
    200: json(JudgmentSchema, "The judgment recording the edit, and the version it made."),
    ...refusals({ ...writeRefusals, 409: "The change leaves the skill as it is." }),
  },
});

export const previewRoute = createRoute({
  method: "post",
  path: "/api/skills/{name}/preview",
  operationId: "previewEdit",
  summary: "Preview edit",
  description: "What the same request to `edit` would change, refused as it would be. Changes nothing. Needs an admin token, since the page shows it before saving.",
  ...write,
  request: { ...write.request, body: json(FileChangeSchema, "The file to write, or the one to remove.") },
  responses: {
    200: json(z.object({ html: z.string().describe("The change as a diff, rendered as an HTML fragment for the page.") }).openapi("Preview"), "The diff."),
    ...refusals(writeRefusals),
  },
});

export const limitRoute = createRoute({
  method: "post",
  path: "/api/skills/{name}/limit",
  operationId: "setSkillLimit",
  summary: "Set size limit",
  description: "The most text the skill may hold, all its files together, for the judge's revisions and people's edits alike; it applies to every change from now on, and text already over it may only shrink. Needs an admin token.",
  ...write,
  request: {
    ...write.request,
    body: json(
      z
        .object({
          maxChars: z
            .union([z.number().int(), z.string()])
            .optional()
            .describe("The limit in characters, at least 1. Empty or omitted for the library's default."),
        })
        .openapi("Limit"),
      "The limit to set.",
    ),
  },
  responses: {
    200: json(SkillSchema, "The skill, with its limit now."),
    ...refusals(writeRefusals),
  },
});

export const deleteRoute = createRoute({
  method: "post",
  path: "/api/skills/{name}/delete",
  operationId: "deleteSkill",
  summary: "Delete skill",
  description: `Takes a skill out of the library and search; its history stays in git, and feedback under its name can bring it back. Feedback waiting on it is closed by the deletion. \`${HONER_SKILL}\` cannot be deleted. Needs an admin token.`,
  ...write,
  request: { ...write.request, body: json(z.object({ reason: Reason }).openapi("Delete"), "Why.") },
  responses: {
    200: json(JudgmentSchema, "The judgment recording the deletion. Its `version` is null."),
    ...refusals({ ...writeRefusals, 409: `The skill is \`${HONER_SKILL}\`.` }),
  },
});

export const protectRoute = createRoute({
  method: "post",
  path: "/api/skills/{name}/protect",
  operationId: "protectSkill",
  summary: "Protect skill",
  description: "While a skill is protected, a revision the honer makes from feedback is held for an admin to approve or decline, and agents go on reading the current version; an admin's own edits and reverts apply at once. Needs an admin token.",
  ...write,
  request: {
    ...write.request,
    body: json(
      z.object({ protected: z.union([z.boolean(), z.enum(["true", "false"])]).describe("True to protect it, false to stop.") }).openapi("Protect"),
      "Whether to protect it.",
    ),
  },
  responses: { 200: json(SkillSchema, "The skill, with its protection now."), ...refusals(writeRefusals) },
});

const heldRefusals = { ...writeRefusals, 404: "No skill has that name, or no revision of it is waiting for approval." };

export const approveRoute = createRoute({
  method: "post",
  path: "/api/skills/{name}/approve",
  operationId: "approveRevision",
  summary: "Approve revision",
  description: "Keeps the revision waiting for approval as the skill's next version, from then on what agents read. Needs an admin token.",
  ...write,
  request: { ...write.request, body: json(z.object({ reason: Reason }).openapi("Approve"), "Why.") },
  responses: {
    200: json(JudgmentSchema, "The judgment that made the revision, now with the version it made and the approval."),
    ...refusals({ ...heldRefusals, 409: "The skill changed since the revision was made from it: decline it instead." }),
  },
});

export const declineRoute = createRoute({
  method: "post",
  path: "/api/skills/{name}/decline",
  operationId: "declineRevision",
  summary: "Decline revision",
  description: "Discards the revision waiting for approval: the skill stays as it is, and the decision is kept in its history. Needs an admin token.",
  ...write,
  request: { ...write.request, body: json(z.object({ reason: Reason }).openapi("Decline"), "Why.") },
  responses: { 200: json(JudgmentSchema, "The judgment that made the revision, now with the decline."), ...refusals(heldRefusals) },
});

export const judgeRoute = createRoute({
  method: "post",
  path: "/api/skills/{name}/judge",
  operationId: "reviseSkill",
  summary: "Revise now",
  description: `Has the judge consider the skill now, whatever feedback is waiting, judgment reports held for agreement included, which this approves; the only way \`${HONER_SKILL}\` is revised. Answers at once: the judgment appears in the skill's history when done. Needs an admin token.`,
  ...write,
  responses: {
    200: json(z.object({ revising: z.literal(true) }).openapi("Revising"), "The revision has started."),
    ...refusals({ ...writeRefusals, 409: "This server was started without a judge (`--judge off`)." }),
  },
});

/** The route's path as Hono matches it: a skill name may hold one slash, which `{name}` alone would not match. */
export const honoPath = (path: string) => path.replace("{name}", `:name${NAME_ROUTE}`).replace(/\{(\w+)\}/g, ":$1");

/** Serves the contract at `SPEC_PATH`, generated from the routes declared by then. */
export function describeApi(web: OpenAPIHono<any>, version: string): void {
  web.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", description: "A token from `honed token create`." });
  web.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", { type: "apiKey", in: "cookie", name: COOKIE, description: "Set by signing in on the page." });
  web.doc31(SPEC_PATH, {
    openapi: "3.1.0",
    info: { title: "honed", version, description: OVERVIEW, license: { name: "MIT" } },
    tags: [
      { name: "skills", description: "The library: each skill, its files, versions and feedback." },
      { name: "judgments", description: "Why a skill is as it is." },
      { name: "writes", description: "A person's changes. Each takes an admin token and the write header." },
    ],
  });
}

/** Fails to compile when a schema and the record it describes differ, so the contract cannot fall behind the code. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <T extends true>(_: T) => _;
same<Same<z.infer<typeof FeedbackSchema>, Feedback>>(true);
same<Same<z.infer<typeof JudgmentSchema>, Judgment>>(true);
same<Same<z.infer<typeof SkillSchema>, Skill>>(true);
same<Same<z.infer<typeof SkillSummarySchema>, SkillSummary>>(true);
same<Same<z.infer<typeof VersionSchema>, Version>>(true);
same<Same<z.infer<typeof PendingSchema>, PendingRevision>>(true);
