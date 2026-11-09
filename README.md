# honed

```
 _                        _
| |__   ___  _ __   ___  __| |
| '_ \ / _ \| '_ \ / _ \/ _` |
| | | | (_) | | | |  __/ (_| |
|_| |_|\___/|_| |_|\___|\__,_|
══════════════════════════════✦
```

**Skills your agents sharpen every time they use them.** Share and hone skills across your organization: a
searchable library of agent skills behind one MCP server.

Your agents get skills and submit feedback when they use them, and each skill is revised from that feedback. Every
version is kept, with why it changed.

```sh
npx honed
claude mcp add --transport http --scope user honed http://127.0.0.1:4321/mcp
```

The first line starts the server and its page at <http://127.0.0.1:4321>; the second connects Claude Code. That is
all the setup. Needs Node 24+, git, and [Claude Code](https://claude.com/claude-code) signed in, which revises the
skills (`claude -p`, with no tools).

## The model

| Tool | |
|---|---|
| `list_skills` | Every skill, with its description |
| `search_skills` | Skills matching what a task is about |
| `get_skill` | A skill's `SKILL.md` and its file list, or one file |
| `submit_feedback` | What happened when you used a skill and what should change, optionally with files. Under a new name, it asks for that skill. |

Skills are folders in Claude Code's format: a `SKILL.md` plus any scripts, references or templates. Each has a
hard cap on its text (20,000 characters by default), so a skill can be revised but never bloated.

A new library starts with a few skills to show the idea: `git-commits`, `code-review`, `debugging`, and
`honed-feedback`, which teaches agents to write feedback that actually changes a skill. It also has `honed-judge`:
how honed decides on every revision, written as a skill like any other, so you can read it and agents can give
feedback on it. It is never revised on its own: feedback on it waits for an admin to choose **Revise now**. The rules
that keep revisions safe, and the cap, live in honed itself and can't be edited away.

## An example

An agent asked for a `git-commits` skill, with a draft: imperative subjects, one logical change per commit. Then
two agents reported, separately, that it said nothing about ticket ids: one had a PR sent back, the other put the id
in the wrong place. The next version did not add "put the ticket id first". It added *find the project's commit
conventions and follow them*, with the ticket prefix as an example. Its recorded reasoning cites both reports.

## Sharing it

Run it where your agents can reach it, with a token for each person or agent:

```sh
honed token create dakota --admin
honed --host 0.0.0.0
claude mcp add --transport http --scope user honed https://honed.example.com/mcp --header "Authorization: Bearer <token>"
```

People sign in to the page with their token; only an admin token can revert a skill. With no tokens, honed answers
only its own machine and needs none.

**For Claude Code**, the plugin connects it too, and also asks each session for feedback on the skills it used:

```sh
claude plugin marketplace add dakotacolorado/honed
claude plugin install honed@honed --config url=http://127.0.0.1:4321
```

`honed --help` lists the options.

## How it works

One Node process serves the page, a small JSON API and MCP at `/mcp`. Skills live in a git repo under `~/.honed`
(every version is a commit, so the library is readable and portable without honed), with SQLite alongside for
feedback, tokens and full-text search. When feedback calls for it, Claude Code revises the skill headlessly, with
no tools: it reads the skill, the feedback and its own past reasoning, and answers with a new version or no change.
The server checks every answer against the same rules as any skill, the cap included, before it keeps it.

## Develop

```sh
npm install
npm run dev          # the server, from source
npm test             # the reviser is faked, so no Claude is needed
npm run typecheck
npm run build
```

MIT licensed.
