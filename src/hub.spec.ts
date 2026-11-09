import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Refusal, type Change } from "./domain.ts";
import { Hub } from "./hub.ts";
import { render, type Case, type Decision, type Judge } from "./judge.ts";

const skillMd = (name: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: When to use ${name}.\n---\n\n${body}\n`;
const create = (name: string, body?: string): Change => ({ write: [{ path: "SKILL.md", content: skillMd(name, body) }], remove: [] });

/** Rules as `decide` says, and keeps every case it was given. */
class FakeJudge implements Judge {
  cases: Case[] = [];
  decide: (c: Case) => Decision | Promise<Decision>;
  constructor(decide: (c: Case) => Decision | Promise<Decision>) {
    this.decide = decide;
  }
  async rule(c: Case) {
    this.cases.push(c);
    return this.decide(c);
  }
}

/** Adopts every open proposal's change as it is. */
const mergeAll = (c: Case): Decision => {
  const writes = c.proposals.flatMap((p) => p.proposal.change.write.map((w) => ({ ...w, executable: w.executable ?? false })));
  return {
    reasoning: "Supported.",
    outcome: c.proposals.length ? "change" : "no_change",
    note: c.proposals.map((p) => p.proposal.title).join("; "),
    change: { write: writes, remove: c.proposals.flatMap((p) => p.proposal.change.remove) },
    proposals: c.proposals.map((p) => ({ id: p.proposal.id, ruling: "merged", reason: "Good." })),
  };
};

let dir: string;
let hub: Hub;
let judge: FakeJudge;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "honed-test-"));
  judge = new FakeJudge(mergeAll);
  hub = await Hub.open(dir, judge, { feedbackBatch: 2 });
});

afterEach(async () => {
  await hub.idle();
  hub.close();
  await rm(dir, { recursive: true, force: true });
});

describe("proposing", () => {
  test("a new skill becomes version 1 once the judge merges it, with a commit and the proposal merged", async () => {
    const p = await hub.propose({ skill: "code-review", title: "Add it", why: "Reviews kept missing tests.", change: create("code-review"), author: "reviewer" });
    await hub.idle();
    const skill = hub.skill("code-review");
    assert.equal(skill.version, 1);
    assert.equal(skill.policy, "judge");
    assert.equal(hub.proposal(p.id).state, "merged");
    assert.equal(hub.list()[0]?.description, "When to use code-review.");
    const [v] = hub.store.versions("code-review");
    assert.equal(v?.by, "judge");
    assert.match(await hub.library.diff("code-review", v!.commit), /\+Do the thing\./);
    assert.equal(await readFile(join(hub.library.path("code-review"), "SKILL.md"), "utf8"), skillMd("code-review"));
  });

  test("a script keeps its executable bit in the library and the checkout", async () => {
    await hub.propose({
      skill: "lint",
      title: "Add it",
      why: "w",
      change: { write: [{ path: "SKILL.md", content: skillMd("lint") }, { path: "bin/run", content: "#!/bin/sh\necho ok\n", executable: true }], remove: [] },
    });
    await hub.idle();
    const run = (await hub.files("lint", 1)).find((f) => f.path === "bin/run");
    assert.equal(run?.executable, true);
    assert.equal((await stat(join(hub.library.path("lint"), "bin/run"))).mode & 0o111, 0o111);
  });

  test("is refused when the skill it would leave has no SKILL.md naming it", async () => {
    await assert.rejects(hub.propose({ skill: "x", title: "t", why: "w", change: create("y") }), /name: x/);
    await assert.rejects(hub.propose({ skill: "x", title: "t", why: "w", change: { write: [{ path: "a.md", content: "" }], remove: [] } }), /SKILL\.md/);
    await hub.propose({ skill: "x", title: "t", why: "w", change: create("x") });
    await hub.idle();
    await assert.rejects(hub.propose({ skill: "x", title: "t", why: "w", change: { write: [], remove: ["SKILL.md"] } }), /must have a SKILL\.md/);
  });

  test("is refused for a path outside the skill", async () => {
    for (const path of ["../escape", "/etc/passwd", "a/../../b", ".git/config", "a//b"]) {
      await assert.rejects(hub.propose({ skill: "x", title: "t", why: "w", change: { write: [{ path, content: "" }], remove: [] } }), Refusal, path);
    }
  });

  test("is refused without a why", async () => {
    await assert.rejects(hub.propose({ skill: "x", title: "t", why: " ", change: create("x") }), /why/);
  });
});

describe("the judge", () => {
  test("is not asked about feedback until a batch has arrived, then sees it and marks it considered", async () => {
    await hub.propose({ skill: "x", title: "t", why: "w", change: create("x") });
    await hub.idle();
    judge.cases = [];
    judge.decide = () => ({ reasoning: "Not yet.", outcome: "no_change", note: "", change: { write: [], remove: [] }, proposals: [] });
    const first = await hub.giveFeedback({ skill: "x", verdict: "missing", reason: "No word on flaky tests." });
    await hub.idle();
    assert.equal(judge.cases.length, 0);
    await hub.giveFeedback({ skill: "x", verdict: "hurt", reason: "Told me to skip the slow suite." });
    await hub.idle();
    assert.equal(judge.cases.length, 1);
    assert.equal(judge.cases[0]?.feedback.length, 2);
    assert.ok(hub.store.feedbackOf(hub.store.feedback("x").find((f) => f.id === first.id)!.judgment!).length === 2);
    assert.equal(hub.skill("x").version, 1);
  });

  test("can change a skill from feedback alone, with no proposal", async () => {
    await hub.propose({ skill: "x", title: "t", why: "w", change: create("x") });
    await hub.idle();
    judge.decide = () => ({
      reasoning: "Two agents hit the same gap.",
      outcome: "change",
      note: "Say what to do about flaky tests",
      change: { write: [{ path: "SKILL.md", content: skillMd("x", "Rerun a flaky test once.") , executable: false }], remove: [] },
      proposals: [],
    });
    await hub.giveFeedback({ skill: "x", verdict: "missing", reason: "a" });
    await hub.giveFeedback({ skill: "x", verdict: "missing", reason: "b" });
    await hub.idle();
    assert.equal(hub.skill("x").version, 2);
    assert.equal(hub.store.versions("x")[0]?.note, "Say what to do about flaky tests");
  });

  test("sees votes, comments and earlier rulings, and a proposal it leaves open stays open", async () => {
    judge.decide = (c) => ({
      reasoning: "Waiting for votes.",
      outcome: "no_change",
      note: "",
      change: { write: [], remove: [] },
      proposals: c.proposals.map((p) => ({ id: p.proposal.id, ruling: "open", reason: "Needs evidence." })),
    });
    const p = await hub.propose({ skill: "x", title: "t", why: "w", change: create("x") });
    await hub.idle();
    assert.equal(hub.proposal(p.id).state, "open");
    hub.vote({ proposal: p.id, vote: "up", reason: "Would have saved me an hour.", author: "a" });
    await hub.idle();
    hub.comment({ proposal: p.id, body: "Add an example?", author: "b" });
    await hub.idle();
    const last = judge.cases.at(-1)!;
    assert.equal(last.proposals[0]?.votes[0]?.reason, "Would have saved me an hour.");
    assert.equal(last.proposals[0]?.comments[0]?.body, "Add an example?");
    assert.ok(last.proposals[0]!.rulings.length >= 1);
    assert.match(render(last), /Would have saved me an hour\./);
  });

  test("a decision that breaks the skill fails the judgment, is retried, and leaves the skill as it was", async () => {
    judge.decide = (c) => ({ ...mergeAll(c), change: { write: [{ path: "SKILL.md", content: "no frontmatter", executable: false }], remove: [] } });
    const p = await hub.propose({ skill: "x", title: "t", why: "w", change: create("x") });
    await hub.idle();
    assert.equal(judge.cases.length, 3);
    assert.equal(hub.proposal(p.id).state, "open");
    assert.equal(hub.store.skill("x"), undefined);
    assert.ok(hub.store.judgments("x").every((j) => j.state === "failed" && j.error));
  });

  test("merging with no change is refused", async () => {
    judge.decide = (c) => ({ ...mergeAll(c), outcome: "no_change" });
    const p = await hub.propose({ skill: "x", title: "t", why: "w", change: create("x") });
    await hub.idle();
    assert.equal(hub.proposal(p.id).state, "open");
    assert.match(hub.store.judgments("x")[0]!.error!, /merged a proposal but made no change/);
  });

  test("a decision made while a person changed the skill is thrown away and the skill judged again", async () => {
    await hub.propose({ skill: "x", title: "t", why: "w", change: create("x") });
    await hub.idle();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    judge.decide = async (c) => {
      if (judge.cases.length === 2) await gate;
      return mergeAll(c);
    };
    const a = await hub.propose({ skill: "x", title: "judge's", why: "w", change: create("x", "A") });
    const b = await hub.propose({ skill: "x", title: "mine", why: "w", change: create("x", "B") });
    await new Promise((r) => setTimeout(r, 10));
    await hub.merge(b.id, "I want this one.");
    release();
    await hub.idle();
    assert.equal(hub.proposal(b.id).state, "merged");
    assert.equal(hub.proposal(a.id).state, "merged");
    assert.match(hub.store.judgments("x").find((j) => j.state === "failed")!.error!, /changed while the judge was ruling/);
    assert.equal(hub.skill("x").version, 3);
  });

  test("is not asked about a skill ruled by hand", async () => {
    await hub.propose({ skill: "x", title: "t", why: "w", change: create("x") });
    await hub.idle();
    hub.setPolicy("x", "human");
    judge.cases = [];
    await hub.propose({ skill: "x", title: "t", why: "w", change: create("x", "changed") });
    await hub.idle();
    assert.equal(judge.cases.length, 0);
    assert.throws(() => hub.judgeNow("x"), /by hand/);
  });
});

describe("a person", () => {
  test("merges, rejects and reverts, each recorded as their ruling", async () => {
    hub.close();
    hub = await Hub.open(dir, null);
    const p = await hub.propose({ skill: "x", title: "Create", why: "w", change: create("x") });
    await hub.merge(p.id, "Looks right.");
    const q = await hub.propose({ skill: "x", title: "Worse", why: "w", change: create("x", "Worse") });
    await hub.reject(q.id, "Too vague.");
    const r = await hub.propose({ skill: "x", title: "Better", why: "w", change: create("x", "Better") });
    await hub.merge(r.id, "");
    assert.equal(hub.skill("x").version, 2);
    assert.equal(hub.proposal(q.id).state, "rejected");
    assert.equal(hub.store.rulingsOn(q.id)[0]?.reason, "Too vague.");
    await hub.revert("x", 1, "Better was not.");
    assert.equal(hub.skill("x").version, 3);
    assert.deepEqual(await hub.files("x", 3), await hub.files("x", 1));
    assert.deepEqual(hub.store.versions("x").map((v) => v.by), ["human", "human", "human"]);
    await assert.rejects(hub.merge(q.id, ""), /rejected/);
    await assert.rejects(hub.revert("x", 3, ""), /from 1 to 2/);
  });
});

test("a server reopened on the same folder keeps everything, and fails judgments it left running", async () => {
  await hub.propose({ skill: "x", title: "t", why: "w", change: create("x") });
  await hub.idle();
  hub.store.putJudgment({ id: "stuck", skill: "x", by: "judge", state: "running", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, outcome: null, reasoning: "", error: null, version: null });
  hub.close();
  hub = await Hub.open(dir, judge, { feedbackBatch: 2 });
  assert.equal(hub.skill("x").version, 1);
  assert.equal(hub.list()[0]?.description, "When to use x.");
  assert.equal(hub.judgment("stuck").state, "failed");
});
