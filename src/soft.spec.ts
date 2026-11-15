import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WINDOW, type DraftFile } from "./domain.ts";
import { Hub } from "./hub.ts";
import { decisionJsonSchema, JUDGE_CONTRACT, render, SOFT_CONTRACT, systemPrompt, type Case, type Decision, type Judge } from "./judge.ts";
import { app, WRITE_HEADER } from "./web.ts";

const skillMd = (name: string, body: string) => `---\nname: ${name.split("/").pop()}\ndescription: How ${name} is written.\n---\n\n${body}\n`;
const draft = (name: string, body: string): DraftFile[] => [{ path: "SKILL.md", content: skillMd(name, body) }];
const nothing: Decision = { reasoning: "Not yet a pattern.", changed: false, note: "", edits: [], write: [], remove: [], revert_to: 0, sorted: [], honer_feedback: "" };

/** Decides as `decide` says, and keeps every case it was given. */
class FakeJudge implements Judge {
  readonly label = "a fake judge";
  cases: Case[] = [];
  decide_: (c: Case) => Decision;
  constructor(decide: (c: Case) => Decision) {
    this.decide_ = decide;
  }
  async decide(c: Case) {
    this.cases.push(c);
    return this.decide_(c);
  }
}

/** A new skill is made from its draft; on an existing one, every new report is sorted `kind`. */
const sortNew = (kind: "accepted" | "declined" | "held") => (c: Case): Decision => {
  if (c.version === 0) {
    const d = c.feedback.find((f) => f.draft.length)!;
    return { ...nothing, changed: true, note: "made", write: d.draft.map((f) => ({ ...f, executable: false })) };
  }
  return { ...nothing, sorted: c.feedback.filter((f) => f.sort === null).map((f) => ({ report: f.id.slice(0, 8), kind, why: kind })) };
};

/**
 * The soft judge as the brief asks: a single observation is held; once reports from two or more separate sessions in the
 * window say the same, it writes the pattern into the skill and accepts them together.
 */
const pattern = (c: Case): Decision => {
  if (c.version === 0) return sortNew("held")(c);
  const open = c.feedback.filter((f) => f.sort === null || f.sort === "held");
  const agree = open.filter((f) => /short sentences/.test(f.text));
  if (new Set(agree.map((f) => f.author)).size >= 2) {
    return {
      ...nothing,
      reasoning: "Separate sessions agree.",
      changed: true,
      note: "Short sentences",
      edits: [{ path: "SKILL.md", old: "Write plainly.", new: "Write plainly, in short sentences." }],
      sorted: agree.map((f) => ({ report: f.id.slice(0, 8), kind: "accepted" as const, why: "Part of the pattern." })),
    };
  }
  return { ...nothing, sorted: c.feedback.filter((f) => f.sort === null).map((f) => ({ report: f.id.slice(0, 8), kind: "held" as const, why: "One session so far." })) };
};

let dir: string;
let hub: Hub;
let judge: FakeJudge;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "honed-soft-"));
  judge = new FakeJudge(pattern);
  hub = await Hub.open(dir, judge, { starters: false });
});

afterEach(async () => {
  await hub.idle();
  hub.close();
  await rm(dir, { recursive: true, force: true });
});

/** Makes `voice`, a skill with one line, and marks it soft. */
async function makeSoft(name = "blog/voice") {
  await hub.submitFeedback({ skill: name, text: "make it", files: draft(name, "Write plainly.") });
  await hub.idle();
  hub.setKind(name, "soft");
  await hub.idle();
}

