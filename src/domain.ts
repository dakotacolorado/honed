import { randomUUID } from "node:crypto";

export const POLICIES = ["judge", "human"] as const;
export type Policy = (typeof POLICIES)[number];

export const VERDICTS = ["helped", "hurt", "missing"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VOTES = ["up", "down"] as const;
export type Vote = (typeof VOTES)[number];

export const PROPOSAL_STATES = ["open", "merged", "rejected"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** Who made a version or ruled on a proposal: the judge, or the person at the page. */
export type Ruler = "judge" | "human";

export const SKILL_FILE = "SKILL.md";
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_FILES = 100;
/** Unconsidered feedback on a skill that starts a judgment when no proposal is open. */
export const FEEDBACK_BATCH = 3;
/** Failed judgments in a row on a skill before it waits for something new. */
export const JUDGMENT_ATTEMPTS = 3;
/** Past rulings on a skill the judge is shown, to stay consistent with itself. */
export const PRECEDENT = 5;

export interface FileWrite {
  path: string;
  content: string;
  executable?: boolean;
}

/** A change to a skill's files: each `write` replaces or adds a file whole, each `remove` deletes one. */
export interface Change {
  write: FileWrite[];
  remove: string[];
}

export interface SkillFile {
  path: string;
  content: string;
  executable: boolean;
}

export interface Skill {
  name: string;
  policy: Policy;
  version: number;
  createdAt: string;
}

export interface Version {
  skill: string;
  version: number;
  commit: string;
  note: string;
  by: Ruler;
  judgment: string;
  at: string;
}

export interface Proposal {
  id: string;
  skill: string;
  baseVersion: number;
  title: string;
  why: string;
  change: Change;
  author: string;
  state: ProposalState;
  createdAt: string;
  decidedAt: string | null;
  judgment: string | null;
}

export interface Ballot {
  proposal: string;
  vote: Vote;
  reason: string;
  author: string;
  at: string;
}

export interface Comment {
  id: string;
  proposal: string;
  body: string;
  author: string;
  at: string;
}

export interface Feedback {
  id: string;
  skill: string;
  version: number;
  verdict: Verdict;
  reason: string;
  author: string;
  at: string;
  /** The judgment that considered it; null while it waits for one. */
  judgment: string | null;
}

export interface Judgment {
  id: string;
  skill: string;
  by: Ruler;
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  outcome: "change" | "no_change" | null;
  reasoning: string;
  error: string | null;
  /** The version it made, if it made one. */
  version: number | null;
}

export interface ProposalRuling {
  judgment: string;
  proposal: string;
  ruling: ProposalState;
  reason: string;
}

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

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function checkName(name: string): string {
  if (!NAME.test(name) || name.length > 64) {
    throw new Refusal(`skill name "${name}" must be lowercase letters, digits and single hyphens, at most 64 characters`);
  }
  return name;
}

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

export function checkChange(change: Change): Change {
  if (change.write.length === 0 && change.remove.length === 0) throw new Refusal("the change writes and removes nothing");
  const paths = [...change.write.map((w) => w.path), ...change.remove];
  paths.forEach(checkPath);
  if (new Set(paths).size !== paths.length) throw new Refusal("a path appears in the change more than once");
  for (const w of change.write) {
    if (Buffer.byteLength(w.content) > MAX_FILE_BYTES) throw new Refusal(`${w.path} is over ${MAX_FILE_BYTES} bytes`);
  }
  return change;
}

/** The files a change leaves, from the files before it. */
export function applyChange(before: SkillFile[], change: Change): SkillFile[] {
  const files = new Map(before.map((f) => [f.path, f]));
  for (const path of change.remove) {
    if (!files.delete(path)) throw new Refusal(`cannot remove ${path}: the skill has no such file`);
  }
  for (const w of change.write) files.set(w.path, { path: w.path, content: w.content, executable: w.executable ?? false });
  const after = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (after.length > MAX_FILES) throw new Refusal(`a skill holds at most ${MAX_FILES} files`);
  return after;
}

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

/** Refuses files a skill cannot be made of: no SKILL.md, or one whose frontmatter does not name it and say what it is for. */
export function checkSkillFiles(name: string, files: SkillFile[]): void {
  const skillMd = files.find((f) => f.path === SKILL_FILE);
  if (!skillMd) throw new Refusal(`a skill must have a ${SKILL_FILE}`);
  const fm = frontmatter(skillMd.content);
  if (fm.name !== name) throw new Refusal(`${SKILL_FILE}'s frontmatter must say name: ${name}`);
  if (!fm.description) throw new Refusal(`${SKILL_FILE}'s frontmatter must have a description`);
}
