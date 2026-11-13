# honed

```
██╗  ██╗ ██████╗ ███╗   ██╗███████╗██████╗            ▄██
██║  ██║██╔═══██╗████╗  ██║██╔════╝██╔══██╗         ▄██▀
███████║██║   ██║██╔██╗ ██║█████╗  ██║  ██║    ▄  ▄██▀
██╔══██║██║   ██║██║╚██╗██║██╔══╝  ██║  ██║     ███▀
██║  ██║╚██████╔╝██║ ╚████║███████╗██████╔╝   ▄█▀ ▀█
╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚═════╝   █▀
```

**Skills your agents sharpen every time they use them.**

Share and hone skills across your organization: agents use a skill, say how it went, and honed revises it.

## Try it on your machine

```sh
npx @dakotajp/honed
```

That starts the server and its page at <http://127.0.0.1:4321>. Then connect a repo by committing a `.mcp.json` at its
root, naming the namespaces it uses (see [namespaces](#the-model)):

```json
{
  "mcpServers": {
    "honed": {
      "type": "http",
      "url": "http://127.0.0.1:4321/mcp",
      "headers": { "Authorization": "Bearer ${HONED_TOKEN}", "X-Honed-Namespaces": "your-project, team" }
    }
  }
}
```

and set `HONED_TOKEN` in your environment (any value on a local honed with no tokens). Nothing else is installed: no
plugin and no hooks. Each Claude Code session in the repo is told its skills when it starts, searches them before a
task, and reports on one when it edited something the skill mentions or the skill gave it wrong information, quoting
the skill's text and showing the evidence. That is all the setup. Needs Node 24+, git, and [Claude Code](https://claude.com/claude-code) signed in: skills are revised
by Claude Code on your machine, with your login (`claude -p`, with no tools), so there is no API key to set.

## The model

| Tool | |
|---|---|
| `list_skills` | Every skill, with its description |
| `search_skills` | Skills matching what a task is about |
| `get_skill` | A skill's `SKILL.md` and its file list, or one file |
| `submit_feedback` | A report on a skill: the exact text that is wrong (`quote`), the `evidence` (a file as it is now, or a command and what it printed) and `what_changed`, optionally with files. A report missing any, or quoting text the skill lacks, is refused with how to fix it. Under a new name, it asks for that skill. |

Skills are folders in Claude Code's format: a `SKILL.md` plus any scripts, references or templates. Each has a
hard cap on its text (20,000 characters by default, or `--max-chars`; an admin can set each skill's own on its page),
so a skill can be revised but never bloated. The honer revises an existing skill by editing the text that's there, so
what no edit names stays word for word. Every version is a git commit, and a skill's history names the reports behind each one. When
a later report's evidence contradicts a change made from an earlier one, the honer can revert it instead of editing on
top: a new commit, its reasoning naming both reports.

Names can have one prefix that groups them: `team/deploys`, `honed/honer`. A skill's `SKILL.md` frontmatter
names only the part after it, as Claude Code expects.

The prefix is a skill's namespace: a project (`workplace-ui/`), an initiative, or a shared set (`ux/`). Each repo
commits a `.mcp.json` naming the namespaces it uses, its own plus any shared ones, and its sessions see only the skills
in them, plus honed's own `honed/`. Honed never points back at the repo. The token comes from each person's
environment, so none is committed:

```json
{
  "mcpServers": {
    "honed": {
      "type": "http",
      "url": "http://127.0.0.1:4321/mcp",
      "headers": { "Authorization": "Bearer ${HONED_TOKEN}", "X-Honed-Namespaces": "workplace-ui, ux" }
    }
  }
}
```

A session's MCP instructions name the skills it is bound to. A connection with no `X-Honed-Namespaces` sees only
`honed/`, and its instructions say how to bind its repo. A skill with no prefix is seen by no session.

A new library starts with a few team skills to show the idea and get you going: `team/git-commits`,
`team/code-review` and `team/ux-review`. They're yours to change, and your agents' feedback will. Two more belong to
honed itself:

- **`honed/skill-writing`**: how to write a new skill. Agents read it before drafting one, and new skills are held to it.
- **`honed/honer`**: how the honer, the part of honed that revises skills, decides on feedback. It's a skill like any
  other: you can read it, and agents (and the honer itself, while revising other skills) leave feedback on it. It is
  never revised on its own: feedback waits for an admin to choose **Revise now**, and the honer never reviews its own
  review. The rules that keep revisions safe, and the cap, live in honed itself and can't be edited away.

## An example

An agent asked for a `git-commits` skill, with a draft: imperative subjects, one logical change per commit. Then
two agents reported, separately, that it said nothing about ticket ids: one had a PR sent back, the other put the id
in the wrong place. The next version did not add "put the ticket id first". It added *find the project's commit
conventions and follow them*, with the ticket prefix as an example. Its recorded reasoning cites both reports.

## Host it for your team

On a server, skills are revised through the Claude API with your organization's key instead of a Claude Code login.
Needs Node 24+ and git:

```sh
npm install -g @dakotajp/honed             # installs the honed command
export ANTHROPIC_API_KEY=sk-ant-...        # revisions are billed to this key
honed token create dakota --admin --dir /srv/honed
honed --host 0.0.0.0 --judge api --dir /srv/honed
```

Put it behind HTTPS (any reverse proxy). Each repo's `.mcp.json` names it (`"url": "https://honed.example.com/mcp"`),
and each person sets `HONED_TOKEN` to their own token in their environment, so no token is committed.

`--judge` picks who revises: `claude-code` (a Claude Code login on this machine), `api` (the Claude API, with
`ANTHROPIC_API_KEY`; `claude-opus-5-5` unless `--judge-model` names another), `off`, or `auto`, the default, which
takes Claude Code when it is installed and the API when only a key is set. The banner says which one is running.

People sign in to the page with their token; only an admin can edit, revert or delete a skill. With no tokens, honed
answers only its own machine and needs none. **The first token switches honed to token-required at once, even while
it is running**: agents connected without one get 401s until they send it.

`honed --help` lists the options. Agents other than Claude Code can use honed as a plain MCP server at `/mcp`, with
`Authorization: Bearer <token>` on a shared one: [`docs/MCP.md`](./docs/MCP.md) says how, with each tool's arguments.

## How it works

One Node process serves the page, the API the page reads and an admin writes through ([its docs](#the-api)), and MCP at `/mcp`. Skills live in a git repo under `~/.honed`
(every version is a commit, so the library is readable and portable without honed), with SQLite alongside for
feedback, tokens and full-text search. When feedback calls for it, Claude revises the skill (through Claude Code
headless on a dev machine, or the Claude API on a server), with no tools: it reads the skill, the feedback and its own
past reasoning, and answers with a new version or no change, as JSON against a fixed schema.
The server checks every answer against the same rules as any skill, the cap included, before it keeps it.

## The MCP server

Agents use honed through its MCP server at `/mcp`: the four tools above and the instructions it gives an agent when it
connects. Its contract is [`mcp.json`](./mcp.json), `tools/list` as served, rendered in [`docs/MCP.md`](./docs/MCP.md);
a running honed serves both at `/mcp.json` and `/docs/mcp`, the page giving that honed's own address, with no token
needed.

## The API

The API under `/api` is how honed's page, or a script of yours, reads the library (each skill with its files, versions,
feedback, and why it changed) and how an admin edits, reverts or deletes a skill by hand. Agents use MCP instead. Its contract is [`openapi.json`](./openapi.json),
rendered in [`docs/API.md`](./docs/API.md); a running honed serves both at `/openapi.json` and `/docs/api`, with no
token needed. Reads are `GET`s; every write is a `POST` with the `x-honed: 1` header and an admin token.

A server can read one skill without speaking MCP: `GET /api/skills/{name}` answers its name, version and every file
(path, content, executable), as `get_skill` does, with its versions and latest feedback. A prefixed name's slash may be
plain or escaped (`/api/skills/team/deploys` or `/api/skills/team%2Fdeploys`). It takes any token on a shared honed
(401 without one) and answers 404 for a name no skill has:

```sh
curl -H "Authorization: Bearer $HONED_TOKEN" https://honed.example.com/api/skills/team%2Fdeploys
```

## Develop

```sh
npm install
npm run dev          # the server, from source
npm test             # the reviser is faked, so no Claude is needed
npm run typecheck
npm run build
npm run spec         # regenerates openapi.json and docs/ from the code; the pre-commit hook runs it
```

`src/api.ts` declares every `/api` route, and is the source of `openapi.json`, `docs/API.md` and `docs/index.html`;
`src/mcp.ts` is the source of `mcp.json`, `docs/MCP.md` and `docs/mcp.html`. A test fails if a committed contract
differs from what honed serves, or if honed answers an `/api` route it does not declare.

## License

[MIT](LICENSE) © 2026 Dakota Parker
