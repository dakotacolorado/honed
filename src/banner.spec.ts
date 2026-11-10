import assert from "node:assert/strict";
import { test } from "node:test";
import { banner, WORDMARK } from "./banner.ts";

const info = { version: "1.2.3", url: "http://127.0.0.1:4321", dir: "/srv/honed", tokens: 0, reviser: "Revising with Claude Code, signed in on this machine.", color: false };

test("says what honed is, where it is, and the one command to connect", () => {
  const text = banner(info);
  assert.ok(text.includes(WORDMARK));
  assert.match(text, /v1\.2\.3/);
  assert.match(text, /claude plugin marketplace add dakotacolorado\/honed\n  claude plugin install honed@honed\n/);
  assert.match(text, /o\(\)xxxx\[\{:+>/, "the sword under the wordmark");
  assert.match(text, /search_skills.*get_skill.*submit_feedback/s);
  assert.match(text, /Local only/);
});

test("names the token header once tokens exist, and has no color codes unless asked", () => {
  const text = banner({ ...info, tokens: 2 });
  assert.match(text, /\/plugin configure honed@honed/);
  assert.match(text, /2 tokens: every request needs one/);
  assert.doesNotMatch(text, /\x1b\[/);
  assert.match(banner({ ...info, color: true }), /\x1b\[38;5;37m/);
});
