import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEdits,
  applyFiles,
  checkDraft,
  checkName,
  checkSkill,
  DEFAULT_MAX_CHARS,
  frontmatter,
  HONER_AUTHOR,
  prefixOf,
  HONER_SKILL,
  WRITING_SKILL,
  JUDGMENT_ATTEMPTS,
  MAX_EVIDENCE,
  MAX_EVIDENCE_ITEMS,
  MIN_QUOTE,
  newId,
  now,
  PRECEDENT,
  quoted,
  reportName,
  Refusal,
  SKILL_FILE,
  textSize,
  unsorted,
  type DraftFile,
  type Evidence,
  type Feedback,
  type Judgment,
  type PendingRevision,
  type Skill,
  type SkillFile,
} from "./domain.ts";
import type { Case, Decision, Judge } from "./judge.ts";
import { Library } from "./library.ts";
import { Store } from "./store.ts";

export interface SkillSummary {
  name: string;
  description: string;
  version: number;
  chars: number;
  /** The most text it may hold: its own limit, or the library's default. */
  limit: number;
  /** Feedback on the current version. */
  feedback: number;
  /** Feedback no revision has considered yet. */
  waiting: number;
  /** Whether a revision from feedback waits for an admin's approval before it is kept. */
  protected: boolean;
  /** Whether a revision of it is waiting for an admin now. */
  pending: boolean;
  updatedAt: string;
}

export interface SearchResult extends SkillSummary {
  /** Where the query matched, the match in «». */
  snippet: string;
}

/** What happens next to a piece of feedback, so the agent that sent it is told the truth. */
export type Next =
  | { kind: "revising" }
  | { kind: "admin" }
  | { kind: "protected" }
  | { kind: "off" };

export interface HubOptions {
  /** The hard cap on a skill's text, all its files together. */
  maxChars?: number;
  /** Add the starter skills on first run, and honed/honer whenever it is missing (default true); false adds nothing, for tests. */
  starters?: boolean;
  log?: (line: string) => void;
}

const ANONYMOUS = "an unnamed agent";

/** What an agent sends: a report on a skill (quote, evidence, what changed), or a request for a new one (text and a draft). */
export interface FeedbackInput {
  skill: string;
  quote?: string;
  evidence?: { path?: string; content?: string; command?: string; output?: string }[];
  whatChanged?: string;
  text?: string;
  files?: DraftFile[];
  author?: string;
}

/** Evidence as a report must carry it: each piece a file with its current contents, or a command with what it printed. */
function checkEvidence(items: NonNullable<FeedbackInput["evidence"]>): Evidence[] {
  if (items.length === 0) {
    throw new Refusal("a report needs evidence: a file path with the file's current contents, or a command you ran with what it actually printed");
  }
  if (items.length > MAX_EVIDENCE_ITEMS) throw new Refusal(`a report carries at most ${MAX_EVIDENCE_ITEMS} pieces of evidence: keep the ones that show the quote is wrong`);
  const out = items.map((e): Evidence => {
    const path = e.path?.trim();
    const command = e.command?.trim();
    if (path && command) throw new Refusal("each piece of evidence is either a file (path and content) or a command (command and output), not both");
    if (path) {
      if (!e.content?.trim()) throw new Refusal(`evidence on ${path} needs content: include the file's current contents, or the part that shows the quote is wrong`);
      return { path, content: e.content };
    }
    if (command) {
      if (!e.output?.trim()) throw new Refusal(`evidence from \`${command}\` needs output: include what the command actually printed`);
      return { command, output: e.output };
    }
    throw new Refusal("each piece of evidence needs a path and the file's current contents, or a command and what it actually printed");
  });
  const size = out.reduce((n, e) => n + ("content" in e ? e.content.length : e.output.length), 0);
  if (size > MAX_EVIDENCE) throw new Refusal(`the evidence holds ${size} characters, over ${MAX_EVIDENCE}: keep only the lines that show the quote is wrong`);
  return out;
}
const STARTERS = fileURLToPath(new URL("./starters/", import.meta.url));

