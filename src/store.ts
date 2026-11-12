import { DatabaseSync } from "node:sqlite";
import type { DraftFile, Evidence, Feedback, Judgment, Skill, Version } from "./domain.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (
  skill TEXT NOT NULL, version INTEGER NOT NULL, commit_id TEXT NOT NULL, note TEXT NOT NULL,
  judgment TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (skill, version)
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY, skill TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, draft TEXT NOT NULL,
  author TEXT NOT NULL, at TEXT NOT NULL, judgment TEXT
);
CREATE INDEX IF NOT EXISTS feedback_by_skill ON feedback (skill, judgment);
CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY, skill TEXT NOT NULL, by TEXT NOT NULL, actor TEXT, state TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, changed INTEGER, reasoning TEXT NOT NULL, error TEXT, version INTEGER
);
CREATE INDEX IF NOT EXISTS judgments_by_skill ON judgments (skill, started_at);
CREATE TABLE IF NOT EXISTS tokens (name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, admin INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(name, description, body, tokenize = 'porter unicode61');
`;

/** Columns added since a table was first made, each added to a library made before it. */
const COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: "feedback", column: "quote", definition: "TEXT" },
  { table: "feedback", column: "evidence", definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "feedback", column: "what_changed", definition: "TEXT" },
  { table: "skills", column: "max_chars", definition: "INTEGER" },
];

export interface Token {
  name: string;
  admin: boolean;
  createdAt: string;
}

export interface Hit {
  name: string;
  snippet: string;
}

/** Words that say nothing about what a skill is for: matched, they make every skill a hit. */
const STOPWORDS = new Set(
  "a an and are as at be been but by can could did do does doing for from had has have how i i'm if in into is it its me my of on onto or our should so than that the their them then there these they this those to too use used using want was we were what when where which who why will with would you your".split(" "),
);

/** The FTS query for what someone typed: filler words dropped, short words matched whole, longer ones as prefixes, any of them. */
export function matchQuery(query: string): string | null {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}_']+/gu) ?? []).map((w) => w.replace(/'/g, "")).filter(Boolean);
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  const terms = [...new Set(meaningful.length ? meaningful : words)];
  if (terms.length === 0) return null;
  return terms.map((t) => (t.length >= 4 ? `"${t}"*` : `"${t}"`)).join(" OR ");
}

type Row = Record<string, unknown>;
type Param = string | number | null;
const s = (v: unknown) => v as string;
const n = (v: unknown) => Number(v);
const sn = (v: unknown) => (v === null || v === undefined ? null : String(v));
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const skill = (r: Row): Skill => ({ name: s(r.name), version: n(r.version), createdAt: s(r.created_at), maxChars: nn(r.max_chars) });
const version = (r: Row): Version => ({ skill: s(r.skill), version: n(r.version), commit: s(r.commit_id), note: s(r.note), judgment: s(r.judgment), at: s(r.at) });
const feedback = (r: Row): Feedback => ({
  id: s(r.id),
  skill: s(r.skill),
  version: n(r.version),
  text: s(r.text),
  quote: sn(r.quote),
  evidence: JSON.parse(s(r.evidence ?? "[]")) as Evidence[],
  whatChanged: sn(r.what_changed),
  draft: JSON.parse(s(r.draft)) as DraftFile[],
  author: s(r.author),
  at: s(r.at),
  judgment: sn(r.judgment),
});
const judgment = (r: Row): Judgment => ({
  id: s(r.id),
  skill: s(r.skill),
  by: s(r.by) as Judgment["by"],
  actor: sn(r.actor),
  state: s(r.state) as Judgment["state"],
  startedAt: s(r.started_at),
  finishedAt: sn(r.finished_at),
  changed: r.changed === null || r.changed === undefined ? null : n(r.changed) === 1,
  reasoning: s(r.reasoning),
  error: sn(r.error),
  version: nn(r.version),
});
const token = (r: Row): Token => ({ name: s(r.name), admin: n(r.admin) === 1, createdAt: s(r.created_at) });

/** Everything but the skills' files: their versions, the feedback on them, the judgments, the tokens and the search index. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    for (const { table, column, definition } of COLUMNS) {
      const has = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((r) => r.name === column);
      if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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

  private all(sql: string, ...params: Param[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: Param[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: Param[]): void {
    this.db.prepare(sql).run(...params);
  }

  skills(): Skill[] {
    return this.all("SELECT * FROM skills ORDER BY name").map(skill);
  }
  skill(name: string): Skill | undefined {
    const r = this.get("SELECT * FROM skills WHERE name = ?", name);
    return r && skill(r);
  }
  /** Makes a skill, or moves it to a new version; its limit stays as an admin set it. */
  putSkill(v: Omit<Skill, "maxChars">): void {
    this.run("INSERT INTO skills (name, version, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET version = excluded.version", v.name, v.version, v.createdAt);
  }
  setMaxChars(name: string, maxChars: number | null): void {
    this.run("UPDATE skills SET max_chars = ? WHERE name = ?", maxChars, name);
  }

  versions(name: string): Version[] {
    return this.all("SELECT * FROM versions WHERE skill = ? ORDER BY version DESC", name).map(version);
  }
  version(name: string, n: number): Version | undefined {
    const r = this.get("SELECT * FROM versions WHERE skill = ? AND version = ?", name, n);
    return r && version(r);
  }
  addVersion(v: Version): void {
    this.run("INSERT INTO versions (skill, version, commit_id, note, judgment, at) VALUES (?, ?, ?, ?, ?, ?)", v.skill, v.version, v.commit, v.note, v.judgment, v.at);
  }

  feedback(name: string, limit = 100): Feedback[] {
    return this.all("SELECT * FROM feedback WHERE skill = ? ORDER BY at DESC LIMIT ?", name, limit).map(feedback);
  }
  /** Feedback no judgment has considered, oldest first, on every skill or one. */
  waiting(name?: string): Feedback[] {
    return (name
      ? this.all("SELECT * FROM feedback WHERE judgment IS NULL AND skill = ? ORDER BY at", name)
      : this.all("SELECT * FROM feedback WHERE judgment IS NULL ORDER BY at")
    ).map(feedback);
  }
  feedbackOf(judgment: string): Feedback[] {
    return this.all("SELECT * FROM feedback WHERE judgment = ? ORDER BY at", judgment).map(feedback);
  }
  addFeedback(f: Feedback): void {
    this.run(
      "INSERT INTO feedback (id, skill, version, text, quote, evidence, what_changed, draft, author, at, judgment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      f.id,
      f.skill,
      f.version,
      f.text,
      f.quote,
      JSON.stringify(f.evidence),
      f.whatChanged,
      JSON.stringify(f.draft),
      f.author,
      f.at,
      f.judgment,
    );
  }
  /** Whether any agent has ever submitted feedback: until one has, nothing has connected. */
  anyFeedback(): boolean {
    return this.get("SELECT 1 AS x FROM feedback LIMIT 1") !== undefined;
  }
  consider(ids: string[], judgment: string): void {
    for (const id of ids) this.run("UPDATE feedback SET judgment = ? WHERE id = ? AND judgment IS NULL", judgment, id);
  }
  feedbackCount(name: string, sinceVersion: number): number {
    return n(this.get("SELECT COUNT(*) AS c FROM feedback WHERE skill = ? AND version >= ?", name, sinceVersion)?.c);
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
      `INSERT INTO judgments (id, skill, by, actor, state, started_at, finished_at, changed, reasoning, error, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, finished_at = excluded.finished_at, changed = excluded.changed,
       reasoning = excluded.reasoning, error = excluded.error, version = excluded.version`,
      j.id,
      j.skill,
      j.by,
      j.actor,
      j.state,
      j.startedAt,
      j.finishedAt,
      j.changed === null ? null : j.changed ? 1 : 0,
      j.reasoning,
      j.error,
      j.version,
    );
  }
  /** Judgments left running by a server that stopped: they will never finish. */
  failAbandoned(at: string): void {
    this.run("UPDATE judgments SET state = 'failed', error = 'the server stopped before it finished', finished_at = ? WHERE state = 'running'", at);
  }

  meta(key: string): string | undefined {
    const r = this.get("SELECT value FROM meta WHERE key = ?", key);
    return r && s(r.value);
  }
  setMeta(key: string, value: string): void {
    this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** A token is kept only as its hash; its name is who it speaks for. */
  addToken(name: string, hash: string, admin: boolean, at: string): void {
    this.run("INSERT INTO tokens (name, hash, admin, created_at) VALUES (?, ?, ?, ?)", name, hash, admin ? 1 : 0, at);
  }
  tokenByHash(hash: string): Token | undefined {
    const r = this.get("SELECT * FROM tokens WHERE hash = ?", hash);
    return r && token(r);
  }
  tokens(): Token[] {
    return this.all("SELECT * FROM tokens ORDER BY name").map(token);
  }
  revokeToken(name: string): boolean {
    const had = this.get("SELECT 1 AS x FROM tokens WHERE name = ?", name) !== undefined;
    this.run("DELETE FROM tokens WHERE name = ?", name);
    return had;
  }

  /** Makes a skill's entry in the search index its current text. */
  index(name: string, description: string, body: string): void {
    this.run("DELETE FROM search WHERE name = ?", name);
    this.run("INSERT INTO search (name, description, body) VALUES (?, ?, ?)", name, description, body);
  }
  /** Skills matching any word of `query`, best first, with where each matched. */
  search(query: string, limit: number, prefixes?: string[]): Hit[] {
    const match = matchQuery(query);
    if (!match) return [];
    const within = prefixes ? ` AND (${prefixes.map(() => "substr(name, 1, ?) = ?").join(" OR ") || "0"})` : "";
    return this.all(
      `SELECT name, snippet(search, 2, '«', '»', '…', 12) AS snippet FROM search WHERE search MATCH ?${within} ORDER BY bm25(search, 10.0, 5.0, 1.0) LIMIT ?`,
      match,
      ...(prefixes ?? []).flatMap((p) => [p.length + 1, `${p}/`]),
      limit,
    ).map((r) => ({ name: s(r.name), snippet: s(r.snippet) }));
  }
  unindex(name: string): void {
    this.run("DELETE FROM search WHERE name = ?", name);
  }
  deleteSkill(name: string): void {
    this.run("DELETE FROM skills WHERE name = ?", name);
  }
  /** The highest version a skill has ever had, deleted or not, so a skill made again under its name continues its history. */
  lastVersion(name: string): number {
    return n(this.get("SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE skill = ?", name)?.v);
  }
}
