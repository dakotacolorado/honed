import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import { textSize, type Feedback, type Judgment, type SkillFile } from "./domain.ts";

/** A decision as the judge writes it: every field present, empty where unused, so one schema serves every case. */
export const DecisionSchema = z.object({
  reasoning: z.string().describe("Why you decided as you did, citing the feedback that decided it."),
  changed: z.boolean().describe("true if you are writing a new version of the skill."),
  note: z.string().describe("For a new version: one line for the skill's history. Empty otherwise."),
  write: z
    .array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() }))
    .describe("For a new version: each file to write, with its whole content. Empty otherwise."),
  remove: z.array(z.string()).describe("For a new version: each file to delete. Empty otherwise."),
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
  precedent: Judgment[];
  /** Why the judge's last attempt at this same case was refused, for it to correct. */
  failure: string | null;
  /** How to judge: the body of the honed-judge skill's current version. */
  guidance: string;
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
        `<feedback by="${attr(f.author)}" on_version="${f.version}" at="${f.at}">`,
        f.text,
        ...(f.draft.length ? [`<draft>\n${f.draft.map((d) => file("file", d)).join("\n")}\n</draft>`] : []),
        `</feedback>`,
      ].join("\n"),
    )
    .join("\n\n");
  const precedent = c.precedent
    .map((j) => `<judgment at="${j.startedAt}" changed="${j.changed}"${j.version ? ` made_version="${j.version}"` : ""}>${j.reasoning}</judgment>`)
    .join("\n");
  return [
    `<skill name="${c.skill}" version="${c.version}" characters="${textSize(c.files)}" cap="${c.maxChars}">\n${current}\n</skill>`,
    `<other_skills>\n${c.others.map((o) => `<skill name="${attr(o.name)}">${o.description}</skill>`).join("\n") || "none"}\n</other_skills>`,
    `<new_feedback>\n${feedback || "none"}\n</new_feedback>`,
    `<your_recent_judgments_on_this_skill>\n${precedent || "none"}\n</your_recent_judgments_on_this_skill>`,
    ...(c.failure ? [`<your_last_attempt_was_refused>\n${c.failure}\n</your_last_attempt_was_refused>`] : []),
  ].join("\n\n");
}

/** What every revision must keep to, whatever the honed-judge skill says: the cap, safety and the decision's form. */
export const JUDGE_CONTRACT = readFileSync(new URL("./judge-contract.md", import.meta.url), "utf8");

export const systemPrompt = (guidance: string) => `${JUDGE_CONTRACT}\n\n# Your judging guidance (the honed-judge skill)\n\n${guidance.trim()}\n`;

export interface ClaudeJudgeOptions {
  /** The Claude Code executable. */
  command?: string;
  model?: string;
  timeoutMs?: number;
}

/** Decides with one headless Claude Code session per case: no tools, no settings, no MCP servers, nothing to act with. */
export class ClaudeJudge implements Judge {
  readonly label = "Claude Code, signed in on this machine";
  private command: string;
  private model: string | undefined;
  private timeoutMs: number;

  constructor(opts: ClaudeJudgeOptions = {}) {
    this.command = opts.command ?? "claude";
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  }

  decide(c: Case): Promise<Decision> {
    const args = [
      "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(decisionJsonSchema()),
      "--system-prompt", systemPrompt(c.guidance),
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--no-session-persistence",
      ...(this.model ? ["--model", this.model] : []),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`the judge did not decide within ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not start ${this.command}: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(out) as { is_error?: boolean; result?: string; structured_output?: unknown };
          if (result.is_error) throw new Error(result.result ?? "the judge's session failed");
          resolve(DecisionSchema.parse(result.structured_output));
        } catch (e) {
          reject(new Error(`the judge gave no decision (exit ${code}): ${e instanceof Error ? e.message : String(e)}${err ? `; ${err.trim().slice(0, 500)}` : ""}`));
        }
      });
      child.stdin.end(render(c));
    });
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
