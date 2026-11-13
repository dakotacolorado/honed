import Anthropic from "@anthropic-ai/sdk";
import { query as sdkQuery, type Options as SdkOptions, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import { reportName, textSize, type Feedback, type Judgment, type SkillFile } from "./domain.ts";

/** A past judgment, with the reports it decided on. */
export type Precedent = Judgment & { feedback: Feedback[] };

/** A decision as the judge writes it: every field present, empty where unused, so one schema serves every case. */
export const DecisionSchema = z.object({
  reasoning: z.string().describe("Why you decided as you did, citing the feedback that decided it."),
  changed: z.boolean().describe("true if you are writing a new version of the skill."),
  note: z.string().describe("For a new version: one line for the skill's history. Empty otherwise."),
  edits: z
    .array(z.object({ path: z.string(), old: z.string(), new: z.string() }))
    .describe("For a new version of an existing skill: each change to a file's text, `old` copied exactly from the current file (appearing once in it) and `new` its replacement. Applied in order, before write and remove. Empty otherwise."),
  write: z
    .array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() }))
    .describe("For a new skill, a new file, or a rewrite your reasoning justifies: each file to write, with its whole content. Empty otherwise."),
  remove: z.array(z.string()).describe("For a new version: each file to delete. Empty otherwise."),
  sorted: z
    .array(
      z.object({
        report: z.string().describe("The report's id, from <feedback id=…>."),
        kind: z.enum(["checkable", "judgment"]).describe("checkable: its evidence shows the quoted text is wrong. judgment: anything else."),
        why: z.string().describe("In a sentence: what in the evidence decided it."),
      }),
    )
    .describe("Every report (feedback with a <quote>) sorted, each once. A judgment report is not acted on: it waits for agreement."),
  revert_to: z
    .number()
    .int()
    .describe("To undo instead of edit: the earlier version to restore whole, when new feedback with evidence contradicts what later versions changed. edits, write and remove then stay empty. 0 otherwise."),
  honer_feedback: z
    .string()
    .describe("Feedback on your own guidance (the honed/honer skill): what deciding this showed it gets wrong or leaves out. Empty when nothing, and always empty when the skill is honed/honer."),
});

export type Decision = z.infer<typeof DecisionSchema>;

/** The decision's JSON Schema as Claude Code's --json-schema takes it, which refuses a `$schema` naming draft 2020-12. */
export function decisionJsonSchema(): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(DecisionSchema) as Record<string, unknown>;
  return schema;
}

/** Everything the judge decides on, for one skill. */
export interface Case {
  skill: string;
  version: number;
  maxChars: number;
  files: SkillFile[];
  others: { name: string; description: string }[];
  feedback: Feedback[];
  precedent: Precedent[];
  /** An admin asked for this judgment: held judgment reports are in it, and may revise the skill. */
  approved: boolean;
  /** Why the judge's last attempt at this same case was refused, for it to correct. */
  failure: string | null;
  /** How to judge: the body of the honed/honer skill's current version. */
  guidance: string;
  /** For a skill that does not exist yet: the body of honed/skill-writing, the standard a new skill is held to. */
  writingGuide: string | null;
}

export interface Judge {
  /** How honed says it revises, for the banner: "Claude Code (your login)", "the Claude API (claude-opus-5-5)". */
  readonly label: string;
  decide(c: Case): Promise<Decision>;
}

const attr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const file = (tag: string, f: { path: string; content: string; executable?: boolean }) =>
  `<${tag} path="${attr(f.path)}"${f.executable ? ' executable="true"' : ""}>\n${f.content}\n</${tag}>`;

/** The case as the judge reads it. Everything agents wrote is quoted inside tags, as data. */
export function render(c: Case): string {
  const current = c.files.length ? c.files.map((f) => file("file", f)).join("\n") : "none: the skill does not exist yet";
  const feedback = c.feedback
    .map((f) =>
      [
        `<feedback id="${f.id.slice(0, 8)}" by="${attr(f.author)}" on_version="${f.version}" at="${f.at}"${f.sort ? ` sorted_before="${f.sort}"` : ""}>`,
        ...(f.quote !== null ? [`<quote>\n${f.quote}\n</quote>`] : []),
        ...f.evidence.map((e) =>
          "path" in e ? `<evidence file="${attr(e.path)}">\n${e.content}\n</evidence>` : `<evidence command="${attr(e.command)}">\n${e.output}\n</evidence>`,
        ),
        ...(f.whatChanged !== null ? [`<what_changed>\n${f.whatChanged}\n</what_changed>`] : []),
        ...(f.text ? [f.quote !== null ? `<also_said>\n${f.text}\n</also_said>` : f.text] : []),
        ...(f.draft.length ? [`<draft>\n${f.draft.map((d) => file("file", d)).join("\n")}\n</draft>`] : []),
        `</feedback>`,
      ].join("\n"),
    )
    .join("\n\n");
  const precedent = c.precedent
    .map((j) => {
      const reports = j.feedback.map((f) => `<from report="${f.id.slice(0, 8)}" by="${attr(f.author)}">${f.quote !== null ? `quoting: ${f.quote}` : f.text.slice(0, 300)}</from>`);
      return `<judgment at="${j.startedAt}" changed="${j.changed}"${j.version ? ` made_version="${j.version}"` : ""} reports="${j.feedback.length}">\n${[...reports, j.reasoning].join("\n")}\n</judgment>`;
    })
    .join("\n");
  return [
    `<skill name="${c.skill}" version="${c.version}" characters="${textSize(c.files)}" cap="${c.maxChars}">\n${current}\n</skill>`,
    `<other_skills>\n${c.others.map((o) => `<skill name="${attr(o.name)}">${o.description}</skill>`).join("\n") || "none"}\n</other_skills>`,
    ...(c.writingGuide ? [`<skill_writing_guide>\n${c.writingGuide}\n</skill_writing_guide>`] : []),
    ...(c.approved ? ["<an_admin_asked_for_this_judgment>\nAn admin asked for it, so judgment reports held for agreement are included, and any report may revise the skill. Sort them still.\n</an_admin_asked_for_this_judgment>"] : []),
    `<new_feedback>\n${feedback || "none"}\n</new_feedback>`,
    `<your_recent_judgments_on_this_skill>\n${precedent || "none"}\n</your_recent_judgments_on_this_skill>`,
    ...(c.failure ? [`<your_last_attempt_was_refused>\n${c.failure}\n</your_last_attempt_was_refused>`] : []),
  ].join("\n\n");
}

