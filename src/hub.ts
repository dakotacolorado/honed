import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applyChange,
  checkChange,
  checkName,
  checkSkillFiles,
  FEEDBACK_BATCH,
  frontmatter,
  JUDGMENT_ATTEMPTS,
  newId,
  now,
  PRECEDENT,
  Refusal,
  SKILL_FILE,
  type Change,
  type Feedback,
  type Judgment,
  type Policy,
  type Proposal,
  type Ruler,
  type Skill,
  type SkillFile,
  type Verdict,
  type Vote,
} from "./domain.ts";
import type { Case, Decision, Judge } from "./judge.ts";
import { Library } from "./library.ts";
import { Store } from "./store.ts";

export interface SkillSummary {
  name: string;
  description: string;
  version: number;
  policy: Policy;
  openProposals: number;
  /** Feedback on the current version. */
  verdicts: Record<string, number>;
  updatedAt: string;
}

export interface HubOptions {
  feedbackBatch?: number;
  log?: (line: string) => void;
}

const ANONYMOUS = "an unnamed agent";

/** The library and everything said about it. Agents propose and judge rules; a person may override either. */
export class Hub {
  readonly store: Store;
  readonly library: Library;
  private judge: Judge | null;
  private feedbackBatch: number;
  private log: (line: string) => void;
  private descriptions = new Map<string, string>();
  private running = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(store: Store, library: Library, judge: Judge | null, opts: HubOptions) {
    this.store = store;
    this.library = library;
    this.judge = judge;
    this.feedbackBatch = opts.feedbackBatch ?? FEEDBACK_BATCH;
    this.log = opts.log ?? (() => {});
  }

  static async open(dir: string, judge: Judge | null, opts: HubOptions = {}): Promise<Hub> {
    await mkdir(dir, { recursive: true });
    const library = new Library(join(dir, "skills"));
    await library.init();
    const hub = new Hub(new Store(join(dir, "honed.db")), library, judge, opts);
    hub.store.failAbandoned(now());
    for (const s of hub.store.skills()) hub.descriptions.set(s.name, frontmatter((await hub.fileAt(s.name, s.version, SKILL_FILE)) ?? "").description ?? "");
    const waiting = new Set([...hub.store.openProposals().map((p) => p.skill), ...hub.store.skills().map((s) => s.name)]);
    for (const name of waiting) hub.schedule(name);
    return hub;
  }

  close() {
    this.store.close();
  }