/** A starter's files, read from the folder shipped with honed. */
async function readStarter(name: string): Promise<SkillFile[]> {
  const root = join(STARTERS, name);
  const files: SkillFile[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.push({ path: relative(root, path), content: await readFile(path, "utf8"), executable: ((await stat(path)).mode & 0o111) !== 0 });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every starter shipped with honed: each folder holding a SKILL.md, named by its path, prefix included. */
async function starterNames(): Promise<string[]> {
  const entries = await readdir(STARTERS, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name === SKILL_FILE)
    .map((e) => relative(STARTERS, e.parentPath).split("\\").join("/"))
    .sort();
}

/** A SKILL.md without its frontmatter. */
const body = (skillMd: string) => skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

/** The skills, the feedback on them, and the judge that turns one into the next version of the other. */
export class Hub {
  readonly store: Store;
  readonly library: Library;
  readonly maxChars: number;
  private judge: Judge | null;
  private log: (line: string) => void;
  private descriptions = new Map<string, string>();
  private sizes = new Map<string, number>();
  private running = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(store: Store, library: Library, judge: Judge | null, opts: HubOptions) {
    this.store = store;
    this.library = library;
    this.judge = judge;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.log = opts.log ?? (() => {});
  }

  static async open(dir: string, judge: Judge | null, opts: HubOptions = {}): Promise<Hub> {
    await mkdir(dir, { recursive: true });
    const library = new Library(join(dir, "skills"));
    await library.init();
    const hub = new Hub(new Store(join(dir, "honed.db")), library, judge, opts);
    hub.store.failAbandoned(now());
    await hub.seed(opts.starters ?? true);
    for (const s of hub.store.skills()) hub.remember(s.name, await hub.files(s.name, s.version));
    for (const name of new Set(hub.store.waiting().map((f) => f.skill))) hub.schedule(name);
    return hub;
  }

  close() {
    this.store.close();
  }

  /** Adds the starters the first time honed runs on a library, and honed/honer whenever it is missing. */
  private async seed(starters: boolean): Promise<void> {
    if (!starters) return;
    const names = this.store.meta("seeded") ? [HONER_SKILL] : await starterNames();
    for (const name of names) {
      if (this.store.skill(name)) continue;
      const files = await readStarter(name);
      checkSkill(name, files, this.maxChars);
      const j = this.started(name, "starter");
      j.reasoning = "A starter skill that ships with honed.";
      j.version = await this.commit(name, files, "Shipped with honed", j);
      this.finish(j, true, []);
    }
    this.store.setMeta("seeded", now());
  }

  /** A skill's current SKILL.md without its frontmatter, or "" if it has none. */
  private async bodyOf(name: string): Promise<string> {
    return body((await this.current(name)).find((f) => f.path === SKILL_FILE)?.content ?? "");
  }

  /** The honer's guidance: honed/honer's current SKILL.md, without its frontmatter. */
  guidance(): Promise<string> {
    return this.bodyOf(HONER_SKILL);
  }

  /** One write at a time, so each version is made from the version it read. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Keeps what listing would otherwise read from git each time: description, size, and the search index's entry. */
  private remember(name: string, files: SkillFile[]): void {
    const description = frontmatter(files.find((f) => f.path === SKILL_FILE)?.content ?? "").description ?? "";
    this.descriptions.set(name, description);
    this.sizes.set(name, textSize(files));
    this.store.index(name, description, files.map((f) => f.content).join("\n\n"));
  }

  // Reading

  private summary(s: Skill): SkillSummary {
    return {
      name: s.name,
      description: this.descriptions.get(s.name) ?? "",
      version: s.version,
      chars: this.sizes.get(s.name) ?? 0,
      limit: s.maxChars ?? this.maxChars,
      feedback: this.store.feedbackCount(s.name, s.version),
      waiting: this.store.waiting(s.name).length,
      protected: s.protected,
      pending: this.store.pending(s.name) !== undefined,
      updatedAt: this.store.version(s.name, s.version)?.at ?? s.createdAt,
    };
  }

  /** Every skill, or those under `prefixes`. */
  list(prefixes?: string[]): SkillSummary[] {
    return this.store.skills().filter((s) => !prefixes || prefixes.includes(prefixOf(s.name))).map((s) => this.summary(s));
  }

  /** Skills whose name, description or text match any word of `query`, best match first; only those under `prefixes`, if given. */
  search(query: string, limit = 10, prefixes?: string[]): SearchResult[] {
    return this.store.search(query, limit, prefixes).flatMap((hit) => {
      const skill = this.store.skill(hit.name);
      return skill ? [{ ...this.summary(skill), snippet: hit.snippet }] : [];
    });
  }

  skill(name: string): Skill {
    const skill = this.store.skill(name);
    if (!skill) throw new Refusal(`no skill is named ${name}`, 404);
    return skill;
  }

  /** A skill's files at `version`; none at version 0, before it existed. */
  async files(name: string, version: number): Promise<SkillFile[]> {
    if (version === 0) return [];
    const v = this.store.version(name, version);
    if (!v) throw new Refusal(`${name} has no version ${version}`, 404);
    return this.library.files(name, v.commit);
  }

  async current(name: string): Promise<SkillFile[]> {
    const skill = this.store.skill(name);
    return skill ? this.files(name, skill.version) : [];
  }

  judgment(id: string): Judgment {
    const j = this.store.judgment(id);
    if (!j) throw new Refusal(`no judgment has id ${id}`, 404);
    return j;
  }

  isJudging(name: string): boolean {
    return this.running.has(name);
  }

  /** Resolves once no judgment is running. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  // Feedback

  /**
   * A report on a skill, or a request for one that does not exist yet. A report quotes the skill's text it is about,
   * shows the evidence and says what the agent did instead; each is checked here, so the agent hears at once how to fix
   * a report and the judge reads only ones that hold. A draft is checked against the cap now too.
   */
  async submitFeedback(input: FeedbackInput): Promise<{ feedback: Feedback; next: Next }> {
    const name = checkName(input.skill);
    const text = (input.text ?? "").trim();
    const draft = checkDraft(input.files ?? []);
    const current = await this.current(name);
    const exists = this.store.skill(name) !== undefined;
    let quote: string | null = null;
    let evidence: Evidence[] = [];
    let whatChanged: string | null = null;
    if (exists) {
      quote = (input.quote ?? "").trim();
      if (!quote) throw new Refusal(`a report on ${name} needs quote: the exact text in the skill that is wrong or out of date, copied from get_skill`);
      if (quote.length < MIN_QUOTE) throw new Refusal(`"${quote}" is too short to say which text is wrong: quote the whole sentence or line from ${name}`);
      if (!quoted(quote, current)) throw new Refusal(`this text is not in ${name} as it is now (v${this.store.skill(name)!.version}); get_skill it again and quote it exactly: "${quote.slice(0, 200)}"`);
      evidence = checkEvidence(input.evidence ?? []);
      whatChanged = (input.whatChanged ?? "").trim();
      if (!whatChanged) throw new Refusal("a report needs what_changed: what you did instead of what the quoted text says, or what you changed that it describes");
    } else if (!text) {
      throw new Refusal(`no skill is named ${name} yet: to ask for it, say in feedback what it is for, and draft its ${SKILL_FILE} following ${WRITING_SKILL}`);
    }
    if (draft.length) {
      const size = textSize(applyFiles(current, draft));
      const limit = this.limit(name);
      if (size > limit) throw new Refusal(`with your draft the skill would hold ${size} characters, over the cap of ${limit}: condense it`);
    }
    const f: Feedback = {
      id: newId(),
      skill: name,
      version: this.store.skill(name)?.version ?? 0,
      text,
      quote,
      evidence,
      whatChanged,
      draft,
      author: input.author?.trim() || ANONYMOUS,
      at: now(),
      ...unsorted,
    };
    this.store.addFeedback(f);
    this.schedule(name);
    return { feedback: f, next: this.next(name, draft.length > 0) };
  }

  private next(name: string, drafted: boolean): Next {
    if (!this.judge) return { kind: "off" };
    if (name === HONER_SKILL) return { kind: "admin" };
    if (this.store.skill(name)?.protected) return { kind: "protected" };
    return { kind: "revising" };
  }

  // What a person does

  revert(name: string, to: number, reason: string, actor = "you"): Promise<Judgment> {
    return this.exclusive(async () => {
      const skill = this.skill(name);
      if (!Number.isInteger(to) || to < 1 || to >= skill.version) throw new Refusal(`${name} can be reverted to a version from 1 to ${skill.version - 1}`);
      const files = await this.files(name, to);
      checkSkill(name, files, this.limit(name), textSize(await this.current(name)));
      const j = this.started(name, "person", actor);
      j.reasoning = reason.trim() || `Reverted to version ${to}.`;
      j.version = await this.commit(name, files, `Revert to version ${to}`, j);
      this.finish(j, true, []);
      return j;
    });
  }

  /** What a person's change would do to a skill, as a diff, refused as `edit` would refuse it. Changes nothing. */
  async preview(name: string, change: { write?: DraftFile[]; remove?: string[] }): Promise<string> {
    this.skill(name);
    const before = await this.current(name);
    const writes = (change.write ?? []).map((w) => ({ ...w, executable: w.executable ?? before.find((f) => f.path === w.path)?.executable ?? false }));
    const after = applyFiles(before, writes, change.remove ?? []);
    checkSkill(name, after, this.limit(name), textSize(before));
    return this.library.compare(before, after);
  }

  /** A person's change to a skill's files, kept as a version like any other. */
  edit(name: string, change: { write?: DraftFile[]; remove?: string[] }, reason: string, actor = "you"): Promise<Judgment> {
    return this.exclusive(async () => {
      this.skill(name);
      const before = await this.current(name);
      // A file edited in a text box keeps its executable bit unless told otherwise.
      const writes = (change.write ?? []).map((w) => ({ ...w, executable: w.executable ?? before.find((f) => f.path === w.path)?.executable ?? false }));
      const files = applyFiles(before, writes, change.remove ?? []);
      checkSkill(name, files, this.limit(name), textSize(before));
      const j = this.started(name, "person", actor);
      const what = [...(change.write ?? []).map((f) => f.path), ...(change.remove ?? []).map((p) => `${p} removed`)].join(", ");
      j.reasoning = reason.trim() || `Edited ${what}.`;
      j.version = await this.commit(name, files, `Edited by hand: ${what}`, j);
      this.finish(j, true, []);
      return j;
    });
  }

  /** Takes a skill out of the library and search. Its history stays in git and its feedback on record; waiting feedback is closed by the deletion, so it cannot bring the skill back. */
  delete(name: string, reason: string, actor = "you"): Promise<Judgment> {
    return this.exclusive(async () => {
      if (name === HONER_SKILL) throw new Refusal(`${HONER_SKILL} is how honed revises every skill, so it cannot be deleted; revert or edit it instead`, 409);
      const skill = this.skill(name);
      const j = this.started(name, "person", actor);
      j.reasoning = reason.trim() || `Deleted at version ${skill.version}.`;
      await this.library.remove(name, `${name}: deleted\n\nJudgment: ${j.id}`);
      const held = this.store.pending(name);
      this.store.transaction(() => {
        this.store.deleteSkill(name);
        this.store.unindex(name);
        if (held) this.decide(this.judgment(held.judgment), held, false, "The skill was deleted.", actor);
      });
      this.descriptions.delete(name);
      this.sizes.delete(name);
      this.finish(j, true, this.store.waiting(name).map((f) => f.id));
      return j;
    });
  }

  /** The most text a skill may hold: the limit an admin set on it, or the library's default. */
  limit(name: string): number {
    return this.store.skill(name)?.maxChars ?? this.maxChars;
  }

  /** An admin's limit on one skill's text, or null to use the library's default. It applies to every change from now on; text already over it may only shrink. */
  setLimit(name: string, maxChars: number | null): Skill {
    this.skill(name);
    if (maxChars !== null && (!Number.isInteger(maxChars) || maxChars < 1)) throw new Refusal("a limit is a whole number of characters, at least 1; leave it empty for the library's default");
    this.store.setMaxChars(name, maxChars);
    return this.skill(name);
  }

  /**
   * An admin's flag on a skill: while it is set, a revision the honer makes from feedback is held for an admin to approve
   * or decline, and agents go on reading the current version. An admin's own edits and reverts apply at once.
   */
  setProtected(name: string, value: boolean): Skill {
    this.skill(name);
    this.store.setProtected(name, value);
    if (!value) this.schedule(name);
    return this.skill(name);
  }

  /** The revision of a skill held for an admin, if one is. */
  pending(name: string): PendingRevision | undefined {
    return this.store.pending(name);
  }

  /** Keeps a held revision as the skill's next version, if the skill is still the version it was made from. */
  approve(name: string, reason: string, actor = "you"): Promise<Judgment> {
    return this.exclusive(async () => {
      const skill = this.skill(name);
      const held = this.held(name);
      if (held.version !== skill.version) {
        throw new Refusal(`${name} changed since this revision was made from v${held.version} (it is v${skill.version} now), so it cannot be kept as it is: decline it, and the honer revises the current version when feedback calls for it`, 409);
      }
      checkSkill(name, held.files, this.limit(name), textSize(await this.current(name)));
      const j = this.judgment(held.judgment);
      j.version = await this.commit(name, held.files, held.note, j);
      this.store.transaction(() => this.decide(j, held, true, reason, actor));
      this.schedule(name);
      return j;
    });
  }

  /** Discards a held revision: the skill stays as it is, and the decision is kept in its history. */
  decline(name: string, reason: string, actor = "you"): Promise<Judgment> {
    return this.exclusive(async () => {
      this.skill(name);
      const held = this.held(name);
      const j = this.judgment(held.judgment);
      this.store.transaction(() => this.decide(j, held, false, reason, actor));
      this.schedule(name);
      return j;
    });
  }

  private held(name: string): PendingRevision {
    const held = this.store.pending(name);
    if (!held) throw new Refusal(`no revision of ${name} is waiting for approval`, 404);
    return held;
  }

  private decide(j: Judgment, held: PendingRevision, approved: boolean, reason: string, actor: string): void {
    Object.assign(j, { state: "done", finishedAt: now(), changed: approved, review: { by: actor, approved, reason: reason.trim(), at: now() } });
    this.store.putJudgment(j);
    this.store.closePending(held.judgment);
  }

  /** Has the judge look at a skill now, whatever feedback is waiting. */
  judgeNow(name: string): void {
    if (!this.judge) throw new Refusal("this server was started without a judge", 409);
    this.skill(name);
    this.schedule(name, true);
  }

  // Judging

  private started(skill: string, by: Judgment["by"], actor: string | null = null): Judgment {
    const j: Judgment = { id: newId(), skill, by, actor, state: "running", startedAt: now(), finishedAt: null, changed: null, reasoning: "", error: null, version: null, review: null };
    this.store.putJudgment(j);
    return j;
  }

  private async commit(name: string, files: SkillFile[], note: string, j: Judgment): Promise<number> {
    const existing = this.store.skill(name);
    const version = this.store.lastVersion(name) + 1;
    const commit = await this.library.commit(name, files, `${name} v${version}: ${note}\n\nJudgment: ${j.id}`);
    this.store.transaction(() => {
      this.store.putSkill({ name, version, createdAt: existing?.createdAt ?? now() });
      this.store.addVersion({ skill: name, version, commit, note, judgment: j.id, at: now() });
    });
    this.remember(name, files);
    return version;
  }

  /** A protected skill's revision, held for an admin instead of kept: the feedback is considered, the skill unchanged until approval. */
  private hold(c: Case, j: Judgment, change: { files: SkillFile[]; note: string }, feedback: string[]): void {
    this.store.transaction(() => {
      this.store.addPending({ judgment: j.id, skill: c.skill, version: c.version, note: change.note, files: change.files, at: now() });
      this.store.consider(feedback, j.id);
      Object.assign(j, { state: "pending", finishedAt: now() });
      this.store.putJudgment(j);
    });
    this.log(`${c.skill} is protected: its revision waits for an admin's approval`);
  }

  private finish(j: Judgment, changed: boolean, feedback: string[]): void {
    this.store.transaction(() => {
      this.store.consider(feedback, j.id);
      Object.assign(j, { state: "done", finishedAt: now(), changed });
      this.store.putJudgment(j);
    });
  }

  /** Asks for a judgment on a skill when its feedback calls for one; one at a time per skill. */
  schedule(name: string, force = false): void {
    if (!this.judge) return;
    // The honer does not revise its own guidance on its own: feedback on it waits for an admin.
    if (name === HONER_SKILL && !force) return;
    // A protected skill is revised again only once an admin has decided on the revision it holds.
    if (this.store.pending(name)) return;
    if (this.running.has(name)) {
      this.dirty.add(name);
      return;
    }
    const run = this.judgeSkill(name, force)
      .catch((e) => this.log(`judging ${name} failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.running.delete(name);
        if (this.dirty.delete(name)) this.schedule(name);
      });
    this.running.set(name, run);
  }

  /** Feedback not yet sorted is judged at once; an admin's ask judges a skill whatever is waiting. */
  private due(c: Case, force: boolean): boolean {
    if (force) return c.files.length > 0;
    return c.feedback.length > 0;
  }

  /** The other skills the judge checks for overlap: all of them in a small library, else the closest by text. */
  private neighbours(name: string): { name: string; description: string }[] {
    const all = this.list().filter((s) => s.name !== name);
    const near = all.length <= 30 ? all : this.search(`${name.replace(/[-/]/g, " ")} ${this.descriptions.get(name) ?? ""}`, 31).filter((s) => s.name !== name).slice(0, 30);
    return near.map((s) => ({ name: s.name, description: s.description }));
  }

  /** The case for a skill: its unsorted feedback, or, when an admin asks, everything waiting, held reports included. */
  private async gather(name: string, failure: string | null, approved = false): Promise<Case> {
    const version = this.store.skill(name)?.version ?? 0;
    return {
      skill: name,
      version,
      maxChars: this.limit(name),
      files: await this.files(name, version),
      others: this.neighbours(name),
      feedback: approved ? this.store.waiting(name) : this.store.unsorted(name),
      approved,
      precedent: this.store
        .judgments(name, PRECEDENT * 2)
        .filter((j) => j.state === "done" && j.by === "judge")
        .slice(0, PRECEDENT)
        .map((j) => ({ ...j, feedback: this.store.feedbackOf(j.id) })),
      failure,
      guidance: await this.guidance(),
      writingGuide: version === 0 ? await this.bodyOf(WRITING_SKILL) || null : null,
    };
  }

  private async judgeSkill(name: string, force: boolean): Promise<void> {
    let failure: string | null = null;
    for (let attempt = 1; attempt <= JUDGMENT_ATTEMPTS; attempt++) {
      const c = await this.gather(name, failure, force);
      if (!this.due(c, force)) return;
      const j = this.started(name, "judge");
      this.log(`honing ${name}${attempt > 1 ? ` (attempt ${attempt})` : ""}…`);
      try {
        const decision = await this.judge!.decide(c);
        await this.exclusive(() => this.apply(c, j, decision));
        if (j.state !== "pending") this.log(j.changed ? `${name} honed → v${j.version}: ${decision.note.trim() || "changed from feedback"}` : `${name} unchanged: the feedback is kept for next time`);
        return;
      } catch (e) {
        Object.assign(j, { state: "failed", finishedAt: now(), error: e instanceof Error ? e.message : String(e) });
        this.store.putJudgment(j);
        this.log(`${name} could not be revised: ${j.error}`);
        if (e instanceof Outdated) {
          this.dirty.add(name);
          return;
        }
        failure = j.error;
      }
    }
  }

  /**
   * The judge's revert: the skill's files at `revert_to`, as a new version. Its reasoning names the reports behind each
   * version it undoes and the reports that contradicted them, so the history says which report undid which.
   */
  private async revertFor(c: Case, j: Judgment, d: Decision): Promise<{ files: SkillFile[]; note: string }> {
    const to = d.revert_to;
    if (!d.changed) throw new Refusal("revert_to restores an earlier version, a change: set changed true, or revert_to 0");
    if (d.edits.length || d.write.length || d.remove.length) throw new Refusal("revert_to restores an earlier version whole: leave edits, write and remove empty, or revert_to 0 and edit");
    if (!Number.isInteger(to) || to < 1 || to >= c.version) throw new Refusal(`revert_to must be a version from 1 to ${c.version - 1}, or 0`);
    const files = await this.files(c.skill, to);
    checkSkill(c.skill, files, c.maxChars, textSize(c.files));
    const undone = this.store
      .versions(c.skill)
      .filter((v) => v.version > to)
      .flatMap((v) => this.store.feedbackOf(v.judgment).map((f) => `${reportName(f)} (v${v.version})`));
    const by = c.feedback.map(reportName);
    j.reasoning = [d.reasoning.trim(), `Reverts to v${to}, undoing ${undone.join(", ") || "changes made without a report"}; contradicted by ${by.join(", ") || "no new report"}.`].filter(Boolean).join("\n\n");
    return { files, note: d.note.trim() || `Revert to version ${to}` };
  }

  /** Makes a decision so, if the skill is still the version it was made on and the result is a skill honed can keep. */
  private async apply(c: Case, j: Judgment, d: Decision): Promise<void> {
    if ((this.store.skill(c.skill)?.version ?? 0) !== c.version) throw new Outdated(`${c.skill} changed while the judge was deciding`);
    const sorts = checkSorts(c, d);
    j.reasoning = d.reasoning;
    let change: { files: SkillFile[]; note: string } | null = null;
    if (d.revert_to !== 0) {
      change = await this.revertFor(c, j, d);
    } else if (d.changed) {
      if (d.edits.length === 0 && d.write.length === 0 && d.remove.length === 0) throw new Error("the judge said it changed the skill but edited, wrote and removed nothing");
      const files = applyFiles(applyEdits(c.files, d.edits), d.write, d.remove);
      checkSkill(c.skill, files, c.maxChars, textSize(c.files));
      change = { files, note: d.note.trim() || "Changed from feedback" };
    }
    const protect = change !== null && this.store.skill(c.skill)?.protected === true;
    if (change && protect && sameFiles(c.files, change.files)) throw new Refusal("the change leaves the skill as it is", 409);
    if (change && !protect) j.version = await this.commit(c.skill, change.files, change.note, j);
    // A judgment report stays waiting, unless an admin asked: that is the agreement it waits for.
    const held = c.approved ? [] : c.feedback.filter((f) => sorts.get(f.id)?.kind === "judgment");
    this.store.transaction(() => {
      for (const f of c.feedback) {
        const s = sorts.get(f.id);
        if (s) this.store.sortFeedback(f.id, s.kind, s.why, j.id);
      }
    });
    const considered = c.feedback.filter((f) => !held.includes(f)).map((f) => f.id);
    if (change && protect) this.hold(c, j, change, considered);
    else this.finish(j, d.changed, considered);
    // One level of self-review: the honer may give feedback on its guidance while revising any other skill, never while revising its guidance.
    const reflection = d.honer_feedback.trim();
    if (reflection && c.skill !== HONER_SKILL && this.store.skill(HONER_SKILL)) {
      this.store.addFeedback({
        id: newId(),
        skill: HONER_SKILL,
        version: this.store.skill(HONER_SKILL)!.version,
        text: reflection,
        quote: null,
        evidence: [],
        whatChanged: null,
        draft: [],
        author: `${HONER_AUTHOR} (revising ${c.skill})`,
        at: now(),
        ...unsorted,
      });
    }
  }
}

class Outdated extends Error {}

/**
 * How the judge sorted each report in the case, refusing a decision that leaves one unsorted, names one not in the
 * case, or revises an existing skill with no checkable report, unless an admin asked.
 */
function checkSorts(c: Case, d: Decision): Map<string, { kind: "checkable" | "judgment"; why: string }> {
  const byShort = new Map(c.feedback.map((f) => [f.id.slice(0, 8), f]));
  const sorts = new Map<string, { kind: "checkable" | "judgment"; why: string }>();
  for (const s of d.sorted) {
    const f = byShort.get(s.report.trim().slice(0, 8));
    if (!f) throw new Refusal(`sorted names report ${s.report}, which is not in this case: sort only the reports in <new_feedback>, by their id`);
    sorts.set(f.id, { kind: s.kind, why: s.why.trim() });
  }
  const reports = c.feedback.filter((f) => f.quote !== null);
  if (!c.approved) {
    const missing = reports.filter((f) => !sorts.has(f.id));
    if (missing.length) throw new Refusal(`sort every report as checkable or judgment, with why: ${missing.map((f) => f.id.slice(0, 8)).join(", ")} ${missing.length === 1 ? "is" : "are"} not sorted`);
    const changes = d.changed || d.revert_to !== 0;
    if (changes && c.files.length > 0 && reports.length > 0 && !reports.some((f) => sorts.get(f.id)?.kind === "checkable")) {
      throw new Refusal("every report here is a judgment call, and a judgment call revises no skill on its own: it waits for separate sessions or an admin to agree. Leave the skill unchanged");
    }
  }
  return sorts;
}

/** Whether two sets of a skill's files are the same, path, text and executable bit. */
const sameFiles = (a: SkillFile[], b: SkillFile[]) => {
  const key = (files: SkillFile[]) => JSON.stringify([...files].sort((x, y) => x.path.localeCompare(y.path)).map((f) => [f.path, f.content, f.executable]));
  return key(a) === key(b);
};
