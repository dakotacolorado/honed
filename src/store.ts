import { DatabaseSync } from "node:sqlite";
import type {
  Ballot,
  Change,
  Comment,
  Feedback,
  Judgment,
  Policy,
  Proposal,
  ProposalRuling,
  ProposalState,
  Skill,
  Version,
} from "./domain.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY, policy TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  skill TEXT NOT NULL, version INTEGER NOT NULL, commit_id TEXT NOT NULL, note TEXT NOT NULL,
  by TEXT NOT NULL, judgment TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (skill, version)
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, skill TEXT NOT NULL, base_version INTEGER NOT NULL, title TEXT NOT NULL, why TEXT NOT NULL,
  change TEXT NOT NULL, author TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
  decided_at TEXT, judgment TEXT
);
CREATE INDEX IF NOT EXISTS proposals_by_skill ON proposals (skill, state);
CREATE TABLE IF NOT EXISTS votes (
  proposal TEXT NOT NULL, author TEXT NOT NULL, vote TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (proposal, author)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, proposal TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY, skill TEXT NOT NULL, version INTEGER NOT NULL, verdict TEXT NOT NULL, reason TEXT NOT NULL,
  author TEXT NOT NULL, at TEXT NOT NULL, judgment TEXT
);
CREATE INDEX IF NOT EXISTS feedback_by_skill ON feedback (skill, judgment);
CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY, skill TEXT NOT NULL, by TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, outcome TEXT, reasoning TEXT NOT NULL, error TEXT, version INTEGER
);
CREATE INDEX IF NOT EXISTS judgments_by_skill ON judgments (skill, started_at);
CREATE TABLE IF NOT EXISTS rulings (
  judgment TEXT NOT NULL, proposal TEXT NOT NULL, ruling TEXT NOT NULL, reason TEXT NOT NULL,
  PRIMARY KEY (judgment, proposal)
);
`;

type Row = Record<string, unknown>;
const s = (v: unknown) => v as string;
const n = (v: unknown) => Number(v);
const sn = (v: unknown) => (v === null || v === undefined ? null : String(v));
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const skill = (r: Row): Skill => ({ name: s(r.name), policy: s(r.policy) as Policy, version: n(r.version), createdAt: s(r.created_at) });
const version = (r: Row): Version => ({
  skill: s(r.skill),
  version: n(r.version),
  commit: s(r.commit_id),
  note: s(r.note),
  by: s(r.by) as Version["by"],
  judgment: s(r.judgment),
  at: s(r.at),
});
const proposal = (r: Row): Proposal => ({
  id: s(r.id),
  skill: s(r.skill),
  baseVersion: n(r.base_version),
  title: s(r.title),
  why: s(r.why),
  change: JSON.parse(s(r.change)) as Change,
  author: s(r.author),
  state: s(r.state) as ProposalState,
  createdAt: s(r.created_at),
  decidedAt: sn(r.decided_at),
  judgment: sn(r.judgment),
});
const ballot = (r: Row): Ballot => ({ proposal: s(r.proposal), vote: s(r.vote) as Ballot["vote"], reason: s(r.reason), author: s(r.author), at: s(r.at) });
const comment = (r: Row): Comment => ({ id: s(r.id), proposal: s(r.proposal), body: s(r.body), author: s(r.author), at: s(r.at) });
const feedback = (r: Row): Feedback => ({
  id: s(r.id),
  skill: s(r.skill),
  version: n(r.version),
  verdict: s(r.verdict) as Feedback["verdict"],
  reason: s(r.reason),
  author: s(r.author),
  at: s(r.at),
  judgment: sn(r.judgment),
});
const judgment = (r: Row): Judgment => ({
  id: s(r.id),
  skill: s(r.skill),
  by: s(r.by) as Judgment["by"],
  state: s(r.state) as Judgment["state"],
  startedAt: s(r.started_at),
  finishedAt: sn(r.finished_at),
  outcome: sn(r.outcome) as Judgment["outcome"],
  reasoning: s(r.reasoning),
  error: sn(r.error),
  version: nn(r.version),
});
const ruling = (r: Row): ProposalRuling => ({ judgment: s(r.judgment), proposal: s(r.proposal), ruling: s(r.ruling) as ProposalState, reason: s(r.reason) });

/** Everything about the skills but their files: proposals, votes, comments, feedback, judgments and the versions they made. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  /** Runs `fn` in one transaction: all of its writes, or none. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params);
  }

  skills(): Skill[] {
    return this.all("SELECT * FROM skills ORDER BY name").map(skill);
  }
  skill(name: string): Skill | undefined {
    const r = this.get("SELECT * FROM skills WHERE name = ?", name);
    return r && skill(r);
  }
  putSkill(v: Skill): void {
    this.run(
      "INSERT INTO skills (name, policy, version, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET policy = excluded.policy, version = excluded.version",
      v.name,
      v.policy,
      v.version,
      v.createdAt,
    );
  }

  versions(name: string): Version[] {
    return this.all("SELECT * FROM versions WHERE skill = ? ORDER BY version DESC", name).map(version);
  }
  version(name: string, n: number): Version | undefined {
    const r = this.get("SELECT * FROM versions WHERE skill = ? AND version = ?", name, n);
    return r && version(r);
  }
  addVersion(v: Version): void {
    this.run(
      "INSERT INTO versions (skill, version, commit_id, note, by, judgment, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      v.skill,
      v.version,
      v.commit,
      v.note,
      v.by,
      v.judgment,
      v.at,
    );
  }

  proposals(name: string, state?: ProposalState): Proposal[] {
    return state
      ? this.all("SELECT * FROM proposals WHERE skill = ? AND state = ? ORDER BY created_at", name, state).map(proposal)
      : this.all("SELECT * FROM proposals WHERE skill = ? ORDER BY created_at DESC", name).map(proposal);
  }
  openProposals(): Proposal[] {
    return this.all("SELECT * FROM proposals WHERE state = 'open' ORDER BY created_at").map(proposal);
  }
  proposal(id: string): Proposal | undefined {
    const r = this.get("SELECT * FROM proposals WHERE id = ?", id);
    return r && proposal(r);
  }
  addProposal(p: Proposal): void {
    this.run(
      "INSERT INTO proposals (id, skill, base_version, title, why, change, author, state, created_at, decided_at, judgment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      p.id,
      p.skill,
      p.baseVersion,
      p.title,
      p.why,
      JSON.stringify(p.change),
      p.author,
      p.state,
      p.createdAt,
      p.decidedAt,
      p.judgment,
    );
  }
  decideProposal(id: string, state: ProposalState, judgment: string, at: string): void {
    this.run("UPDATE proposals SET state = ?, judgment = ?, decided_at = ? WHERE id = ? AND state = 'open'", state, judgment, at, id);
  }

  votes(proposal: string): Ballot[] {
    return this.all("SELECT * FROM votes WHERE proposal = ? ORDER BY at", proposal).map(ballot);
  }
  /** One vote per author on a proposal: a second replaces the first. */
  putVote(b: Ballot): void {
    this.run(
      "INSERT INTO votes (proposal, author, vote, reason, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (proposal, author) DO UPDATE SET vote = excluded.vote, reason = excluded.reason, at = excluded.at",
      b.proposal,
      b.author,
      b.vote,
      b.reason,
      b.at,
    );
  }

  comments(proposal: string): Comment[] {
    return this.all("SELECT * FROM comments WHERE proposal = ? ORDER BY at", proposal).map(comment);
  }
  addComment(c: Comment): void {
    this.run("INSERT INTO comments (id, proposal, body, author, at) VALUES (?, ?, ?, ?, ?)", c.id, c.proposal, c.body, c.author, c.at);
  }

  feedback(name: string, limit = 100): Feedback[] {
    return this.all("SELECT * FROM feedback WHERE skill = ? ORDER BY at DESC LIMIT ?", name, limit).map(feedback);
  }
  unconsidered(name: string): Feedback[] {
    return this.all("SELECT * FROM feedback WHERE skill = ? AND judgment IS NULL ORDER BY at", name).map(feedback);
  }
  feedbackOf(judgment: string): Feedback[] {
    return this.all("SELECT * FROM feedback WHERE judgment = ? ORDER BY at", judgment).map(feedback);
  }
  addFeedback(f: Feedback): void {
    this.run(
      "INSERT INTO feedback (id, skill, version, verdict, reason, author, at, judgment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      f.id,
      f.skill,
      f.version,
      f.verdict,
      f.reason,
      f.author,
      f.at,
      f.judgment,
    );
  }
  considerFeedback(ids: string[], judgment: string): void {
    for (const id of ids) this.run("UPDATE feedback SET judgment = ? WHERE id = ? AND judgment IS NULL", judgment, id);
  }
  /** Each verdict's count on a skill since `version`, inclusive. */
  verdictCounts(name: string, sinceVersion: number): Record<string, number> {
    const out: Record<string, number> = { helped: 0, hurt: 0, missing: 0 };
    for (const r of this.all("SELECT verdict, COUNT(*) AS c FROM feedback WHERE skill = ? AND version >= ? GROUP BY verdict", name, sinceVersion)) {
      out[s(r.verdict)] = n(r.c);
    }
    return out;
  }

  judgments(name: string, limit = 50): Judgment[] {
    return this.all("SELECT * FROM judgments WHERE skill = ? ORDER BY started_at DESC LIMIT ?", name, limit).map(judgment);
  }
  recentJudgments(limit = 20): Judgment[] {
    return this.all("SELECT * FROM judgments ORDER BY started_at DESC LIMIT ?", limit).map(judgment);
  }
  judgment(id: string): Judgment | undefined {
    const r = this.get("SELECT * FROM judgments WHERE id = ?", id);
    return r && judgment(r);
  }
  putJudgment(j: Judgment): void {
    this.run(
      `INSERT INTO judgments (id, skill, by, state, started_at, finished_at, outcome, reasoning, error, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, finished_at = excluded.finished_at, outcome = excluded.outcome,
       reasoning = excluded.reasoning, error = excluded.error, version = excluded.version`,
      j.id,
      j.skill,
      j.by,
      j.state,
      j.startedAt,
      j.finishedAt,
      j.outcome,
      j.reasoning,
      j.error,
      j.version,
    );
  }
  /** Judgments left running by a server that stopped: they will never finish. */
  failAbandoned(at: string): void {
    this.run("UPDATE judgments SET state = 'failed', error = 'the server stopped before it finished', finished_at = ? WHERE state = 'running'", at);
  }

  rulingsOf(judgment: string): ProposalRuling[] {
    return this.all("SELECT * FROM rulings WHERE judgment = ?", judgment).map(ruling);
  }
  rulingsOn(proposal: string): ProposalRuling[] {
    return this.all(
      "SELECT r.* FROM rulings r JOIN judgments j ON j.id = r.judgment WHERE r.proposal = ? ORDER BY j.started_at",
      proposal,
    ).map(ruling);
  }
  addRuling(r: ProposalRuling): void {
    this.run("INSERT INTO rulings (judgment, proposal, ruling, reason) VALUES (?, ?, ?, ?)", r.judgment, r.proposal, r.ruling, r.reason);
  }
}
