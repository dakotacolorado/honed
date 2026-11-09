import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applyFiles,
  checkDraft,
  checkName,
  checkSkill,
  DEFAULT_MAX_CHARS,
  FEEDBACK_BATCH,
  frontmatter,
  JUDGMENT_ATTEMPTS,
  newId,
  now,
  PRECEDENT,
  Refusal,
  SKILL_FILE,
  textSize,
  type DraftFile,
  type Feedback,
  type Judgment,
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
  /** Feedback on the current version. */
  feedback: number;
  updatedAt: string;
}

export interface SearchResult extends SkillSummary {
  /** Where the query matched, the match in «». */
  snippet: string;
}

export interface HubOptions {
  /** The hard cap on a skill's text, all its files together. */
  maxChars?: number;
  log?: (line: string) => void;
}

const ANONYMOUS = "an unnamed agent";

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
    for (const s of hub.store.skills()) hub.remember(s.name, await hub.files(s.name, s.version));
    for (const name of new Set(hub.store.waiting().map((f) => f.skill))) hub.schedule(name);
    return hub;
  }

  close() {
    this.store.close();
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
      feedback: this.store.feedbackCount(s.name, s.version),
      updatedAt: this.store.version(s.name, s.version)?.at ?? s.createdAt,
    };
  }

  list(): SkillSummary[] {
    return this.store.skills().map((s) => this.summary(s));
  }

  /** Skills whose name, description or text match any word of `query`, best match first. */
  search(query: string, limit = 10): SearchResult[] {
    return this.store.search(query, limit).flatMap((hit) => {
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

  /** Feedback on a skill, or on one that does not exist yet, which asks for it. A draft is checked against the cap now, so an agent hears at once. */
  async submitFeedback(input: { skill: string; text: string; files?: DraftFile[]; author?: string }): Promise<Feedback> {
    const name = checkName(input.skill);
    const text = input.text.trim();
    if (!text) throw new Refusal("feedback needs text: what happened when you used the skill, and what should change");
    const draft = checkDraft(input.files ?? []);
    if (draft.length) {
      const size = textSize(applyFiles(await this.current(name), draft));
      if (size > this.maxChars) throw new Refusal(`with your draft the skill would hold ${size} characters, over the cap of ${this.maxChars}: condense it`);
    }
    const f: Feedback = {
      id: newId(),
      skill: name,
      version: this.store.skill(name)?.version ?? 0,
      text,
      draft,
      author: input.author?.trim() || ANONYMOUS,
      at: now(),
      judgment: null,
    };
    this.store.addFeedback(f);
    this.schedule(name);
    return f;
  }

  // What a person does

  revert(name: string, to: number, reason: string, actor = "you"): Promise<Judgment> {
    return this.exclusive(async () => {
      const skill = this.skill(name);
      if (!Number.isInteger(to) || to < 1 || to >= skill.version) throw new Refusal(`${name} can be reverted to a version from 1 to ${skill.version - 1}`);
      const files = await this.files(name, to);
      checkSkill(name, files, this.maxChars);
      const j = this.started(name, "person", actor);
      j.reasoning = reason.trim() || `Reverted to version ${to}.`;
      j.version = await this.commit(name, files, `Revert to version ${to}`, j);
      this.finish(j, true, []);
      return j;
    });
  }

  /** Has the judge look at a skill now, whatever feedback is waiting. */
  judgeNow(name: string): void {
    if (!this.judge) throw new Refusal("this server was started without a judge", 409);
    this.skill(name);
    this.schedule(name, true);
  }

  // Judging

  private started(skill: string, by: Judgment["by"], actor: string | null = null): Judgment {
    const j: Judgment = { id: newId(), skill, by, actor, state: "running", startedAt: now(), finishedAt: null, changed: null, reasoning: "", error: null, version: null };
    this.store.putJudgment(j);
    return j;
  }

  private async commit(name: string, files: SkillFile[], note: string, j: Judgment): Promise<number> {
    const existing = this.store.skill(name);
    const version = (existing?.version ?? 0) + 1;
    const commit = await this.library.commit(name, files, `${name} v${version}: ${note}\n\nJudgment: ${j.id}`);
    this.store.transaction(() => {
      this.store.putSkill({ name, version, createdAt: existing?.createdAt ?? now() });
      this.store.addVersion({ skill: name, version, commit, note, judgment: j.id, at: now() });
    });
    this.remember(name, files);
    return version;
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

  /** A draft, or a skill not yet made, is judged at once; plain feedback waits for a few more like it. */
  private due(c: Case, force: boolean): boolean {
    if (force) return c.files.length > 0;
    if (c.feedback.length === 0) return false;
    return c.files.length === 0 || c.feedback.some((f) => f.draft.length > 0) || c.feedback.length >= FEEDBACK_BATCH;
  }

  /** The other skills the judge checks for overlap: all of them in a small library, else the closest by text. */
  private neighbours(name: string): { name: string; description: string }[] {
    const all = this.list().filter((s) => s.name !== name);
    const near = all.length <= 30 ? all : this.search(`${name.replace(/-/g, " ")} ${this.descriptions.get(name) ?? ""}`, 31).filter((s) => s.name !== name).slice(0, 30);
    return near.map((s) => ({ name: s.name, description: s.description }));
  }

  private async gather(name: string, failure: string | null): Promise<Case> {
    const version = this.store.skill(name)?.version ?? 0;
    return {
      skill: name,
      version,
      maxChars: this.maxChars,
      files: await this.files(name, version),
      others: this.neighbours(name),
      feedback: this.store.waiting(name),
      precedent: this.store.judgments(name, PRECEDENT * 2).filter((j) => j.state === "done").slice(0, PRECEDENT),
      failure,
    };
  }

  private async judgeSkill(name: string, force: boolean): Promise<void> {
    let failure: string | null = null;
    for (let attempt = 1; attempt <= JUDGMENT_ATTEMPTS; attempt++) {
      const c = await this.gather(name, failure);
      if (!this.due(c, force)) return;
      const j = this.started(name, "judge");
      this.log(`judging ${name} (attempt ${attempt})`);
      try {
        const decision = await this.judge!.decide(c);
        await this.exclusive(() => this.apply(c, j, decision));
        this.log(`${name}: ${j.changed ? `now version ${j.version}` : "no change"}`);
        return;
      } catch (e) {
        Object.assign(j, { state: "failed", finishedAt: now(), error: e instanceof Error ? e.message : String(e) });
        this.store.putJudgment(j);
        this.log(`${name}: judgment failed: ${j.error}`);
        if (e instanceof Outdated) {
          this.dirty.add(name);
          return;
        }
        failure = j.error;
      }
    }
  }

  /** Makes a decision so, if the skill is still the version it was made on and the result is a skill honed can keep. */
  private async apply(c: Case, j: Judgment, d: Decision): Promise<void> {
    if ((this.store.skill(c.skill)?.version ?? 0) !== c.version) throw new Outdated(`${c.skill} changed while the judge was deciding`);
    j.reasoning = d.reasoning;
    if (d.changed) {
      if (d.write.length === 0 && d.remove.length === 0) throw new Error("the judge said it changed the skill but wrote and removed nothing");
      const files = applyFiles(c.files, d.write, d.remove);
      checkSkill(c.skill, files, this.maxChars);
      j.version = await this.commit(c.skill, files, d.note.trim() || "Changed from feedback", j);
    }
    this.finish(j, d.changed, c.feedback.map((f) => f.id));
  }
}

class Outdated extends Error {}