describe("a skill's kind and window", () => {
  test("is hard by default, set soft or hard by an admin, and the honers stay hard", async () => {
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x", "Do it.") });
    await hub.idle();
    assert.equal(hub.skill("x").kind, "hard");
    assert.equal(hub.list()[0]?.kind, "hard");
    assert.equal(hub.setKind("x", "soft").kind, "soft");
    assert.equal(hub.list()[0]?.kind, "soft");
    assert.equal(hub.setKind("x", "hard").kind, "hard");
    assert.throws(() => hub.setKind("x", "squishy"), /hard or soft/);
    assert.throws(() => hub.setKind("nope", "soft"), /no skill is named nope/);
    hub.close();
    const fresh = await mkdtemp(join(tmpdir(), "honed-soft-starters-"));
    try {
      hub = await Hub.open(fresh, judge);
      assert.ok(hub.list().every((s) => s.kind === "hard"));
      assert.throws(() => hub.setKind("honed/honer", "soft"), /stays hard/);
      assert.throws(() => hub.setKind("honed/soft-honer", "soft"), /stays hard/);
      assert.match(await hub.guidance("soft"), /^# Revising a soft skill from a pattern/);
      await assert.rejects(hub.delete("honed/soft-honer", ""), /cannot be deleted/);
      assert.deepEqual((await hub.submitFeedback({ skill: "honed/soft-honer", quote: "One report is a hint", evidence: [{ command: "c", output: "o" }], whatChanged: "w" })).next, { kind: "admin" });
    } finally {
      await hub.idle();
      hub.close();
      await rm(fresh, { recursive: true, force: true });
      hub = await Hub.open(dir, judge, { starters: false });
    }
  });

  test("a window is 20 unless an admin sets another, from 1 to 200", async () => {
    await makeSoft();
    assert.equal(DEFAULT_WINDOW, 20);
    assert.equal(hub.skill("blog/voice").window, null);
    assert.equal(hub.window("blog/voice"), 20);
    assert.equal(hub.setWindow("blog/voice", 3).window, 3);
    assert.equal(hub.window("blog/voice"), 3);
    assert.throws(() => hub.setWindow("blog/voice", 0), /from 1 to 200/);
    assert.throws(() => hub.setWindow("blog/voice", 2.5), /from 1 to 200/);
    assert.equal(hub.setWindow("blog/voice", null).window, null);
  });

  test("every skill in a library made before kinds is hard, and keeps its kind and window across restarts", async () => {
    await makeSoft();
    hub.setWindow("blog/voice", 5);
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x", "Do it.") });
    await hub.idle();
    hub.close();
    hub = await Hub.open(dir, judge, { starters: false });
    assert.deepEqual([hub.skill("blog/voice").kind, hub.skill("blog/voice").window], ["soft", 5]);
    hub.close();
    const db = new DatabaseSync(join(dir, "honed.db"));
    db.exec("ALTER TABLE skills DROP COLUMN kind; ALTER TABLE skills DROP COLUMN report_window;");
    db.close();
    hub = await Hub.open(dir, judge, { starters: false });
    assert.deepEqual(hub.list().map((s) => [s.name, s.kind]), [["blog/voice", "hard"], ["x", "hard"]]);
    assert.equal(hub.skill("x").window, null);
  });
});

describe("feedback on a soft skill", () => {
  test("takes an observation without quote, evidence or what changed, and says it is held; a hard skill refuses it as before", async () => {
    await makeSoft();
    const { feedback, next } = await hub.submitFeedback({ skill: "blog/voice", text: "Dakota cut every exclamation mark from my draft.", author: "blogger-1" });
    assert.equal(feedback.quote, null);
    assert.deepEqual(next, { kind: "soft", protected: false });
    await assert.rejects(hub.submitFeedback({ skill: "blog/voice", text: " " }), /needs feedback: what you saw/);
    await assert.rejects(hub.submitFeedback({ skill: "blog/voice", text: "t", quote: "Not in the skill at all." }), /is not in blog\/voice/);
    const quoted = await hub.submitFeedback({ skill: "blog/voice", text: "Kept plain.", quote: "Write plainly." });
    assert.equal(quoted.feedback.quote, "Write plainly.");
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x", "Do it.") });
    await hub.idle();
    await assert.rejects(hub.submitFeedback({ skill: "x", text: "Dakota cut every exclamation mark." }), /needs quote: the exact text in the skill/);
  });

  test("through MCP: get_skill shows the kind, and submit_feedback answers that a soft observation is held", async () => {
    await makeSoft();
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x", "Do it.") });
    await hub.idle();
    const fetch = app(hub, "test").fetch;
    let id = 0;
    const rpc = async (method: string, params: object) => {
      const res = await fetch(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: { host: "127.0.0.1", "content-type": "application/json", accept: "application/json, text/event-stream", "x-honed-namespaces": "blog" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        }),
      );
      return ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
    };
    const tool = (name: string, args: object) => rpc("tools/call", { name, arguments: args });
    assert.equal(JSON.parse((await tool("get_skill", { name: "blog/voice" })).content[0]!.text).kind, "soft");
    const said = await tool("submit_feedback", { name: "blog/voice", feedback: "Dakota rewrote my opening into one short line.", author: "blogger-2" });
    assert.equal(said.isError, undefined);
    assert.match(said.content[0]!.text, /soft skill: your observation is held to weigh with other sessions' reports/);
    const hard = await tool("submit_feedback", { name: "x", feedback: "Dakota rewrote my opening." });
    assert.equal(hard.isError, true);
    assert.match(hard.content[0]!.text, /needs quote/);
  });

  test("an admin sets the kind and window through the API, and the skill shows both", async () => {
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x", "Do it.") });
    await hub.idle();
    const fetch = app(hub, "test").fetch;
    const post = (path: string, body: object) =>
      fetch(new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json", [WRITE_HEADER]: "1" }, body: JSON.stringify(body) }));
    const get = async (path: string) => (await fetch(new Request(`http://127.0.0.1${path}`, { headers: { host: "127.0.0.1" } }))).json() as Promise<any>;
    assert.equal((await get("/api/skills/x")).kind, "hard");
    assert.equal(((await (await post("/api/skills/x/kind", { kind: "soft" })).json()) as any).kind, "soft");
    assert.equal(((await (await post("/api/skills/x/window", { window: 7 })).json()) as any).window, 7);
    assert.equal((await post("/api/skills/x/kind", { kind: "jelly" })).status, 400);
    const detail = await get("/api/skills/x");
    assert.deepEqual([detail.kind, detail.window], ["soft", 7]);
    assert.equal((await get("/api/skills"))[0].kind, "soft");
    const page = await (await fetch(new Request("http://127.0.0.1/skills/x", { headers: { host: "127.0.0.1" } }))).text();
    assert.match(page, /Soft: judged on patterns across its latest 7 reports/);
    assert.match(page, /Make it hard/);
  });
});

describe("judging a soft skill", () => {
  test("holds a single observation, sees the held ones with each new report, and changes once separate sessions agree", async () => {
    await makeSoft();
    await hub.submitFeedback({ skill: "blog/voice", text: "Dakota split my paragraph into short sentences.", author: "blogger-1" });
    await hub.idle();
    const first = hub.store.feedback("blog/voice").find((f) => f.author === "blogger-1")!;
    assert.equal(first.sort, "held");
    assert.notEqual(first.judgment, null, "a held report is considered: it waits for the next report, not a judgment of its own");
    assert.equal(hub.skill("blog/voice").version, 1, "one observation changes nothing");
    assert.equal(hub.list()[0]?.waiting, 0);

    await hub.submitFeedback({ skill: "blog/voice", text: "Dakota kept the joke in my intro.", author: "blogger-2" });
    await hub.idle();
    const second = judge.cases.at(-1)!;
    assert.equal(second.kind, "soft");
    assert.equal(second.window, 20);
    assert.deepEqual(second.feedback.map((f) => [f.author, f.sort]), [["blogger-1", "held"], ["blogger-2", null]], "the held report is in the window, the request that made the skill is not");
    assert.equal(hub.skill("blog/voice").version, 1);

    await hub.submitFeedback({ skill: "blog/voice", text: "Dakota rewrote my lead in short sentences.", author: "blogger-3" });
    await hub.idle();
    assert.equal(hub.skill("blog/voice").version, 2);
    assert.match((await hub.current("blog/voice"))[0]!.content, /Write plainly, in short sentences\./);
    const sorts = Object.fromEntries(hub.store.feedback("blog/voice").map((f) => [f.author, f.sort]));
    assert.deepEqual([sorts["blogger-1"], sorts["blogger-2"], sorts["blogger-3"]], ["accepted", "held", "accepted"]);
    const made = hub.store.versions("blog/voice")[0]!;
    assert.deepEqual(hub.store.feedbackOf(made.judgment).map((f) => f.author).sort(), ["blogger-1", "blogger-3"], "the version names the held report it came from");

    hub.close();
    const cases = judge.cases.length;
    hub = await Hub.open(dir, judge, { starters: false });
    await hub.idle();
    assert.equal(judge.cases.length, cases, "a held report does not call for a judgment on restart");
  });

  test("the case shows the window with how each was sorted, the kind, and the soft brief and guidance", async () => {
    await makeSoft();
    judge.decide_ = sortNew("held");
    await hub.submitFeedback({ skill: "blog/voice", text: "first", author: "a" });
    await hub.idle();
    await hub.submitFeedback({ skill: "blog/voice", text: "second", author: "b" });
    await hub.idle();
    const c = judge.cases.at(-1)!;
    const shown = render(c);
    assert.match(shown, /<skill name="blog\/voice" version="1" characters="\d+" cap="20000" kind="soft" window="20">/);
    assert.match(shown, /<window reports="2" new="1" held="1" authors="2">/);
    assert.match(shown, /by="a" on_version="1" at="[^"]+" sorted_before="held">\nfirst/);
    assert.doesNotMatch(shown, /<new_feedback>/);
    const prompt = systemPrompt(c.guidance, "soft");
    assert.ok(prompt.startsWith(JUDGE_CONTRACT));
    assert.ok(prompt.includes(SOFT_CONTRACT.trim()));
    assert.match(prompt, /# Your guidance \(the honed\/soft-honer skill\)/);
    assert.equal(systemPrompt("g"), systemPrompt("g", "hard"));
    assert.doesNotMatch(systemPrompt("g"), /This skill is soft/);
    const soft = JSON.stringify(decisionJsonSchema("soft"));
    assert.match(soft, /"held"/);
    assert.doesNotMatch(JSON.stringify(decisionJsonSchema()), /"held"/);
  });

  test("the window holds the latest N reports, sorted or not, and any still unsorted before them", async () => {
    await makeSoft();
    hub.setWindow("blog/voice", 2);
    judge.decide_ = sortNew("held");
    for (const author of ["a", "b", "c"]) {
      await hub.submitFeedback({ skill: "blog/voice", text: `from ${author}`, author });
      await hub.idle();
    }
    assert.deepEqual(judge.cases.at(-1)!.feedback.map((f) => f.author), ["b", "c"]);
    assert.equal(hub.store.feedback("blog/voice").filter((f) => f.sort === "held").length, 3, "a report out of the window stays on record");
  });

  test("declines a pattern the window contradicts, and a declined report is closed", async () => {
    await makeSoft();
    judge.decide_ = sortNew("declined");
    await hub.submitFeedback({ skill: "blog/voice", text: "Dakota likes long sentences.", author: "a" });
    await hub.idle();
    assert.equal(hub.store.feedback("blog/voice")[0]!.sort, "declined");
    const closed = hub.store.feedback("blog/voice")[0]!;
    judge.decide_ = (c) => ({ ...sortNew("held")(c), sorted: [...sortNew("held")(c).sorted, { report: closed.id.slice(0, 8), kind: "accepted", why: "again" }] });
    await hub.submitFeedback({ skill: "blog/voice", text: "Another.", author: "b" });
    await hub.idle();
    assert.match(hub.store.judgments("blog/voice", 1)[0]!.error ?? "", /was declined before and is closed/);
  });

  test("refuses a change with no report accepted, and a new report left undecided", async () => {
    await makeSoft();
    judge.decide_ = (c) => ({ ...sortNew("held")(c), changed: true, note: "n", edits: [{ path: "SKILL.md", old: "Write plainly.", new: "Write." }] });
    await hub.submitFeedback({ skill: "blog/voice", text: "one", author: "a" });
    await hub.idle();
    assert.match(hub.store.judgments("blog/voice", 1)[0]!.error ?? "", /you accepted no report here/);
    assert.equal(hub.skill("blog/voice").version, 1);
    judge.decide_ = () => nothing;
    await hub.submitFeedback({ skill: "blog/voice", text: "two", author: "b" });
    await hub.idle();
    assert.match(hub.store.judgments("blog/voice", 1)[0]!.error ?? "", /decide every new report as accepted, declined or held/);
  });

  test("the honer's notes while judging a soft skill go on honed/soft-honer", async () => {
    hub.close();
    const fresh = await mkdtemp(join(tmpdir(), "honed-soft-notes-"));
    try {
      hub = await Hub.open(fresh, judge);
      await makeSoft();
      judge.decide_ = (c) => ({ ...sortNew("held")(c), honer_feedback: "Say how many sessions make a pattern." });
      await hub.submitFeedback({ skill: "blog/voice", text: "one", author: "a" });
      await hub.idle();
      assert.equal(hub.store.waiting("honed/soft-honer").length, 1);
      assert.equal(hub.store.waiting("honed/honer").length, 0);
    } finally {
      await hub.idle();
      hub.close();
      await rm(fresh, { recursive: true, force: true });
      hub = await Hub.open(dir, judge, { starters: false });
    }
  });
});

describe("judging a hard skill", () => {
  test("refuses a held report: every report is accepted or declined, now", async () => {
    judge.decide_ = sortNew("held");
    await hub.submitFeedback({ skill: "x", text: "make it", files: draft("x", "Do it now.") });
    await hub.idle();
    await hub.submitFeedback({ skill: "x", quote: "description: How x is written.", evidence: [{ command: "c", output: "o" }], whatChanged: "w" });
    await hub.idle();
    assert.match(hub.store.judgments("x", 1)[0]!.error ?? "", /sorted held, but x is a hard skill/);
    const c = judge.cases.at(-1)!;
    assert.equal(c.kind, undefined);
    assert.match(render(c), /<new_feedback>/);
  });
});
