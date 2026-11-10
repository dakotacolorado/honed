import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff } from "./diffview.ts";
import { renderMarkdown, withoutFrontmatter } from "./markdown.ts";

test("renders the markdown a skill uses", () => {
  const html = renderMarkdown("# Title\n\nA **bold** `code` [link](https://example.com).\n\n- one\n  - nested\n- two\n\n1. first\n\n> quote\n\n```\nlet x = 1;\n```");
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<p>A <strong>bold<\/strong> <code>code<\/code> <a href="https:\/\/example\.com" rel="noopener noreferrer">link<\/a>\.<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li><span class="sub">nested<\/span><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><\/ol>/);
  assert.match(html, /<blockquote>quote<\/blockquote>/);
  assert.match(html, /<pre><code>let x = 1;<\/code><\/pre>/);
});

test("escapes everything an agent wrote, and links only to http(s)", () => {
  const html = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) `<b>` <img src=x onerror=alert(1)> **<i>**');
  assert.doesNotMatch(html, /<script|<img|<b>|<i>|href="javascript/);
  assert.match(html, /&lt;script&gt;/);
});

test("takes a SKILL.md's frontmatter off", () => {
  assert.equal(withoutFrontmatter("---\nname: x\ndescription: d\n---\n\n# Body\n"), "\n# Body\n");
});

test("reads git's diffs per file, without its bookkeeping, relative to the skill", () => {
  const files = parseDiff(
    "diff --git a/team/x/SKILL.md b/team/x/SKILL.md\nindex 1..2 100644\n--- a/team/x/SKILL.md\n+++ b/team/x/SKILL.md\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\ndiff --git a/team/x/run.sh b/team/x/run.sh\nnew file mode 100755\n--- /dev/null\n+++ b/team/x/run.sh\n@@ -0,0 +1 @@\n+echo hi\n",
    "team/x",
  );
  assert.deepEqual(files, [
    { path: "SKILL.md", status: "changed", lines: [{ kind: "ctx", text: "keep" }, { kind: "del", text: "old" }, { kind: "add", text: "new" }] },
    { path: "run.sh", status: "created", lines: [{ kind: "add", text: "echo hi" }] },
  ]);
});
