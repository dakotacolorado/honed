---
name: code-review
description: Use when reviewing a pull request or a diff, to find what matters (bugs, risk, missing tests) and say it so the author can act on it.
---

# Reviewing code

## Read for intent first
Read the PR description and any linked ticket before the diff. Review the change against what it claims to do; if it doesn't say, ask before guessing.

## In order of importance
1. **Correctness.** Wrong results, unhandled errors, edge cases (empty, null, very large, concurrent), off-by-one, resource leaks.
2. **Risk.** Security (input reaching queries, shells or HTML unescaped; secrets; authorization), data loss, migrations, anything hard to undo.
3. **Tests.** Does a test fail without this change? Are the risky paths covered?
4. **Design.** Does it fit how the codebase already does this? Is anything duplicated that exists already?
5. **Readability.** Names, size, clarity. Last, and only where it matters.

## Saying it
- Lead each comment with its weight: **blocking**, **should fix**, or **nit**.
- Point to the line, say what goes wrong and when, and suggest a fix when you have one.
- Ask instead of assert when you might be missing context.
- Don't comment on what a formatter or linter would catch.

## Before you approve
Run it or its tests if you can. Say plainly what you checked and what you didn't.
