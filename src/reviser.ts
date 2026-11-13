import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { ApiJudge, ClaudeJudge, type Judge } from "./judge.ts";

/** `claude-code` and `agent-sdk` are the same judge: Claude Code, run through the Claude Agent SDK. */
export const JUDGE_MODES = ["auto", "claude-code", "agent-sdk", "api", "off"] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];

export interface ReviserOptions {
  mode: string;
  model?: string;
  /** A Claude Code executable to run instead of the one the Agent SDK ships with. */
  claude?: string;
  apiKey?: string;
  /** The environment to look for a Claude Code sign-in in; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the environment's PATH. */
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
 * Where Claude Code can sign in from, if anywhere: a token in the environment, its credentials file, or an installed
 * Claude Code (whose login may be in the system keychain). honed needs no Claude Code installed to use it.
 */
export function claudeSignIn(env: NodeJS.ProcessEnv = process.env, path = env.PATH ?? ""): string | null {
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return "CLAUDE_CODE_OAUTH_TOKEN";
  if (existsSync(join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), ".credentials.json"))) return "Claude Code's login on this machine";
  if (onPath("claude", path)) return "Claude Code's login on this machine";
  return null;
}

/**
 * Who revises skills: Claude Code through the Claude Agent SDK, signed in with a Claude Code token or login, or the
 * Claude API with a key. auto takes Claude Code when it can sign in, else the API when a key is set, else nothing.
 */
export function chooseReviser(opts: ReviserOptions): Reviser {
  const mode = opts.mode as JudgeMode;
  if (!JUDGE_MODES.includes(mode)) throw new Error(`--judge must be one of ${JUDGE_MODES.join(", ")}, not ${opts.mode}`);
  const env = opts.env ?? process.env;
  const signIn = claudeSignIn(env, opts.path ?? env.PATH ?? "");
  const apiKey = opts.apiKey?.trim() || undefined;
  if (mode === "off") return { judge: null, why: "Revision is off (--judge off): skills change only by hand." };
  if (mode === "api" || (mode === "auto" && !signIn && apiKey)) {
    if (!apiKey) throw new Error("--judge api needs ANTHROPIC_API_KEY, the key the Claude API bills revisions to");
    const judge = new ApiJudge({ apiKey, model: opts.model });
    return { judge, why: `Revising with ${judge.label}, billed to ANTHROPIC_API_KEY.` };
  }
  if (mode === "claude-code" || mode === "agent-sdk" || (mode === "auto" && signIn)) {
    const judge = new ClaudeJudge({ model: opts.model, executable: opts.claude });
    const as = signIn ?? (apiKey ? "ANTHROPIC_API_KEY" : "whatever sign-in Claude Code finds (none was seen: set CLAUDE_CODE_OAUTH_TOKEN)");
    return { judge, why: `Revising with ${judge.label}, signed in with ${as}.` };
  }
  return {
    judge: null,
    why: "Revision is off: there is no Claude Code sign-in (CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`) and ANTHROPIC_API_KEY is not set. Set one and restart.",
  };
}
