import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Refusal, type DraftFile } from "./domain.ts";
import { Hub } from "./hub.ts";
import { render, type Case, type Decision, type Judge } from "./judge.ts";

const skillMd = (name: string, body = "Do the thing.") => `---\nname: ${name.split("/").pop()}\ndescription: When to use ${name}.\n---\n\n${body}\n`;
const draft = (name: string, body?: string): DraftFile[] => [{ path: "SKILL.md", content: skillMd(name, body) }];
const noChange: Decision = { reasoning: "Not yet.", changed: false, note: "", edits: [], write: [], remove: [], revert_to: 0, sorted: [], honer_feedback: "" };

/** A report's quote, evidence and what changed, as a report on `skill` must carry them; nothing for a skill not made yet. */
async function on(skill: string): Promise<{ skill: string; quote?: string; evidence?: { command: string; output: string }[]; whatChanged?: string }> {
  const skillMd = (await hub.current(skill)).find((f) => f.path === "SKILL.md")?.content;
  const quote = skillMd && /^description: .*$/m.exec(skillMd)?.[0];
  return quote ? { skill, quote, evidence: [{ command: "npm test", output: "1 failing" }], whatChanged: "Ran it another way." } : { skill };
}

/** Decides as `decide` says, and keeps every case it was given. */
class FakeJudge implements Judge {
  readonly label = "a fake judge";
  cases: Case[] = [];
  decide_: (c: Case) => Decision | Promise<Decision>;
  constructor(decide: (c: Case) => Decision | Promise<Decision>) {
    this.decide_ = decide;
  }
  async decide(c: Case) {
    this.cases.push(c);
    return this.decide_(c);
  }
}

/** Every report in the case sorted one way. */
const sortAll = (c: Case, kind: "checkable" | "judgment" = "checkable") =>
  c.feedback.filter((f) => f.quote !== null).map((f) => ({ report: f.id.slice(0, 8), kind, why: kind === "checkable" ? "The evidence shows it." : "A preference." }));
/** Changes nothing, holding every report as a judgment call. */
const hold = (c: Case): Decision => ({ ...noChange, sorted: sortAll(c, "judgment") });

/** Takes the newest draft as it is, every report sorted checkable. */
const takeDraft = (c: Case): Decision => {
  const d = [...c.feedback].reverse().find((f) => f.draft.length);
  return d
    ? { reasoning: "Supported.", changed: true, note: d.text, edits: [], write: d.draft.map((f) => ({ ...f, executable: f.executable ?? false })), remove: [], revert_to: 0, sorted: sortAll(c), honer_feedback: "" }
    : { ...noChange, sorted: sortAll(c) };
};

let dir: string;
let hub: Hub;
let judge: FakeJudge;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "honed-test-"));
  judge = new FakeJudge(takeDraft);
  hub = await Hub.open(dir, judge, { starters: false });
});

afterEach(async () => {
  await hub.idle();
  hub.close();
  await rm(dir, { recursive: true, force: true });
});

describe("feedback", () => {
  test("under a new name with a draft makes the skill, as a commit, with the feedback marked considered", async () => {
    const { feedback: f } = await hub.submitFeedback({ ...(await on("code-review")), text: "Reviews kept missing tests.", files: draft("code-review"), author: "reviewer" });
    await hub.idle();
    assert.equal(hub.skill("code-review").version, 1);
    assert.equal(hub.list()[0]?.description, "When to use code-review.");
    const [v] = hub.store.versions("code-review");
    assert.equal(v?.note, "Reviews kept missing tests.");
    assert.match(await hub.library.diff("code-review", v!.commit), /\+Do the thing\./);
    assert.equal(await readFile(join(hub.library.path("code-review"), "SKILL.md"), "utf8"), skillMd("code-review"));
    assert.equal(hub.store.feedbackOf(v!.judgment)[0]?.id, f.id);
  });

  test("a script keeps its executable bit", async () => {
    await hub.submitFeedback({ ...(await on("lint")), text: "t", files: [...draft("lint"), { path: "bin/run", content: "#!/bin/sh\necho ok\n", executable: true }] });
    await hub.idle();
    assert.equal((await hub.files("lint", 1)).find((f) => f.path === "bin/run")?.executable, true);
    assert.equal((await stat(join(hub.library.path("lint"), "bin/run"))).mode & 0o111, 0o111);
  });

  test("a skill not yet made is judged at once", async () => {
    await hub.submitFeedback({ ...(await on("brand-new")), text: "We need a skill for release notes." });
    await hub.idle();
    assert.equal(judge.cases.at(-1)?.skill, "brand-new");
    assert.match(render(judge.cases.at(-1)!), /the skill does not exist yet/);
  });

  test("is refused without text, with a path outside the skill, or with a draft over the cap", async () => {
    await assert.rejects(hub.submitFeedback({ ...(await on("x")), text: " " }), /no skill is named x yet: to ask for it, say in feedback what it is for/);
    await assert.rejects(hub.submitFeedback({ ...(await on("Bad Name")), text: "t" }), /lowercase/);
    for (const path of ["../escape", "/etc/passwd", "a/../../b", ".git/config", "a//b"]) {
      await assert.rejects(hub.submitFeedback({ ...(await on("x")), text: "t", files: [{ path, content: "" }] }), Refusal, path);
    }
    hub.close();
    hub = await Hub.open(dir, judge, { maxChars: 1000, starters: false });
    await assert.rejects(hub.submitFeedback({ ...(await on("x")), text: "t", files: draft("x", "y".repeat(1000)) }), /over the cap of 1000/);
  });
});

