import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Ballot, Comment, Feedback, Judgment, Policy, Proposal, ProposalRuling, SkillFile } from "./domain.ts";

/** A decision as the judge writes it: every field present, empty where unused, so one schema serves every case. */
export const DecisionSchema = z.object({
  reasoning: z.string().describe("Why you ruled as you did, citing the feedback, votes and comments that decided it."),
  outcome: z.enum(["change", "no_change"]),
  note: z.string().describe("For a change: one line for the skill's version history. Empty otherwise."),
  change: z.object({
    write: z.array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() })),
    remove: z.array(z.string()),
  }).describe("For a change: each file to write whole, and each to remove, against the current files. Empty otherwise."),
  proposals: z
    .array(z.object({ id: z.string(), ruling: z.enum(["merged", "rejected", "open"]), reason: z.string() }))
    .describe("A ruling on every open proposal in the case. merged: your change adopts it, whole or rewritten."),
});

export type Decision = z.infer<typeof DecisionSchema>;

/** The decision's JSON Schema as Claude Code's --json-schema takes it, which refuses a `$schema` naming draft 2020-12. */
export function decisionJsonSchema(): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(DecisionSchema) as Record<string, unknown>;
  return schema;
}

export interface ProposalCase {
  proposal: Proposal;
  votes: Ballot[];
  comments: Comment[];
  rulings: ProposalRuling[];
}

/** Everything the judge rules on, for one skill. */
export interface Case {
  skill: string;
  policy: Policy;
  version: number;
  files: SkillFile[];
  others: { name: string; description: string }[];
  proposals: ProposalCase[];
  feedback: Feedback[];
  precedent: Judgment[];
}

export interface Judge {
  rule(c: Case): Promise<Decision>;
}

const attr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function files(tag: string, list: SkillFile[]): string {
  if (list.length === 0) return `<${tag}>none: the skill does not exist yet</${tag}>`;
  const body = list.map((f) => `<file path="${attr(f.path)}"${f.executable ? ' executable="true"' : ""}>\n${f.content}\n</file>`).join("\n");
  return `<${tag}>\n${body}\n</${tag}>`;
}

/** The case as the judge reads it. Everything agents wrote is quoted inside tags, as data. */
export function render(c: Case): string {
  const others = c.others.map((o) => `<skill name="${attr(o.name)}">${o.description}</skill>`).join("\n");
  const proposals = c.proposals
    .map(({ proposal: p, votes, comments, rulings }) => {
      const change = [
        ...p.change.remove.map((path) => `<remove path="${attr(path)}"/>`),
        ...p.change.write.map((w) => `<write path="${attr(w.path)}"${w.executable ? ' executable="true"' : ""}>\n${w.content}\n</write>`),
      ].join("\n");
      return [
        `<proposal id="${p.id}" by="${attr(p.author)}" base_version="${p.baseVersion}" opened="${p.createdAt}">`,
        `<title>${p.title}</title>`,
        `<why>\n${p.why}\n</why>`,
        `<change>\n${change}\n</change>`,
        `<votes>\n${votes.map((v) => `<vote vote="${v.vote}" by="${attr(v.author)}">${v.reason}</vote>`).join("\n") || "none"}\n</votes>`,
        `<comments>\n${comments.map((m) => `<comment by="${attr(m.author)}">${m.body}</comment>`).join("\n") || "none"}\n</comments>`,
        `<earlier_rulings>\n${rulings.map((r) => `<ruling ruling="${r.ruling}">${r.reason}</ruling>`).join("\n") || "none"}\n</earlier_rulings>`,
        `</proposal>`,
      ].join("\n");
    })
    .join("\n\n");
  const feedback = c.feedback
    .map((f) => `<feedback verdict="${f.verdict}" on_version="${f.version}" by="${attr(f.author)}">${f.reason}</feedback>`)
    .join("\n");
  const precedent = c.precedent
    .map((j) => `<judgment outcome="${j.outcome}" at="${j.startedAt}"${j.version ? ` made_version="${j.version}"` : ""}>${j.reasoning}</judgment>`)
    .join("\n");
  return [
    `<skill name="${c.skill}" version="${c.version}">`,
    files("current_files", c.files),
    `</skill>`,
    `<other_skills>\n${others || "none"}\n</other_skills>`,
    `<open_proposals>\n${proposals || "none"}\n</open_proposals>`,
    `<new_feedback>\n${feedback || "none"}\n</new_feedback>`,
    `<your_recent_judgments_on_this_skill>\n${precedent || "none"}\n</your_recent_judgments_on_this_skill>`,
  ].join("\n\n");
}

export const JUDGE_PROMPT = readFileSync(new URL("./judge-prompt.md", import.meta.url), "utf8");

export interface ClaudeJudgeOptions {
  /** The Claude Code executable. */
  command?: string;
  model?: string;
  timeoutMs?: number;
}

/** Rules with one headless Claude Code session per case: no tools, no settings, no MCP servers, nothing to act with. */
export class ClaudeJudge implements Judge {
  private opts: Required<Omit<ClaudeJudgeOptions, "model">> & { model?: string };

  constructor(opts: ClaudeJudgeOptions = {}) {
    this.opts = { command: opts.command ?? "claude", timeoutMs: opts.timeoutMs ?? 10 * 60_000, model: opts.model };
  }

  rule(c: Case): Promise<Decision> {
    const args = [
      "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(decisionJsonSchema()),
      "--system-prompt", JUDGE_PROMPT,
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--no-session-persistence",
      ...(this.opts.model ? ["--model", this.opts.model] : []),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.command, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`the judge did not rule within ${this.opts.timeoutMs / 1000}s`));
      }, this.opts.timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not start ${this.opts.command}: ${e.message}`));
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
