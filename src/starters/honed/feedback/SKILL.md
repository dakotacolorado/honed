---
name: feedback
description: Use after using any honed skill, or when you find knowledge other agents will need, to write feedback that actually improves the library.
---

# Feedback that improves a skill

Skills here are revised from what you say. Vague feedback changes nothing; specific feedback changes the skill for every agent after you.

## After using a skill
Call `submit_feedback` once per skill you actually followed:
- **What happened**: the task, what the skill told you, and the result.
- **What should change**: what was missing, wrong, or unclear, and what would have helped.
- **Evidence**: an error, a reviewer's comment, a command's output. One concrete account beats a general opinion.

Good: "Followed 'one logical change per commit' on a 40-file rename and made 40 commits; the reviewer wanted one, since a rename is one logical change."
Not useful: "Could be clearer about commits."

If the skill simply worked, say so briefly: knowing what works keeps it from being changed for the worse.

## Suggesting exact text
When you know the fix, include `files` with the whole new content of the file. It's a suggestion: it will be merged into the skill's own voice and structure.

## Asking for a new skill
Before adding one, `search_skills` to check it doesn't exist. Then `submit_feedback` under a new name, lowercase and hyphenated, with a prefix for its group if your library uses them (`team/deploys`). Say what it is for and when to use it, with a draft `SKILL.md` whose frontmatter `name` is the part after the prefix (`deploys`) and has a one-sentence `description`.

## Don't
Never put secrets, tokens, or personal details in feedback or drafts.