  /** One write at a time, so each decision is made against the version it read. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  // Reading

  list(query?: string): SkillSummary[] {
    const q = query?.toLowerCase().trim();
    const open = this.store.openProposals();
    return this.store
      .skills()
      .map((s) => ({
        name: s.name,
        description: this.descriptions.get(s.name) ?? "",
        version: s.version,
        policy: s.policy,
        openProposals: open.filter((p) => p.skill === s.name).length,
        verdicts: this.store.verdictCounts(s.name, s.version),
        updatedAt: this.store.version(s.name, s.version)?.at ?? s.createdAt,
      }))
      .filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q));
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

  private async fileAt(name: string, version: number, path: string): Promise<string | undefined> {
    return (await this.files(name, version)).find((f) => f.path === path)?.content;
  }

  async current(name: string): Promise<SkillFile[]> {
    const skill = this.store.skill(name);
    return skill ? this.files(name, skill.version) : [];
  }

  proposal(id: string): Proposal {
    const p = this.store.proposal(id);
    if (!p) throw new Refusal(`no proposal has id ${id}`, 404);
    return p;
  }

  /** What a proposal would change in the skill as it is now. */
  async proposalDiff(p: Proposal): Promise<string> {
    const before = await this.current(p.skill);
    try {
      return await this.library.compare(before, applyChange(before, p.change));
    } catch (e) {
      if (e instanceof Refusal) return `This proposal no longer applies to the current version: ${e.message}`;
      throw e;
    }
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

  // What agents do

  async propose(input: { skill: string; title: string; why: string; change: Change; author?: string }): Promise<Proposal> {
    const name = checkName(input.skill);
    const change = checkChange(input.change);
    if (!input.title.trim()) throw new Refusal("a proposal needs a title");
    if (!input.why.trim()) throw new Refusal("a proposal needs a why: what happened that it would have helped with");
    const proposal = await this.exclusive(async () => {
      const skill = this.store.skill(name);
      checkSkillFiles(name, applyChange(await this.current(name), change));
      const p: Proposal = {
        id: newId(),
        skill: name,
        baseVersion: skill?.version ?? 0,
        title: input.title.trim(),
        why: input.why.trim(),
        change,
        author: input.author?.trim() || ANONYMOUS,
        state: "open",
        createdAt: now(),
        decidedAt: null,
        judgment: null,
      };
      this.store.addProposal(p);
      return p;
    });
    this.schedule(name);
    return proposal;
  }

  async giveFeedback(input: { skill: string; verdict: Verdict; reason: string; version?: number; author?: string }): Promise<Feedback> {
    const skill = this.skill(input.skill);
    const version = input.version ?? skill.version;
    if (version < 1 || version > skill.version) throw new Refusal(`${skill.name} has no version ${version}`);
    if (!input.reason.trim()) throw new Refusal("feedback needs a reason: what happened when you used the skill");
    const f: Feedback = {
      id: newId(),
      skill: skill.name,
      version,
      verdict: input.verdict,
      reason: input.reason.trim(),
      author: input.author?.trim() || ANONYMOUS,
      at: now(),
      judgment: null,
    };
    this.store.addFeedback(f);
    this.schedule(skill.name);
    return f;
  }

  vote(input: { proposal: string; vote: Vote; reason: string; author?: string }): Proposal {
    const p = this.openProposal(input.proposal);
    if (!input.reason.trim()) throw new Refusal("a vote needs a reason: the judge weighs reasons, not counts");
    this.store.putVote({ proposal: p.id, vote: input.vote, reason: input.reason.trim(), author: input.author?.trim() || ANONYMOUS, at: now() });
    this.schedule(p.skill);
    return p;
  }

  comment(input: { proposal: string; body: string; author?: string }): Proposal {
    const p = this.openProposal(input.proposal);
    if (!input.body.trim()) throw new Refusal("a comment needs a body");
    this.store.addComment({ id: newId(), proposal: p.id, body: input.body.trim(), author: input.author?.trim() || ANONYMOUS, at: now() });
    this.schedule(p.skill);
    return p;
  }

  private openProposal(id: string): Proposal {
    const p = this.proposal(id);
    if (p.state !== "open") throw new Refusal(`proposal ${id} is ${p.state}, so it takes no more votes or comments`, 409);
    return p;
  }

  // What a person does

  merge(id: string, reason: string): Promise<Judgment> {
    return this.exclusive(async () => {
      const p = this.openProposal(id);
      const files = applyChange(await this.current(p.skill), p.change);
      checkSkillFiles(p.skill, files);
      const j = this.started(p.skill, "human", reason || "Merged by hand.");
      const version = await this.commit(p.skill, files, p.title, j);
      this.finish(j, "change", version, [{ id: p.id, ruling: "merged", reason: j.reasoning }], []);
      return j;
    });
  }

  reject(id: string, reason: string): Promise<Judgment> {
    return this.exclusive(async () => {
      const p = this.openProposal(id);
      const j = this.started(p.skill, "human", reason || "Rejected by hand.");
      this.finish(j, "no_change", null, [{ id: p.id, ruling: "rejected", reason: j.reasoning }], []);
      return j;
    });
  }

  revert(name: string, to: number, reason: string): Promise<Judgment> {
    return this.exclusive(async () => {
      const skill = this.skill(name);
      if (to < 1 || to >= skill.version) throw new Refusal(`${name} can be reverted to a version from 1 to ${skill.version - 1}`);
      const j = this.started(name, "human", reason || `Reverted to version ${to} by hand.`);
      const version = await this.commit(name, await this.files(name, to), `Revert to version ${to}`, j);
      this.finish(j, "change", version, [], []);
      return j;
    });
  }

  setPolicy(name: string, policy: Policy): Skill {
    const skill = { ...this.skill(name), policy };
    this.store.putSkill(skill);
    if (policy === "judge") this.schedule(name);
    return skill;
  }

  /** Starts a judgment now, whatever has or has not arrived. */
  judgeNow(name: string): void {
    if (!this.judge) throw new Refusal("this server was started without a judge", 409);
    if (this.store.skill(name)?.policy === "human") throw new Refusal(`${name} is ruled on by hand, not by the judge`, 409);
    this.schedule(name, true);
  }

  // Judging

  private started(skill: string, by: Ruler, reasoning: string): Judgment {
    const j: Judgment = { id: newId(), skill, by, state: "running", startedAt: now(), finishedAt: null, outcome: null, reasoning, error: null, version: null };
    this.store.putJudgment(j);
    return j;
  }

  private async commit(name: string, files: SkillFile[], note: string, j: Judgment): Promise<number> {
    const existing = this.store.skill(name);
    const version = (existing?.version ?? 0) + 1;
    const commit = await this.library.commit(name, files, `${name} v${version}: ${note}\n\nBy: ${j.by}\nJudgment: ${j.id}`);
    this.store.transaction(() => {
      this.store.putSkill({ name, policy: existing?.policy ?? "judge", version, createdAt: existing?.createdAt ?? now() });
      this.store.addVersion({ skill: name, version, commit, note, by: j.by, judgment: j.id, at: now() });
    });
    this.descriptions.set(name, frontmatter(files.find((f) => f.path === SKILL_FILE)?.content ?? "").description ?? "");
    return version;
  }

  private finish(j: Judgment, outcome: "change" | "no_change", version: number | null, rulings: Decision["proposals"], feedback: string[]): void {
    const at = now();
    this.store.transaction(() => {
      for (const r of rulings) {
        this.store.addRuling({ judgment: j.id, proposal: r.id, ruling: r.ruling, reason: r.reason });
        if (r.ruling !== "open") this.store.decideProposal(r.id, r.ruling, j.id, at);
      }
      this.store.considerFeedback(feedback, j.id);
      Object.assign(j, { state: "done", finishedAt: at, outcome, version });
      this.store.putJudgment(j);
    });
  }

  /** Asks for a judgment on a skill when there is something to rule on; one at a time per skill. */
  schedule(name: string, force = false): void {
    if (!this.judge || this.store.skill(name)?.policy === "human") return;
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

  private async gather(name: string): Promise<Case> {
    const skill = this.store.skill(name);
    const version = skill?.version ?? 0;
    return {
      skill: name,
      policy: skill?.policy ?? "judge",
      version,
      files: await this.files(name, version),
      others: this.list().filter((s) => s.name !== name).map((s) => ({ name: s.name, description: s.description })),
      proposals: this.store.proposals(name, "open").map((proposal) => ({
        proposal,
        votes: this.store.votes(proposal.id),
        comments: this.store.comments(proposal.id),
        rulings: this.store.rulingsOn(proposal.id),
      })),
      feedback: this.store.unconsidered(name),
      precedent: this.store.judgments(name, PRECEDENT * 2).filter((j) => j.state === "done").slice(0, PRECEDENT),
    };
  }

  private async judgeSkill(name: string, force: boolean): Promise<void> {
    for (let attempt = 1; attempt <= JUDGMENT_ATTEMPTS; attempt++) {
      const c = await this.gather(name);
      const due = c.proposals.length > 0 || c.feedback.length >= this.feedbackBatch || (force && c.files.length > 0);
      if (!due) return;
      const j = this.started(name, "judge", "");
      this.log(`judging ${name} (judgment ${j.id}, attempt ${attempt})`);
      try {
        const decision = await this.judge!.rule(c);
        await this.exclusive(() => this.apply(c, j, decision));
        this.log(`${name}: ${j.outcome}${j.version ? `, now version ${j.version}` : ""}`);
        return;
      } catch (e) {
        j.state = "failed";
        j.finishedAt = now();
        j.error = e instanceof Error ? e.message : String(e);
        this.store.putJudgment(j);
        this.log(`${name}: judgment ${j.id} failed: ${j.error}`);
        if (e instanceof Outdated) {
          this.dirty.add(name);
          return;
        }
      }
    }
  }

  /** Makes a decision so, if it still applies to the skill it was made on and keeps the rules a skill is held to. */
  private async apply(c: Case, j: Judgment, d: Decision): Promise<void> {
    if ((this.store.skill(c.skill)?.version ?? 0) !== c.version) throw new Outdated(`${c.skill} changed while the judge was ruling`);
    const open = new Set(c.proposals.map((p) => p.proposal.id));
    const rulings = d.proposals.filter((r) => open.has(r.id) && this.store.proposal(r.id)?.state === "open");
    if (d.outcome === "no_change" && rulings.some((r) => r.ruling === "merged")) throw new Error("the judge merged a proposal but made no change");
    j.reasoning = d.reasoning;
    let version: number | null = null;
    if (d.outcome === "change") {
      const files = applyChange(c.files, checkChange({ write: d.change.write, remove: d.change.remove }));
      checkSkillFiles(c.skill, files);
      version = await this.commit(c.skill, files, d.note.trim() || "Changed by the judge", j);
    }
    this.finish(j, d.outcome, version, rulings, c.feedback.map((f) => f.id));
  }
}

class Outdated extends Error {}
