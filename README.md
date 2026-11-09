# honed

**Share and hone skills across your organization.** A searchable library of agent skills behind one MCP server.
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

How it works: [docs/DESIGN.md](docs/DESIGN.md). `honed --help` lists the options.

## Develop

```sh
npm install
npm run dev          # the server, from source
npm test             # the reviser is faked, so no Claude is needed
npm run typecheck
npm run build
```

MIT licensed.