describe("a report", () => {
  const evidence = [{ path: "src/api.ts", content: "export function fetchUser() {}" }];
  const make = async () => {
    await hub.submitFeedback({ skill: "api", text: "make it", files: draft("api", "Call getUser() to load a user.") });
    await hub.idle();
  };

  test("without evidence, or with evidence missing its half, is refused with what to include", async () => {
    await make();
    const base = { skill: "api", quote: "Call getUser() to load a user.", whatChanged: "Called fetchUser()." };
    await assert.rejects(hub.submitFeedback(base), /needs evidence: a file path with the file's current contents, or a command you ran with what it actually printed/);
    await assert.rejects(hub.submitFeedback({ ...base, evidence: [{ path: "src/api.ts" }] }), /include the file's current contents/);
    await assert.rejects(hub.submitFeedback({ ...base, evidence: [{ command: "npm test", output: " " }] }), /include what the command actually printed/);
    await assert.rejects(hub.submitFeedback({ ...base, evidence: [{}] }), /needs a path and the file's current contents, or a command/);
    await assert.rejects(hub.submitFeedback({ ...base, evidence: [{ path: "a", content: "b", command: "c", output: "d" }] }), /not both/);
    await assert.rejects(hub.submitFeedback({ ...base, evidence: [{ path: "a", content: "y".repeat(20_001) }] }), /keep only the lines/);
    await assert.rejects(hub.submitFeedback({ ...base, evidence, whatChanged: "" }), /needs what_changed/);
    assert.equal(hub.store.feedback("api").length, 1, "only the request that made it");
  });

  test("whose quote is not in the skill's current files is refused, saying to quote it exactly", async () => {
    await make();
    const base = { skill: "api", evidence, whatChanged: "Called fetchUser()." };
    await assert.rejects(hub.submitFeedback(base), /needs quote: the exact text in the skill/);
    await assert.rejects(hub.submitFeedback({ ...base, quote: "Call loadUser() to load a user." }), /this text is not in api as it is now \(v1\); get_skill it again and quote it exactly/);
    await assert.rejects(hub.submitFeedback({ ...base, quote: "getUser" }), /too short/);
    // Whitespace aside, word for word: a quote may wrap where the file does not.
    await hub.submitFeedback({ ...base, quote: "Call getUser()\n  to load a user." });
  });

  test("that holds is stored with its quote, evidence and what changed, and the judge's case shows them", async () => {
    await make();
    judge.decide_ = hold;
    await hub.submitFeedback({ skill: "api", quote: "Call getUser() to load a user.", evidence: [...evidence, { command: "grep -r getUser src", output: "0" }], whatChanged: "Called fetchUser().", text: "It was renamed in #41." });
    await hub.idle();
    const [f] = hub.store.feedback("api", 1);
    assert.equal(f!.quote, "Call getUser() to load a user.");
    assert.deepEqual(f!.evidence, [...evidence, { command: "grep -r getUser src", output: "0" }]);
    assert.equal(f!.whatChanged, "Called fetchUser().");
    const text = render(judge.cases.at(-1)!);
    assert.match(text, /<quote>\nCall getUser\(\) to load a user\.\n<\/quote>/);
    assert.match(text, /<evidence file="src\/api\.ts">\nexport function fetchUser\(\) \{\}\n<\/evidence>/);
    assert.match(text, /<evidence command="grep -r getUser src">\n0\n<\/evidence>/);
    assert.match(text, /<what_changed>\nCalled fetchUser\(\)\.\n<\/what_changed>/);
    assert.match(text, /<also_said>\nIt was renamed in #41\.\n<\/also_said>/);
  });

  test("asking for a new skill takes a draft and no quote", async () => {
    const { feedback: f } = await hub.submitFeedback({ skill: "new-one", text: "We keep needing this.", files: draft("new-one") });
    assert.equal(f.quote, null);
    assert.deepEqual(f.evidence, []);
    await hub.idle();
    assert.equal(hub.skill("new-one").version, 1);
  });

  test("a library made before reports and per-skill limits opens, its old feedback and skills read without them", async () => {
    hub.close();
    const old = await mkdtemp(join(tmpdir(), "honed-old-"));
    try {
      const db = new DatabaseSync(join(old, "honed.db"));
      db.exec("CREATE TABLE feedback (id TEXT PRIMARY KEY, skill TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, draft TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL, judgment TEXT)");
      db.exec("INSERT INTO feedback VALUES ('f1', 'x', 1, 'old words', '[]', 'someone', '2026-01-01T00:00:00.000Z', 'j1')");
      // A skills table from before each skill had its own limit; version 0 so it needs no files in git.
      db.exec("CREATE TABLE skills (name TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL)");
      db.exec("INSERT INTO skills VALUES ('x', 0, '2026-01-01T00:00:00.000Z')");
      db.close();
      hub = await Hub.open(old, null, { starters: false, maxChars: 5000 });
      assert.deepEqual(hub.store.feedback("x").map((f) => [f.text, f.quote, f.evidence, f.whatChanged]), [["old words", null, [], null]]);
      assert.equal(hub.store.skill("x")?.maxChars, null);
      assert.equal(hub.limit("x"), 5000, "the library's default");
      hub.setLimit("x", 1234);
      hub.store.putSkill({ name: "x", version: 0, createdAt: "2026-01-01T00:00:00.000Z" });
      assert.equal(hub.limit("x"), 1234, "a new version keeps the limit an admin set");
    } finally {
      hub.close();
      await rm(old, { recursive: true, force: true });
      hub = await Hub.open(dir, judge, { starters: false });
    }
  });
});

describe("the judge", () => {
  test("sees the skill, the waiting feedback with drafts, its precedent and the cap", async () => {
    await hub.submitFeedback({ ...(await on("x")), text: "make it", files: draft("x") });
    await hub.idle();
    await hub.submitFeedback({ ...(await on("x")), text: "Needs an example.", files: draft("x", "Example: do it."), author: "writer" });
    await hub.idle();
    const c = judge.cases.at(-1)!;
    assert.equal(c.version, 1);
    assert.equal(c.precedent.length, 1);
    const text = render(c);
    assert.match(text, /<skill name="x" version="1" characters="\d+" cap="20000">/);
    assert.match(text, /<feedback id="[0-9a-f]{8}" by="writer" on_version="1"/);
    assert.match(text, /<draft>[\s\S]*Example: do it\./);
    assert.equal(hub.skill("x").version, 2);
  });

  test("a version that breaks the skill or the cap is refused, retried with the reason, and the skill kept as it was", async () => {
    hub.close();
    hub = await Hub.open(dir, judge, { maxChars: 1000, starters: false });
    judge.decide_ = (c) =>
      c.failure
        ? { reasoning: "Condensed.", changed: true, note: "small", edits: [], write: draft("x", "short"), remove: [], revert_to: 0, sorted: [], honer_feedback: "" } as Decision
        : { reasoning: "All of it.", changed: true, note: "big", edits: [], write: [{ path: "SKILL.md", content: skillMd("x", "y".repeat(1000)), executable: false }], remove: [], revert_to: 0, sorted: [], honer_feedback: "" };
    await hub.submitFeedback({ ...(await on("x")), text: "make it", files: draft("x") });
    await hub.idle();
    assert.equal(judge.cases.length, 2);
    assert.match(judge.cases[1]!.failure!, /over the cap of 1000/);
    assert.match(render(judge.cases[1]!), /<your_last_attempt_was_refused>/);
    assert.equal(hub.store.versions("x")[0]?.note, "small");

    judge.cases = [];
    judge.decide_ = () => ({ reasoning: "r", changed: true, note: "n", edits: [], write: [{ path: "SKILL.md", content: "no frontmatter", executable: false }], remove: [], revert_to: 0, sorted: [], honer_feedback: "" });
    await hub.submitFeedback({ ...(await on("x")), text: "again", files: draft("x", "z") });
    await hub.idle();
    assert.equal(judge.cases.length, 3);
    assert.equal(hub.skill("x").version, 1);
    assert.equal(hub.store.waiting("x").length, 1);
  });

  test("saying it changed the skill with nothing written is refused", async () => {
    judge.decide_ = () => ({ ...noChange, changed: true });
    await hub.submitFeedback({ ...(await on("x")), text: "make it", files: draft("x") });
    await hub.idle();
    assert.match(hub.store.judgments("x")[0]!.error!, /wrote and removed nothing/);
  });

  test("a decision made while a person changed the skill is thrown away and the skill judged again", async () => {
    await hub.submitFeedback({ ...(await on("x")), text: "v1", files: draft("x", "one") });
    await hub.idle();
    await hub.submitFeedback({ ...(await on("x")), text: "v2", files: draft("x", "two") });
    await hub.idle();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    judge.decide_ = async (c) => {
      if (c.version === 2) await gate;
      return takeDraft(c);
    };
    await hub.submitFeedback({ ...(await on("x")), text: "v3", files: draft("x", "three") });
    await new Promise((r) => setTimeout(r, 10));
    const reverting = hub.revert("x", 1, "Two was wrong.");
    release();
    await reverting;
    await hub.idle();
    assert.match(hub.store.judgments("x").find((j) => j.state === "failed")!.error!, /changed while the judge was deciding/);
    assert.deepEqual(hub.store.versions("x").map((v) => v.note), ["v3", "Revert to version 1", "v2", "v1"]);
  });
});

describe("sorting reports", () => {
  const renamed = { quote: "Call getUser() to load a user.", evidence: [{ path: "src/api.ts", content: "export function fetchUser() {}" }], whatChanged: "Called fetchUser()." };
  const fix = (c: Case): Decision => ({
    ...noChange,
    reasoning: "src/api.ts exports fetchUser, not getUser.",
    changed: true,
    note: "getUser is fetchUser",
    edits: [{ path: "SKILL.md", old: "getUser()", new: "fetchUser()" }],
    sorted: sortAll(c, "checkable"),
  });
  const make = async () => {
    await hub.submitFeedback({ skill: "api", text: "make it", files: draft("api", "Call getUser() to load a user.") });
    await hub.idle();
    judge.cases = [];
  };

  test("a checkable report revises the skill at once, from that one report", async () => {
    await make();
    judge.decide_ = fix;
    const { feedback: f } = await hub.submitFeedback({ skill: "api", ...renamed });
    await hub.idle();
    assert.equal(judge.cases.length, 1);
    assert.equal(judge.cases[0]!.approved, false);
    assert.equal(hub.skill("api").version, 2);
    assert.match((await hub.current("api"))[0]!.content, /Call fetchUser\(\)/);
    const stored = hub.store.feedback("api", 1)[0]!;
    assert.deepEqual([stored.id, stored.sort, stored.sortWhy, stored.judgment !== null, stored.sortedBy === stored.judgment], [f.id, "checkable", "The evidence shows it.", true, true]);
  });

  test("a judgment report produces no revision and is kept pending, held from later judgments until an admin asks", async () => {
    await make();
    judge.decide_ = (c) => (c.failure ? hold(c) : { ...fix(c), sorted: sortAll(c, "judgment") });
    const { feedback: f } = await hub.submitFeedback({ skill: "api", ...renamed, whatChanged: "I'd rather it said fetch." });
    await hub.idle();
    assert.equal(hub.skill("api").version, 1, "the revision was refused");
    assert.match(judge.cases[1]!.failure!, /a judgment call revises no skill on its own/);
    judge.decide_ = hold;
    judge.cases = [];
    await hub.submitFeedback({ skill: "api", ...renamed, whatChanged: "Also prefer fetch." });
    await hub.idle();
    const held = hub.store.waiting("api");
    assert.ok(held.some((h) => h.id === f.id && h.sort === "judgment" && h.judgment === null), "still pending");
    assert.deepEqual(judge.cases.map((c) => c.feedback.length), [1], "a held report is not judged again with each new one");
    const [j] = hub.store.judgments("api");
    assert.ok(hub.store.heldBy(j!.id).length >= 1);

    judge.cases = [];
    judge.decide_ = (c) => ({ ...fix(c), sorted: sortAll(c, "judgment") });
    hub.judgeNow("api");
    await hub.idle();
    assert.equal(judge.cases[0]!.approved, true);
    assert.match(render(judge.cases[0]!), /<an_admin_asked_for_this_judgment>/);
    assert.match(render(judge.cases[0]!), /sorted_before="judgment"/);
    assert.equal(hub.skill("api").version, 2, "an admin's ask is the agreement");
    assert.equal(hub.store.waiting("api").length, 0);
  });

  test("a decision that leaves a report unsorted, or names one not in the case, is refused and retried", async () => {
    await make();
    judge.decide_ = (c) =>
      !c.failure ? { ...fix(c), sorted: [] } : c.failure.includes("not sorted") ? { ...fix(c), sorted: [{ report: "nope1234", kind: "checkable", why: "w" }] } : fix(c);
    await hub.submitFeedback({ skill: "api", ...renamed });
    await hub.idle();
    assert.match(judge.cases[0]! && judge.cases[1]!.failure!, /sort every report as checkable or judgment, with why: [0-9a-f]{8} is not sorted/);
    assert.match(judge.cases[2]!.failure!, /sorted names report nope1234, which is not in this case/);
    assert.equal(hub.skill("api").version, 2);
  });

  test("a library made before reports were sorted opens, its feedback unsorted", async () => {
    hub.close();
    const old = await mkdtemp(join(tmpdir(), "honed-old-sort-"));
    try {
      const db = new DatabaseSync(join(old, "honed.db"));
      db.exec("CREATE TABLE feedback (id TEXT PRIMARY KEY, skill TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, quote TEXT, evidence TEXT NOT NULL DEFAULT '[]', what_changed TEXT, draft TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL, judgment TEXT)");
      db.exec("INSERT INTO feedback VALUES ('f1', 'x', 1, 'old', 'q', '[]', 'w', '[]', 'someone', '2026-01-01T00:00:00.000Z', NULL)");
      db.close();
      hub = await Hub.open(old, null, { starters: false });
      const [f] = hub.store.feedback("x");
      assert.deepEqual([f!.sort, f!.sortWhy, f!.sortedBy], [null, null, null]);
      assert.deepEqual(hub.store.unsorted("x").map((u) => u.id), ["f1"]);
      hub.store.sortFeedback("f1", "judgment", "taste", "j1");
      assert.deepEqual(hub.store.unsorted("x"), []);
      assert.deepEqual(hub.store.heldBy("j1").map((h) => [h.id, h.sort, h.sortWhy]), [["f1", "judgment", "taste"]]);
    } finally {
      hub.close();
      await rm(old, { recursive: true, force: true });
      hub = await Hub.open(dir, judge, { starters: false });
    }
  });
});

describe("edits", () => {
  const twoFacts = "- Run `npm run lint` before committing.\n- Deploy with `make ship`.";
  const edit = (old: string, now: string): Decision => ({ ...noChange, reasoning: "The report shows it.", changed: true, note: "fix", edits: [{ path: "SKILL.md", old, new: now }] });

  test("change only the text they name, leaving every other file and line as it was", async () => {
    await hub.submitFeedback({ skill: "x", text: "make it", files: [...draft("x", twoFacts), { path: "notes.md", content: "keep me" }] });
    await hub.idle();
    judge.decide_ = () => edit("`make ship`", "`make deploy`");
    hub.judgeNow("x");
    await hub.idle();
    assert.equal(hub.skill("x").version, 2);
    const [before, after] = [await hub.files("x", 1), await hub.files("x", 2)];
    assert.deepEqual(after.find((f) => f.path === "notes.md"), before.find((f) => f.path === "notes.md"));
    assert.equal(after.find((f) => f.path === "SKILL.md")!.content, before.find((f) => f.path === "SKILL.md")!.content.replace("`make ship`", "`make deploy`"));
    const diff = await hub.library.diff("x", hub.store.versions("x")[0]!.commit);
    assert.deepEqual(diff.split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l)), ["-- Deploy with `make ship`.", "+- Deploy with `make deploy`."]);
  });

  test("whose old text is not in the file, or is in it twice, is refused, and the retry told which edit to correct", async () => {
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x", twoFacts) });
    await hub.idle();
    judge.cases = [];
    judge.decide_ = (c) =>
      c.failure
        ? { ...edit("`make ship`", "`make deploy`"), edits: [edit("`npm run lint`", "`npm run check`").edits[0]!, edit("`make ship`", "`make deploy`").edits[0]!] }
        : { ...edit("x", "y"), edits: [edit("`npm run lint`", "`npm run check`").edits[0]!, edit("`make shipit`", "z").edits[0]!] };
    hub.judgeNow("x");
    await hub.idle();
    assert.equal(judge.cases.length, 2);
    assert.match(judge.cases[1]!.failure!, /edit 2 \(on SKILL\.md\): its old text is not in the file; copy it exactly/);
    assert.match(render(judge.cases[1]!), /<your_last_attempt_was_refused>\nedit 2/);
    assert.match((await hub.current("x"))[0]!.content, /`npm run check`[\s\S]*`make deploy`/);

    judge.cases = [];
    judge.decide_ = (c) => (c.failure ? noChange : edit("`", "'"));
    hub.judgeNow("x");
    await hub.idle();
    assert.match(judge.cases[1]!.failure!, /edit 1 \(on SKILL\.md\): its old text appears more than once/);
  });
});

describe("a revert by the judge", () => {
  /** v1 made, then v2 from one report adding a wrong command; the case for a second report quoting it. */
  async function contradicted() {
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x", "- Lint with `npm run lint`.") });
    await hub.idle();
    judge.decide_ = () => ({ ...noChange, changed: true, note: "Deploy command", edits: [{ path: "SKILL.md", old: "- Lint with `npm run lint`.", new: "- Lint with `npm run lint`.\n- Deploy with `make ship`." }] });
    const { feedback: first } = await hub.submitFeedback({ ...(await on("x")), evidence: [{ path: "Makefile", content: "ship:\n\t./deploy" }], author: "first agent" });
    await hub.idle();
    hub.judgeNow("x");
    await hub.idle();
    assert.equal(hub.skill("x").version, 2);
    return first;
  }

  test("undoes a version made from one report that a later report's evidence contradicts, as a new commit naming both", async () => {
    const first = await contradicted();
    judge.cases = [];
    judge.decide_ = () => ({ ...noChange, reasoning: "The Makefile has no ship target; v2 was wrong.", changed: true, revert_to: 1 });
    const { feedback: second } = await hub.submitFeedback({ skill: "x", quote: "- Deploy with `make ship`.", evidence: [{ command: "make ship", output: "make: *** No rule to make target 'ship'." }], whatChanged: "Ran ./deploy.", author: "second agent" });
    await hub.idle();
    hub.judgeNow("x");
    await hub.idle();
    assert.match(render(judge.cases[0]!), new RegExp(`<from report="${first.id.slice(0, 8)}" by="first agent">quoting: description: When to use x\\.</from>`), "the precedent names the report behind v2");
    assert.equal(hub.skill("x").version, 3);
    assert.deepEqual(await hub.files("x", 3), await hub.files("x", 1));
    const [v3, v2] = hub.store.versions("x");
    assert.notEqual(v3!.commit, v2!.commit);
    assert.equal(v3!.note, "Revert to version 1");
    const j = hub.judgment(v3!.judgment);
    assert.equal(j.by, "judge");
    assert.match(j.reasoning, /The Makefile has no ship target/);
    assert.match(j.reasoning, new RegExp(`Reverts to v1, undoing report ${first.id.slice(0, 8)} by first agent \\(v2\\); contradicted by report ${second.id.slice(0, 8)} by second agent\\.`));
    assert.deepEqual(hub.store.feedbackOf(v3!.judgment).map((f) => f.id), [second.id]);
  });

  test("that also edits, or names no earlier version, is refused and retried with the reason", async () => {
    await contradicted();
    judge.cases = [];
    judge.decide_ = (c) =>
      c.failure?.includes("whole") ? { ...noChange, changed: true, revert_to: 2 } : c.failure ? noChange : { ...noChange, changed: true, revert_to: 1, edits: [{ path: "SKILL.md", old: "a", new: "b" }] };
    hub.judgeNow("x");
    await hub.idle();
    assert.match(judge.cases[1]!.failure!, /restores an earlier version whole: leave edits, write and remove empty/);
    assert.match(judge.cases[2]!.failure!, /revert_to must be a version from 1 to 1, or 0/);
    assert.equal(hub.skill("x").version, 2);
  });
});

describe("a skill's own limit", () => {
  test("is set by an admin, shown with the skill, and holds for the judge and for people", async () => {
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x", "short") });
    await hub.idle();
    const size = (await hub.current("x"))[0]!.content.length;
    assert.equal(hub.list()[0]!.limit, 20_000);
    hub.setLimit("x", size + 20);
    assert.equal(hub.list()[0]!.limit, size + 20);
    assert.throws(() => hub.setLimit("x", 0), /whole number of characters/);

    judge.cases = [];
    judge.decide_ = (c) => (c.failure ? noChange : { ...noChange, changed: true, note: "grow", edits: [{ path: "SKILL.md", old: "short", new: "s".repeat(40) }] });
    hub.judgeNow("x");
    await hub.idle();
    assert.equal(judge.cases[0]!.maxChars, size + 20);
    assert.match(judge.cases[1]!.failure!, new RegExp(`over the cap of ${size + 20}`));
    assert.equal(hub.skill("x").version, 1);
    await assert.rejects(hub.edit("x", { write: [{ path: "more.md", content: "y".repeat(21) }] }, ""), /over the cap/);
    await assert.rejects(hub.submitFeedback({ ...(await on("x")), files: [...draft("x", "s".repeat(40))] }), /over the cap/);

    // Lowered below what it holds: it may shrink, not grow.
    hub.setLimit("x", 10);
    await assert.rejects(hub.edit("x", { write: [{ path: "more.md", content: "y" }] }, ""), /over the cap of 10/);
    await hub.edit("x", { write: [{ path: "SKILL.md", content: skillMd("x", "s") }] }, "Trim.");
    assert.equal(hub.skill("x").version, 2);
    hub.setLimit("x", null);
    assert.equal(hub.list()[0]!.limit, 20_000);
  });
});

describe("a protected skill", () => {
  /** Makes `x` at v1, protected, and a report with a draft on it held as a revision. */
  async function held(body = "Better.") {
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x") });
    await hub.idle();
    assert.equal(hub.setProtected("x", true).protected, true);
    const { feedback, next } = await hub.submitFeedback({ ...(await on("x")), files: draft("x", body) });
    assert.deepEqual(next, { kind: "protected" });
    await hub.idle();
    return feedback;
  }

  test("holds the honer's revision for an admin: the current version is what agents read, and feedback waits", async () => {
    const f = await held();
    assert.equal(hub.skill("x").version, 1);
    assert.match((await hub.current("x"))[0]!.content, /Do the thing\./);
    const pending = hub.pending("x")!;
    assert.equal(pending.version, 1);
    assert.match(pending.files[0]!.content, /Better\./);
    const j = hub.judgment(pending.judgment);
    assert.equal(j.state, "pending");
    assert.equal(j.version, null);
    assert.equal(j.reasoning, "Supported.");
    assert.equal(hub.store.feedbackOf(j.id)[0]?.id, f.id);
    assert.deepEqual([hub.list()[0]!.protected, hub.list()[0]!.pending], [true, true]);

    // No second revision is drafted while one waits, even asked for.
    judge.cases = [];
    await hub.submitFeedback({ ...(await on("x")), files: draft("x", "Other.") });
    hub.judgeNow("x");
    await hub.idle();
    assert.equal(judge.cases.length, 0);
    assert.equal(hub.store.waiting("x").length, 1);
  });

  test("an approved revision is kept as the next version, recorded with who approved it, and feedback is revised again", async () => {
    await held();
    const j = await hub.approve("x", "Reads right.", "dakota");
    assert.equal(j.state, "done");
    assert.equal(j.changed, true);
    assert.equal(j.version, 2);
    assert.deepEqual({ by: j.review!.by, approved: j.review!.approved, reason: j.review!.reason }, { by: "dakota", approved: true, reason: "Reads right." });
    assert.equal(hub.judgment(j.id).review?.approved, true);
    assert.equal(hub.skill("x").version, 2);
    assert.match((await hub.current("x"))[0]!.content, /Better\./);
    assert.equal(hub.store.versions("x")[0]!.judgment, j.id);
    assert.equal(hub.pending("x"), undefined);
    await assert.rejects(hub.approve("x", ""), /no revision of x is waiting/);

    await hub.submitFeedback({ ...(await on("x")), files: draft("x", "Best.") });
    await hub.idle();
    assert.match(hub.pending("x")!.files[0]!.content, /Best\./);
  });

  test("a declined revision is discarded, the skill left as it was, and the decline kept in its history", async () => {
    const f = await held();
    const id = hub.pending("x")!.judgment;
    const j = await hub.decline("x", "Not what we do.", "dakota");
    assert.equal(j.id, id);
    assert.equal(j.state, "done");
    assert.equal(j.changed, false);
    assert.equal(j.version, null);
    assert.deepEqual([j.review!.by, j.review!.approved, j.review!.reason], ["dakota", false, "Not what we do."]);
    assert.equal(hub.skill("x").version, 1);
    assert.equal(hub.pending("x"), undefined);
    assert.equal(hub.store.feedbackOf(id)[0]?.id, f.id);
    assert.match(hub.store.pendingOf(id)!.files[0]!.content, /Better\./);
  });

  test("an admin's edit applies at once, and a revision made from the version before it can then only be declined", async () => {
    await held();
    await hub.edit("x", { write: [{ path: "SKILL.md", content: skillMd("x", "By hand.") }] }, "Fix.", "dakota");
    assert.equal(hub.skill("x").version, 2);
    await assert.rejects(hub.approve("x", ""), (e: Refusal) => e.status === 409 && /changed since this revision was made from v1/.test(e.message));
    await hub.decline("x", "Outdated.");
    assert.match((await hub.current("x"))[0]!.content, /By hand\./);
  });

  test("unprotected, a skill is revised from feedback at once again", async () => {
    await held();
    await hub.decline("x", "");
    hub.setProtected("x", false);
    await hub.submitFeedback({ ...(await on("x")), files: draft("x", "Now.") });
    await hub.idle();
    assert.equal(hub.skill("x").version, 2);
    assert.equal(hub.pending("x"), undefined);
  });

  test("a judgment report beside the checkable one stays held for agreement, not considered by the held revision", async () => {
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x") });
    await hub.idle();
    hub.setProtected("x", true);
    // The first case is refused (no report sorted), so the retry gathers the report sent meanwhile too.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    judge.decide_ = async (c) => {
      if (!c.failure) {
        await gate;
        return noChange;
      }
      return { ...takeDraft(c), sorted: c.feedback.filter((f) => f.quote !== null).map((f) => ({ report: f.id.slice(0, 8), kind: f.draft.length ? "checkable" : "judgment", why: "-" })) };
    };
    judge.cases = [];
    const { feedback: checkable } = await hub.submitFeedback({ ...(await on("x")), files: draft("x", "Better.") });
    const { feedback: taste } = await hub.submitFeedback({ ...(await on("x")), whatChanged: "I'd rather it were shorter." });
    release();
    await hub.idle();
    assert.deepEqual(judge.cases.map((c) => c.feedback.length), [1, 2], "both reports in the retry");
    const j = hub.pending("x")!.judgment;
    assert.deepEqual(hub.store.feedbackOf(j).map((f) => f.id), [checkable.id]);
    const waiting = hub.store.waiting("x");
    assert.ok(waiting.some((f) => f.id === taste.id && f.sort === "judgment" && f.judgment === null), "the judgment call still waits");
  });

  test("a deleted skill's held revision is declined by the deletion", async () => {
    await held();
    const id = hub.pending("x")!.judgment;
    await hub.delete("x", "Gone.", "dakota");
    assert.equal(hub.judgment(id).review?.approved, false);
    assert.equal(hub.store.pending("x"), undefined);
  });
});

describe("a person", () => {
  test("reverts a skill, recorded as theirs, and nothing else changes it without the judge", async () => {
    hub.close();
    hub = await Hub.open(dir, null, { starters: false });
    await hub.submitFeedback({ ...(await on("x")), text: "make it", files: draft("x") });
    assert.equal(hub.store.skill("x"), undefined);
    hub.close();
    hub = await Hub.open(dir, judge, { starters: false });
    await hub.idle();
    await hub.submitFeedback({ ...(await on("x")), text: "better", files: draft("x", "Better") });
    await hub.idle();
    const j = await hub.revert("x", 1, "Better was not.", "dakota");
    assert.equal(j.by, "person");
    assert.equal(j.actor, "dakota");
    assert.equal(hub.skill("x").version, 3);
    assert.deepEqual(await hub.files("x", 3), await hub.files("x", 1));
    await assert.rejects(hub.revert("x", 3, ""), /from 1 to 2/);
  });
});

describe("search", () => {
  test("finds a skill by any word of its text, stemmed, best match first, and follows each new version", async () => {
    for (const [name, body] of [["git-commits", "Write subjects in the imperative."], ["release-notes", "Group merged changes by user-facing impact."], ["reviews", "Check that commits are split sensibly."]] as const) {
      await hub.submitFeedback({ ...(await on(name)), text: "t", files: draft(name, body) });
    }
    await hub.idle();
    const hits = hub.search("commit");
    assert.deepEqual(hits.map((h) => h.name), ["git-commits", "reviews"]);
    assert.match(hits[1]!.snippet, /«commits»/);
    assert.deepEqual(hub.search("merging").map((h) => h.name), ["release-notes"]);
    assert.deepEqual(hub.search("  "), []);
    await hub.submitFeedback({ ...(await on("reviews")), text: "t", files: draft("reviews", "Read the tests first.") });
    await hub.idle();
    assert.deepEqual(hub.search("commit").map((h) => h.name), ["git-commits"]);
  });
});

test("a server reopened on the same folder keeps everything, judges what was waiting, and fails what it left running", async () => {
  await hub.submitFeedback({ ...(await on("x")), text: "make it", files: draft("x") });
  await hub.idle();
  hub.store.putJudgment({ id: "stuck", skill: "x", by: "judge", actor: null, state: "running", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, changed: null, reasoning: "", error: null, version: null, review: null });
  hub.close();
  hub = await Hub.open(dir, null, { starters: false });
  await hub.submitFeedback({ ...(await on("x")), text: "waiting", files: draft("x", "next") });
  hub.close();
  hub = await Hub.open(dir, judge, { starters: false });
  await hub.idle();
  assert.equal(hub.judgment("stuck").state, "failed");
  assert.equal(hub.skill("x").version, 2);
  assert.equal(hub.list()[0]?.description, "When to use x.");
});

describe("starters", () => {
  test("ship once on a new library, with honed/honer, and come back only for honed/honer if it is ever missing", async () => {
    hub.close();
    const fresh = await mkdtemp(join(tmpdir(), "honed-starters-"));
    try {
      hub = await Hub.open(fresh, judge);
      assert.deepEqual(hub.list().map((s) => s.name), ["honed/honer", "honed/skill-writing", "team/code-review", "team/git-commits", "team/ux-review"]);
      const [v] = hub.store.versions("team/git-commits");
      assert.equal(v?.note, "Shipped with honed");
      assert.equal(hub.judgment(v!.judgment).by, "starter");
      assert.match(await hub.guidance(), /^# Revising a skill from feedback/);
      hub.close();
      hub = await Hub.open(fresh, judge);
      assert.equal(hub.list().length, 5);
      assert.equal(hub.skill("team/git-commits").version, 1);
    } finally {
      await hub.idle();
      hub.close();
      await rm(fresh, { recursive: true, force: true });
      hub = await Hub.open(dir, judge, { starters: false });
    }
  });

  test("honed/honer guides every revision, and is revised itself only when an admin asks", async () => {
    hub.close();
    const fresh = await mkdtemp(join(tmpdir(), "honed-starters-"));
    try {
      hub = await Hub.open(fresh, judge);
      await hub.submitFeedback({ ...(await on("x")), text: "make it", files: draft("x") });
      await hub.idle();
      assert.match(judge.cases.at(-1)!.guidance, /Weigh the evidence/);
      judge.cases = [];
      await hub.submitFeedback({ ...(await on("honed/honer")), text: "Be stricter about scripts.", files: [{ path: "SKILL.md", content: skillMd("honed/honer", "Stricter.") }] });
      for (let i = 0; i < 3; i++) await hub.submitFeedback({ ...(await on("honed/honer")), text: `more ${i}` });
      await hub.idle();
      assert.equal(judge.cases.length, 0);
      assert.equal(hub.skill("honed/honer").version, 1);
      hub.judgeNow("honed/honer");
      await hub.idle();
      assert.equal(hub.skill("honed/honer").version, 2);
      assert.match(await hub.guidance(), /Stricter\./);
    } finally {
      await hub.idle();
      hub.close();
      await rm(fresh, { recursive: true, force: true });
      hub = await Hub.open(dir, judge, { starters: false });
    }
  });
});

describe("prefixes", () => {
  test("group skills under one optional prefix, and a SKILL.md names only the part after it", async () => {
    await hub.submitFeedback({ ...(await on("team/deploys")), text: "make it", files: draft("team/deploys") });
    await hub.idle();
    assert.equal(hub.skill("team/deploys").version, 1);
    assert.match((await hub.current("team/deploys"))[0]!.content, /^---\nname: deploys\n/);
    assert.ok((await hub.library.files("team/deploys", hub.store.versions("team/deploys")[0]!.commit)).length === 1);
    for (const bad of ["a/b/c", "/x", "x/", "Team/x", "a//b"]) await assert.rejects(hub.submitFeedback({ ...(await on(bad)), text: "t" }), /optionally under one prefix/, bad);
    await assert.rejects(
      hub.edit("team/deploys", { write: [{ path: "SKILL.md", content: "---\nname: team/deploys\ndescription: d\n---\n" }] }, ""),
      /must say name: deploys \(the part after team\/, since Claude Code's skill names have no slash\)/,
    );
  });
});

describe("the reviewer's fixes", () => {
  test("search ignores filler words, so a question finds the skill it is about and not every skill", async () => {
    hub.close();
    const fresh = await mkdtemp(join(tmpdir(), "honed-search-"));
    try {
      hub = await Hub.open(fresh, null);
      const names = hub.search("how do I write a commit message").map((h) => h.name);
      assert.equal(names[0], "team/git-commits");
      assert.ok(!names.includes("team/code-review"), names.join(", "));
      for (const h of hub.search("how do I write a commit message")) assert.doesNotMatch(h.snippet, /«(a|i|it|if|does|into)»/i);
      assert.deepEqual(hub.search("how do I").map((h) => h.name).length > 0, true, "a query of only filler words still searches");
    } finally {
      hub.close();
      await rm(fresh, { recursive: true, force: true });
      hub = await Hub.open(dir, judge, { starters: false });
    }
  });

  test("feedback says what will happen to it: judged now, an admin, or nothing", async () => {
    assert.deepEqual((await hub.submitFeedback({ ...(await on("x")), text: "make it", files: draft("x") })).next, { kind: "revising" });
    await hub.idle();
    judge.decide_ = hold;
    assert.deepEqual((await hub.submitFeedback({ ...(await on("x")), text: "a" })).next, { kind: "revising" }, "judged at once, alone");
    assert.deepEqual((await hub.submitFeedback({ ...(await on("honed/honer")), text: "stricter" })).next, { kind: "admin" });
    await hub.idle();
    hub.close();
    hub = await Hub.open(dir, null, { starters: false });
    assert.deepEqual((await hub.submitFeedback({ ...(await on("x")), text: "d" })).next, { kind: "off" });
  });

  test("a person edits a skill's files as a new version, keeping a script's executable bit, within the cap", async () => {
    await hub.submitFeedback({ ...(await on("x")), text: "make it", files: [...draft("x"), { path: "run.sh", content: "#!/bin/sh\n", executable: true }] });
    await hub.idle();
    const j = await hub.edit("x", { write: [{ path: "run.sh", content: "#!/bin/sh\necho fixed\n" }] }, "Fix a typo.", "dakota");
    assert.equal(j.actor, "dakota");
    assert.equal(hub.skill("x").version, 2);
    assert.deepEqual((await hub.current("x")).find((f) => f.path === "run.sh"), { path: "run.sh", content: "#!/bin/sh\necho fixed\n", executable: true });
    await hub.edit("x", { remove: ["run.sh"] }, "");
    assert.deepEqual((await hub.current("x")).map((f) => f.path), ["SKILL.md"]);
    await assert.rejects(hub.edit("x", { remove: ["SKILL.md"] }, ""), /must have a SKILL\.md/);
    await assert.rejects(hub.edit("x", { write: [{ path: "big.md", content: "y".repeat(20_001) }] }, ""), /over the cap/);
  });

  test("a person deletes a skill: gone from the library and search, history kept, waiting feedback closed, and a skill made again continues its versions", async () => {
    await hub.submitFeedback({ ...(await on("typo-skil")), text: "make it", files: draft("typo-skil", "unique-word") });
    await hub.idle();
    await hub.submitFeedback({ ...(await on("typo-skil")), text: "waiting" });
    const j = await hub.delete("typo-skil", "Misspelled.", "dakota");
    assert.equal(j.version, null);
    assert.equal(hub.store.skill("typo-skil"), undefined);
    assert.deepEqual(hub.search("unique-word"), []);
    assert.equal(hub.store.waiting("typo-skil").length, 0);
    assert.equal(hub.store.versions("typo-skil").length, 1);
    await assert.rejects(hub.delete("honed/honer", ""), /cannot be deleted|no skill/);
    await hub.submitFeedback({ ...(await on("typo-skil")), text: "again", files: draft("typo-skil") });
    await hub.idle();
    assert.equal(hub.skill("typo-skil").version, 2);
  });
});

describe("the honer's own guidance", () => {
  test("the honer leaves feedback on honed/honer while revising other skills, but never while revising honed/honer", async () => {
    hub.close();
    const fresh = await mkdtemp(join(tmpdir(), "honed-honer-"));
    try {
      hub = await Hub.open(fresh, judge);
      judge.decide_ = (c) => ({ ...takeDraft(c), honer_feedback: `Nothing said how to weigh drafts for ${c.skill}.` });
      await hub.submitFeedback({ ...(await on("team/deploys")), text: "make it", files: draft("team/deploys") });
      await hub.idle();
      const onHoner = hub.store.waiting("honed/honer");
      assert.equal(onHoner.length, 1);
      assert.equal(onHoner[0]!.author, "the honer (revising team/deploys)");
      assert.match(onHoner[0]!.text, /weigh drafts for team\/deploys/);
      assert.equal(judge.cases.at(-1)!.writingGuide?.startsWith("# Writing a new skill"), true, "a new skill is held to honed/skill-writing");

      await hub.submitFeedback({ ...(await on("honed/honer")), text: "Say what to do with contradicting drafts.", files: draft("honed/honer", "Prefer the draft with evidence.") });
      await hub.idle();
      assert.equal(hub.skill("honed/honer").version, 1, "waits for an admin");
      hub.judgeNow("honed/honer");
      await hub.idle();
      assert.equal(hub.skill("honed/honer").version, 2);
      assert.equal(judge.cases.at(-1)!.writingGuide, null);
      assert.equal(hub.store.waiting("honed/honer").length, 0, "its feedback on itself, while revising itself, is dropped");
    } finally {
      await hub.idle();
      hub.close();
      await rm(fresh, { recursive: true, force: true });
      hub = await Hub.open(dir, judge, { starters: false });
    }
  });
});
