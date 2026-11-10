import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Refusal, type DraftFile } from "./domain.ts";
import { Hub } from "./hub.ts";
import { render, type Case, type Decision, type Judge } from "./judge.ts";

const skillMd = (name: string, body = "Do the thing.") => `---\nname: ${name.split("/").pop()}\ndescription: When to use ${name}.\n---\n\n${body}\n`;
const draft = (name: string, body?: string): DraftFile[] => [{ path: "SKILL.md", content: skillMd(name, body) }];
const noChange: Decision = { reasoning: "Not yet.", changed: false, note: "", write: [], remove: [], honer_feedback: "" };

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

/** Takes the newest draft as it is. */
const takeDraft = (c: Case): Decision => {
  const d = [...c.feedback].reverse().find((f) => f.draft.length);
  return d
    ? { reasoning: "Supported.", changed: true, note: d.text, write: d.draft.map((f) => ({ ...f, executable: f.executable ?? false })), remove: [], honer_feedback: "" }
    : noChange;
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
    const { feedback: f } = await hub.submitFeedback({ skill: "code-review", text: "Reviews kept missing tests.", files: draft("code-review"), author: "reviewer" });
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
    await hub.submitFeedback({ skill: "lint", text: "t", files: [...draft("lint"), { path: "bin/run", content: "#!/bin/sh\necho ok\n", executable: true }] });
    await hub.idle();
    assert.equal((await hub.files("lint", 1)).find((f) => f.path === "bin/run")?.executable, true);
    assert.equal((await stat(join(hub.library.path("lint"), "bin/run"))).mode & 0o111, 0o111);
  });

  test("without a draft waits for a few more before the judge looks, and is judged at once on a skill not yet made", async () => {
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x") });
    await hub.idle();
    judge.cases = [];
    judge.decide_ = () => noChange;
    await hub.submitFeedback({ skill: "x", text: "a" });
    await hub.submitFeedback({ skill: "x", text: "b" });
    await hub.idle();
    assert.equal(judge.cases.length, 0);
    await hub.submitFeedback({ skill: "x", text: "c" });
    await hub.idle();
    assert.equal(judge.cases.length, 1);
    assert.deepEqual(judge.cases[0]!.feedback.map((f) => f.text), ["a", "b", "c"]);
    assert.equal(hub.store.waiting("x").length, 0);
    await hub.submitFeedback({ skill: "brand-new", text: "We need a skill for release notes." });
    await hub.idle();
    assert.equal(judge.cases.at(-1)?.skill, "brand-new");
    assert.match(render(judge.cases.at(-1)!), /the skill does not exist yet/);
  });

  test("is refused without text, with a path outside the skill, or with a draft over the cap", async () => {
    await assert.rejects(hub.submitFeedback({ skill: "x", text: " " }), /needs text/);
    await assert.rejects(hub.submitFeedback({ skill: "Bad Name", text: "t" }), /lowercase/);
    for (const path of ["../escape", "/etc/passwd", "a/../../b", ".git/config", "a//b"]) {
      await assert.rejects(hub.submitFeedback({ skill: "x", text: "t", files: [{ path, content: "" }] }), Refusal, path);
    }
    hub.close();
    hub = await Hub.open(dir, judge, { maxChars: 1000, starters: false });
    await assert.rejects(hub.submitFeedback({ skill: "x", text: "t", files: draft("x", "y".repeat(1000)) }), /over the cap of 1000/);
  });
});

