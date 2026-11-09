import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { ApiJudge, ClaudeJudge, type Judge } from "./judge.ts";

export const JUDGE_MODES = ["auto", "claude-code", "api", "off"] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];

export interface ReviserOptions {
  mode: string;
  model?: string;
  /** The Claude Code executable, by name or path. */
  claude?: string;
  apiKey?: string;
  path?: string;
}

export interface Reviser {
  judge: Judge | null;
  /** Why skills will or will not be revised, for the banner. */
  why: string;
}

/** Whether `command` is an executable here: a path, or a name found on PATH. */
export function onPath(command: string, path = process.env.PATH ?? ""): boolean {
  const candidates = isAbsolute(command) || command.includes("/") ? [command] : path.split(delimiter).filter(Boolean).map((d) => join(d, command));
  return candidates.some((c) => {
    try {
      accessSync(c, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Who revises skills. On a dev machine that is Claude Code, signed in; on a hosted server it is the Claude API, with a key.
 * auto takes Claude Code when it is installed, else the API when a key is set, else nothing.
 */
export function chooseReviser(opts: ReviserOptions): Reviser {
  const mode = opts.mode as JudgeMode;
  if (!JUDGE_MODES.includes(mode)) throw new Error(`--judge must be one of ${JUDGE_MODES.join(", ")}, not ${opts.mode}`);
  const claude = opts.claude ?? "claude";
  const hasClaude = onPath(claude, opts.path);
  const apiKey = opts.apiKey?.trim() || undefined;
  if (mode === "off") return { judge: null, why: "Revision is off (--judge off): skills change only by hand." };
  if (mode === "api" || (mode === "auto" && !hasClaude && apiKey)) {
    if (!apiKey) throw new Error("--judge api needs ANTHROPIC_API_KEY, the key the Claude API bills revisions to");
    const judge = new ApiJudge({ apiKey, model: opts.model });
    return { judge, why: `Revising with ${judge.label}, billed to ANTHROPIC_API_KEY.` };
  }
  if (mode === "claude-code" || (mode === "auto" && hasClaude)) {
    if (!hasClaude) throw new Error(`--judge claude-code needs Claude Code installed and signed in; ${claude} was not found`);
    const judge = new ClaudeJudge({ command: claude, model: opts.model });
    return { judge, why: `Revising with ${judge.label}.` };
  }
  return {
    judge: null,
    why: "Revision is off: Claude Code is not installed and ANTHROPIC_API_KEY is not set. Install one, or set the key, and restart.",
  };
}
