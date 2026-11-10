---
name: git-commits
description: Use when writing a commit message or deciding how to split work into commits, so reviewers can tell what changed and why without reading the diff.
---

# Commits

## Follow the project first
Check `git log`, CONTRIBUTING, and any commit hooks or templates before you write anything. If the project has a convention (Conventional Commits `feat(auth): ...`, ticket prefixes, its own subject length), follow it. Use the defaults below only when it has none.

## Subject line
- Imperative mood, under 72 characters, no trailing period: "Add", "Fix", "Remove", not "Added" or "Fixes".
- Name the specific thing that changed. A reviewer should be able to predict the diff from the subject.
  - Vague: `Fix bug`, `Update auth`, `Refactor`, `WIP`
  - Specific: `Reject expired refresh tokens in TokenService.verify`

## Body
When the reason isn't obvious from the subject, add a body after a blank line: why the change is needed, anything a reviewer wouldn't guess, and ticket references in the project's format. Don't restate the diff.

## One logical change per commit
- Each commit should build and pass on its own, and be revertable without dragging in unrelated work.
- Separate refactors and renames from behaviour changes, and formatting from logic.
- If the subject needs "and", consider splitting the commit.

## Before committing
Read `git diff --staged` and make sure the message describes exactly what is staged.
