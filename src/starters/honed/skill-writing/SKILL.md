---
name: skill-writing
description: Use before creating a new skill for this library, to draft one that agents will find, follow, and keep improving.
---

# Writing a new skill

## Check it's needed
`search_skills` for the job first. If a skill already covers it, give feedback on that one instead of starting another.

## Name and describe it
- One job per skill, named for it: lowercase and hyphenated, under a prefix for its group if your library uses them (`team/deploys`).
- The `description` is how agents find it. Say when to use it, in one sentence an agent can match against a task: "Use when …, to …".
- In `SKILL.md`'s frontmatter, `name` is the part after the prefix (`deploys`).

## Write the guidance
- Lead with what matters most; order the rest the way the work happens.
- Write down what an agent would get wrong without it: names, commands, decisions and pitfalls it can't infer. Leave out good practice any capable agent already follows; it costs every reader context and changes nothing.
- It should hold for every task it's used for. A fact about one project belongs with that project, not in a shared skill.
- One precise rule beats three cautious ones. Every line should change what an agent does.
- Add an example where a rule is easy to misread, and nothing else.
- Start small. It will grow from the feedback of agents that use it; it doesn't need to be complete on day one.

## Scripts and files
Add a script only when it does something guidance can't, and nothing beyond what the skill needs. Never put secrets, tokens, or personal details in a skill.

## Submit it
`submit_feedback` under the new name, saying what the skill is for and what prompted it, with your draft `SKILL.md` (and any files) attached.
