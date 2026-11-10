import { randomUUID } from "node:crypto";

export const SKILL_FILE = "SKILL.md";
/** The most text a skill may hold, all its files together, unless the server is started with another. */
export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_FILES = 100;
/** The honer's own guidance: shipped with honed, never deleted, revised only when an admin asks. */
export const HONER_SKILL = "honed/honer";
/** How to write a new skill: agents read it before drafting one, and the honer holds new skills to it. */
export const WRITING_SKILL = "honed/skill-writing";
/** Who the honer's feedback on its own guidance is recorded as written by. */
export const HONER_AUTHOR = "the honer";
/** Feedback without a draft waits for this many on a skill before the judge looks; a draft is judged at once. */
export const FEEDBACK_BATCH = 3;
/** Failed judgments in a row before a skill waits for new feedback. */
export const JUDGMENT_ATTEMPTS = 3;
/** Past judgments on a skill the judge is shown, to stay consistent with itself. */
export const PRECEDENT = 5;

export interface SkillFile {
  path: string;
  content: string;
  executable: boolean;
}

/** Files an agent drafts with its feedback: each one written whole. */
export interface DraftFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface Skill {
  name: string;
  version: number;
  createdAt: string;
}

export interface Version {
  skill: string;
  version: number;
  commit: string;
  note: string;
  judgment: string;
  at: string;
}

export interface Feedback {
  id: string;
  skill: string;
  /** The version it was about; 0 for a skill that did not exist yet. */
  version: number;
  text: string;
  /** Files the agent drafted, if any. */
  draft: DraftFile[];
  author: string;
  at: string;
  /** The judgment that considered it; null while it waits for one. */
  judgment: string | null;
}

/** One change, or decision not to change, to a skill: the judge's from feedback, a person's revert, or a starter shipped with honed. */
export interface Judgment {
  id: string;
  skill: string;
  by: "judge" | "person" | "starter";
  /** For a person's ruling, whose token made it. */
  actor: string | null;
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  changed: boolean | null;
  reasoning: string;
  error: string | null;
  /** The version it made, if it made one. */
  version: number | null;
}

/** Who is calling: a named token, or whoever is at this machine on a server with no tokens. */
export interface Caller {
  name: string;
  admin: boolean;
}

export const LOCAL_CALLER: Caller = { name: "you", admin: true };

/** A request refused for a reason the caller can fix; `status` is its HTTP status. */
export class Refusal extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();

const PART = "[a-z0-9]+(?:-[a-z0-9]+)*";
const NAME = new RegExp(`^(?:${PART}/)?${PART}$`);
/** A skill name in a URL path: an optional prefix, then the name. */
export const NAME_ROUTE = `{${PART}(?:/${PART})?}`;

/** A skill's name is its own, optionally under one prefix that groups it: `git-commits`, `team/git-commits`. */
export function checkName(name: string): string {
  if (!NAME.test(name) || name.split("/").some((p) => p.length > 64)) {
    throw new Refusal(`"${name}" must be lowercase letters, digits and single hyphens, optionally under one prefix like team/, at most 64 characters a part`);
  }
  return name;
}

/** The part after the prefix: what a SKILL.md's frontmatter names, since Claude Code's skill names have no slash. */
export const baseName = (name: string) => name.slice(name.lastIndexOf("/") + 1);
/** The prefix a skill is grouped under, or "" for none. */
export const prefixOf = (name: string) => (name.includes("/") ? name.slice(0, name.indexOf("/")) : "");

export function checkPath(path: string): string {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.length > 200 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith(".git"))
  ) {
    throw new Refusal(`file path "${path}" must be relative, inside the skill, with no empty, "." or ".." parts and no .git`);
  }
  return path;
}

export function checkDraft(draft: DraftFile[]): DraftFile[] {
  const paths = draft.map((f) => checkPath(f.path));
  if (new Set(paths).size !== paths.length) throw new Refusal("a path appears in the draft more than once");
  return draft;
}

/** The files after writing `writes` over `before` and deleting `remove`. */
export function applyFiles(before: SkillFile[], writes: DraftFile[], remove: string[] = []): SkillFile[] {
  const files = new Map(before.map((f) => [f.path, f]));
  for (const path of remove) {
    if (!files.delete(checkPath(path))) throw new Refusal(`cannot remove ${path}: the skill has no such file`);
  }
  for (const w of checkDraft(writes)) files.set(w.path, { path: w.path, content: w.content, executable: w.executable ?? false });
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export const textSize = (files: { content: string }[]) => files.reduce((n, f) => n + f.content.length, 0);

export interface Frontmatter {
  name?: string;
  description?: string;
}

/** The `name` and `description` of a SKILL.md's frontmatter, the fields Claude Code reads. */
export function frontmatter(skillMd: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!match?.[1]) return {};
  const out: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^(name|description):\s*(.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out[m[1] as keyof Frontmatter] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Refuses files a skill cannot be: no SKILL.md naming it and saying what it is for, too many files, or over the cap. */
export function checkSkill(name: string, files: SkillFile[], maxChars: number): void {
  const skillMd = files.find((f) => f.path === SKILL_FILE);
  if (!skillMd) throw new Refusal(`a skill must have a ${SKILL_FILE}`);
  const fm = frontmatter(skillMd.content);
  if (fm.name !== baseName(name)) {
    throw new Refusal(`${SKILL_FILE}'s frontmatter must say name: ${baseName(name)}${name.includes("/") ? ` (the part after ${prefixOf(name)}/, since Claude Code's skill names have no slash)` : ""}`);
  }
  if (!fm.description) throw new Refusal(`${SKILL_FILE}'s frontmatter must have a description`);
  if (files.length > MAX_FILES) throw new Refusal(`a skill holds at most ${MAX_FILES} files`);
  const size = textSize(files);
  if (size > maxChars) throw new Refusal(`the skill would hold ${size} characters, over the cap of ${maxChars}: condense it to make room`);
}