/** What every revision must keep to, whatever the honed/honer skill says: the cap, safety and the decision's form. */
export const JUDGE_CONTRACT = readFileSync(new URL("./judge-contract.md", import.meta.url), "utf8");

export const systemPrompt = (guidance: string) => `${JUDGE_CONTRACT}\n\n# Your guidance (the honed/honer skill)\n\n${guidance.trim()}\n`;

/** The Claude Agent SDK's `query`, or a stand-in for tests. */
export type AgentQuery = (params: { prompt: string; options: SdkOptions }) => AsyncIterable<SDKMessage>;

export interface ClaudeJudgeOptions {
  model?: string;
  timeoutMs?: number;
  /** A Claude Code executable to run instead of the one the Agent SDK ships with. */
  executable?: string;
  /** For tests: what to call instead of the Agent SDK. */
  query?: AgentQuery;
}

/**
 * Decides with one headless Claude Code session per case, through the Claude Agent SDK: no tools, no settings, no MCP
 * servers, nothing kept, nothing to act with. It signs in as Claude Code does: `CLAUDE_CODE_OAUTH_TOKEN` (made with
 * `claude setup-token`), `ANTHROPIC_API_KEY`, or the login of Claude Code on this machine.
 */
export class ClaudeJudge implements Judge {
  readonly label = "Claude Code, through the Claude Agent SDK";
  private model: string | undefined;
  private timeoutMs: number;
  private executable: string | undefined;
  private query: AgentQuery;

  constructor(opts: ClaudeJudgeOptions = {}) {
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.executable = opts.executable;
    this.query = opts.query ?? sdkQuery;
  }

  async decide(c: Case): Promise<Decision> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    let stderr = "";
    const options: SdkOptions = {
      abortController: abort,
      cwd: tmpdir(),
      systemPrompt: systemPrompt(c.guidance),
      outputFormat: { type: "json_schema", schema: decisionJsonSchema() },
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      ...(this.model ? { model: this.model } : {}),
      ...(this.executable ? { pathToClaudeCodeExecutable: this.executable } : {}),
      stderr: (d) => (stderr = (stderr + d).slice(-2000)),
    };
    try {
      let result: Extract<SDKMessage, { type: "result" }> | undefined;
      for await (const m of this.query({ prompt: render(c), options })) if (m.type === "result") result = m;
      if (abort.signal.aborted) throw new Error("aborted");
      if (!result) throw new Error("the session ended without a result");
      if (result.subtype !== "success") throw new Error(result.errors.join("; ") || result.subtype);
      if (result.is_error) throw new Error(result.result || "the judge's session failed");
      return DecisionSchema.parse(result.structured_output);
    } catch (e) {
      if (abort.signal.aborted) throw new Error(`the judge did not decide within ${this.timeoutMs / 1000}s`);
      throw new Error(`the judge gave no decision: ${e instanceof Error ? e.message : String(e)}${stderr.trim() ? `; ${stderr.trim().slice(0, 500)}` : ""}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The model the API judge uses unless told otherwise. */
export const API_MODEL = "claude-opus-5-5";

export interface ApiJudgeOptions {
  /** Defaults to ANTHROPIC_API_KEY. */
  apiKey?: string;
  model?: string;
  /** For tests: a client to call instead of the Claude API. */
  client?: Anthropic;
}

/**
 * Decides with one call to the Claude API per case, for a server with no Claude Code login. The decision comes back
 * as structured output against the decision's schema; a refusal falls back to another model server-side.
 */
export class ApiJudge implements Judge {
  readonly label: string;
  private client: Anthropic;
  private model: string;

  constructor(opts: ApiJudgeOptions = {}) {
    this.model = opts.model ?? API_MODEL;
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.label = `the Claude API (${this.model})`;
  }

  async decide(c: Case): Promise<Decision> {
    let message;
    try {
      message = await this.client.beta.messages
        .stream({
          model: this.model,
          max_tokens: 32_000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: systemPrompt(c.guidance),
          output_config: { effort: "high", format: { type: "json_schema", schema: decisionJsonSchema() } },
          messages: [{ role: "user", content: render(c) }],
        })
        .finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error("the Claude API refused the API key: check ANTHROPIC_API_KEY");
      if (e instanceof Anthropic.RateLimitError) throw new Error("the Claude API is rate-limiting this key; the feedback waits and is revised when more arrives");
      if (e instanceof Anthropic.APIError) throw new Error(`the Claude API failed (${e.status ?? "no status"}): ${e.message}`);
      throw e;
    }
    if (message.stop_reason === "refusal") throw new Error(`the Claude API declined to decide (${message.stop_details?.category ?? "no category"})`);
    if (message.stop_reason === "max_tokens") throw new Error("the decision ran past the token limit; the skill may be too large to revise in one answer");
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    try {
      return DecisionSchema.parse(JSON.parse(text));
    } catch (e) {
      throw new Error(`the Claude API gave no valid decision: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