describe("the judge", () => {
  test("sees the skill, the waiting feedback with drafts, its precedent and the cap", async () => {
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x") });
    await hub.idle();
    await hub.submitFeedback({ skill: "x", text: "Needs an example.", files: draft("x", "Example: do it."), author: "writer" });
    await hub.idle();
    const c = judge.cases.at(-1)!;
    assert.equal(c.version, 1);
    assert.equal(c.precedent.length, 1);
    const text = render(c);
    assert.match(text, /<skill name="x" version="1" characters="\d+" cap="20000">/);
    assert.match(text, /<feedback by="writer" on_version="1"/);
    assert.match(text, /<draft>[\s\S]*Example: do it\./);
    assert.equal(hub.skill("x").version, 2);
  });

  test("a version that breaks the skill or the cap is refused, retried with the reason, and the skill kept as it was", async () => {
    hub.close();
    hub = await Hub.open(dir, judge, { maxChars: 1000, starters: false });
    judge.decide_ = (c) =>
      c.failure
        ? { reasoning: "Condensed.", changed: true, note: "small", write: draft("x", "short"), remove: [], honer_feedback: "" } as Decision
        : { reasoning: "All of it.", changed: true, note: "big", write: [{ path: "SKILL.md", content: skillMd("x", "y".repeat(1000)), executable: false }], remove: [], honer_feedback: "" };
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x") });
    await hub.idle();
    assert.equal(judge.cases.length, 2);
    assert.match(judge.cases[1]!.failure!, /over the cap of 1000/);
    assert.match(render(judge.cases[1]!), /<your_last_attempt_was_refused>/);
    assert.equal(hub.store.versions("x")[0]?.note, "small");

    judge.cases = [];
    judge.decide_ = () => ({ reasoning: "r", changed: true, note: "n", write: [{ path: "SKILL.md", content: "no frontmatter", executable: false }], remove: [], honer_feedback: "" });
    await hub.submitFeedback({ skill: "x", text: "again", files: draft("x", "z") });
    await hub.idle();
    assert.equal(judge.cases.length, 3);
    assert.equal(hub.skill("x").version, 1);
    assert.equal(hub.store.waiting("x").length, 1);
  });

  test("saying it changed the skill with nothing written is refused", async () => {
    judge.decide_ = () => ({ ...noChange, changed: true });
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x") });
    await hub.idle();
    assert.match(hub.store.judgments("x")[0]!.error!, /wrote and removed nothing/);
  });

  test("a decision made while a person changed the skill is thrown away and the skill judged again", async () => {
    await hub.submitFeedback({ skill: "x", text: "v1", files: draft("x", "one") });
    await hub.idle();
    await hub.submitFeedback({ skill: "x", text: "v2", files: draft("x", "two") });
    await hub.idle();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    judge.decide_ = async (c) => {
      if (c.version === 2) await gate;
      return takeDraft(c);
    };
    await hub.submitFeedback({ skill: "x", text: "v3", files: draft("x", "three") });
    await new Promise((r) => setTimeout(r, 10));
    const reverting = hub.revert("x", 1, "Two was wrong.");
    release();
    await reverting;
    await hub.idle();
    assert.match(hub.store.judgments("x").find((j) => j.state === "failed")!.error!, /changed while the judge was deciding/);
    assert.deepEqual(hub.store.versions("x").map((v) => v.note), ["v3", "Revert to version 1", "v2", "v1"]);
  });
});

describe("a person", () => {
  test("reverts a skill, recorded as theirs, and nothing else changes it without the judge", async () => {
    hub.close();
    hub = await Hub.open(dir, null, { starters: false });
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x") });
    assert.equal(hub.store.skill("x"), undefined);
    hub.close();
    hub = await Hub.open(dir, judge, { starters: false });
    await hub.idle();
    await hub.submitFeedback({ skill: "x", text: "better", files: draft("x", "Better") });
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
      await hub.submitFeedback({ skill: name, text: "t", files: draft(name, body) });
    }
    await hub.idle();
    const hits = hub.search("commit");
    assert.deepEqual(hits.map((h) => h.name), ["git-commits", "reviews"]);
    assert.match(hits[1]!.snippet, /«commits»/);
    assert.deepEqual(hub.search("merging").map((h) => h.name), ["release-notes"]);
    assert.deepEqual(hub.search("  "), []);
    await hub.submitFeedback({ skill: "reviews", text: "t", files: draft("reviews", "Read the tests first.") });
    await hub.idle();
    assert.deepEqual(hub.search("commit").map((h) => h.name), ["git-commits"]);
  });
});

test("a server reopened on the same folder keeps everything, judges what was waiting, and fails what it left running", async () => {
  await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x") });
  await hub.idle();
  hub.store.putJudgment({ id: "stuck", skill: "x", by: "judge", actor: null, state: "running", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, changed: null, reasoning: "", error: null, version: null });
  hub.close();
  hub = await Hub.open(dir, null, { starters: false });
  await hub.submitFeedback({ skill: "x", text: "waiting", files: draft("x", "next") });
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
      assert.deepEqual(hub.list().map((s) => s.name), ["default/code-review", "default/git-commits", "default/ux-review", "honed/honer", "honed/skill-writing"]);
      const [v] = hub.store.versions("default/git-commits");
      assert.equal(v?.note, "Shipped with honed");
      assert.equal(hub.judgment(v!.judgment).by, "starter");
      assert.match(await hub.guidance(), /^# Revising a skill from feedback/);
      hub.close();
      hub = await Hub.open(fresh, judge);
      assert.equal(hub.list().length, 5);
      assert.equal(hub.skill("default/git-commits").version, 1);
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
      await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x") });
      await hub.idle();
      assert.match(judge.cases.at(-1)!.guidance, /Weigh the evidence/);
      judge.cases = [];
      await hub.submitFeedback({ skill: "honed/honer", text: "Be stricter about scripts.", files: [{ path: "SKILL.md", content: skillMd("honed/honer", "Stricter.") }] });
      for (let i = 0; i < 3; i++) await hub.submitFeedback({ skill: "honed/honer", text: `more ${i}` });
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
    await hub.submitFeedback({ skill: "team/deploys", text: "make it", files: draft("team/deploys") });
    await hub.idle();
    assert.equal(hub.skill("team/deploys").version, 1);
    assert.match((await hub.current("team/deploys"))[0]!.content, /^---\nname: deploys\n/);
    assert.ok((await hub.library.files("team/deploys", hub.store.versions("team/deploys")[0]!.commit)).length === 1);
    for (const bad of ["a/b/c", "/x", "x/", "Team/x", "a//b"]) await assert.rejects(hub.submitFeedback({ skill: bad, text: "t" }), /optionally under one prefix/, bad);
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
      assert.equal(names[0], "default/git-commits");
      assert.ok(!names.includes("default/code-review"), names.join(", "));
      for (const h of hub.search("how do I write a commit message")) assert.doesNotMatch(h.snippet, /«(a|i|it|if|does|into)»/i);
      assert.deepEqual(hub.search("how do I").map((h) => h.name).length > 0, true, "a query of only filler words still searches");
    } finally {
      hub.close();
      await rm(fresh, { recursive: true, force: true });
      hub = await Hub.open(dir, judge, { starters: false });
    }
  });

  test("feedback says what will happen to it: revising, waiting for more, an admin, or nothing", async () => {
    assert.deepEqual((await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x") })).next, { kind: "revising" });
    await hub.idle();
    judge.decide_ = () => noChange;
    assert.deepEqual((await hub.submitFeedback({ skill: "x", text: "a" })).next, { kind: "waiting", more: 2 });
    assert.deepEqual((await hub.submitFeedback({ skill: "x", text: "b" })).next, { kind: "waiting", more: 1 });
    assert.deepEqual((await hub.submitFeedback({ skill: "x", text: "c" })).next, { kind: "revising" });
    assert.deepEqual((await hub.submitFeedback({ skill: "honed/honer", text: "stricter" })).next, { kind: "admin" });
    await hub.idle();
    hub.close();
    hub = await Hub.open(dir, null, { starters: false });
    assert.deepEqual((await hub.submitFeedback({ skill: "x", text: "d" })).next, { kind: "off" });
  });

  test("a person edits a skill's files as a new version, keeping a script's executable bit, within the cap", async () => {
    await hub.submitFeedback({ skill: "x", text: "make it", files: [...draft("x"), { path: "run.sh", content: "#!/bin/sh\n", executable: true }] });
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
    await hub.submitFeedback({ skill: "typo-skil", text: "make it", files: draft("typo-skil", "unique-word") });
    await hub.idle();
    await hub.submitFeedback({ skill: "typo-skil", text: "waiting" });
    const j = await hub.delete("typo-skil", "Misspelled.", "dakota");
    assert.equal(j.version, null);
    assert.equal(hub.store.skill("typo-skil"), undefined);
    assert.deepEqual(hub.search("unique-word"), []);
    assert.equal(hub.store.waiting("typo-skil").length, 0);
    assert.equal(hub.store.versions("typo-skil").length, 1);
    await assert.rejects(hub.delete("honed/honer", ""), /cannot be deleted|no skill/);
    await hub.submitFeedback({ skill: "typo-skil", text: "again", files: draft("typo-skil") });
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
      await hub.submitFeedback({ skill: "team/deploys", text: "make it", files: draft("team/deploys") });
      await hub.idle();
      const onHoner = hub.store.waiting("honed/honer");
      assert.equal(onHoner.length, 1);
      assert.equal(onHoner[0]!.author, "the honer (revising team/deploys)");
      assert.match(onHoner[0]!.text, /weigh drafts for team\/deploys/);
      assert.equal(judge.cases.at(-1)!.writingGuide?.startsWith("# Writing a new skill"), true, "a new skill is held to honed/skill-writing");

      await hub.submitFeedback({ skill: "honed/honer", text: "Say what to do with contradicting drafts.", files: draft("honed/honer", "Prefer the draft with evidence.") });
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
