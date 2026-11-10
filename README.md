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

That starts the server and its page at <http://127.0.0.1:4321>. Then connect Claude Code with the honed plugin, once:

```sh
claude plugin marketplace add dakotacolorado/honed
claude plugin install honed@honed
```

Every Claude Code session now searches the library before a task and is asked for feedback on any skill it used that fell short.
That is all the setup. Needs Node 24+, git, and [Claude Code](https://claude.com/claude-code) signed in: skills are revised
by Claude Code on your machine, with your login (`claude -p`, with no tools), so there is no API key to set.

## The model

| Tool | |
|---|---|
| `list_skills` | Every skill, with its description |
| `search_skills` | Skills matching what a task is about |
| `get_skill` | A skill's `SKILL.md` and its file list, or one file |
| `submit_feedback` | Where a skill fell short and what it should say, optionally with files. Under a new name, it asks for that skill. |

Skills are folders in Claude Code's format: a `SKILL.md` plus any scripts, references or templates. Each has a
hard cap on its text (20,000 characters by default), so a skill can be revised but never bloated.

Names can have one prefix that groups them: `team/deploys`, `honed/honer`. A skill's `SKILL.md` frontmatter
names only the part after it, as Claude Code expects.

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

Put it behind HTTPS (any reverse proxy). Each person installs the plugin pointed at it, then gives it their token
with `/plugin configure honed@honed` in a session; Claude Code keeps it in the system's secure store:

```sh
claude plugin marketplace add dakotacolorado/honed
claude plugin install honed@honed --config url=https://honed.example.com
```

`--judge` picks who revises: `claude-code` (a Claude Code login on this machine), `api` (the Claude API, with
`ANTHROPIC_API_KEY`; `claude-opus-5-5` unless `--judge-model` names another), `off`, or `auto`, the default, which
takes Claude Code when it is installed and the API when only a key is set. The banner says which one is running.

People sign in to the page with their token; only an admin can edit, revert or delete a skill. With no tokens, honed
answers only its own machine and needs none. **The first token switches honed to token-required at once, even while
it is running**: agents connected without one get 401s until they send it.

`honed --help` lists the options. Agents other than Claude Code can use honed as a plain MCP server at `/mcp`, with
`Authorization: Bearer <token>` on a shared one.

## How it works

One Node process serves the page, a small JSON API and MCP at `/mcp`. Skills live in a git repo under `~/.honed`
(every version is a commit, so the library is readable and portable without honed), with SQLite alongside for
feedback, tokens and full-text search. When feedback calls for it, Claude revises the skill (through Claude Code
headless on a dev machine, or the Claude API on a server), with no tools: it reads the skill, the feedback and its own
past reasoning, and answers with a new version or no change, as JSON against a fixed schema.
The server checks every answer against the same rules as any skill, the cap included, before it keeps it.

## Develop

```sh
npm install
npm run dev          # the server, from source
npm test             # the reviser is faked, so no Claude is needed
npm run typecheck
npm run build
```

## License

[MIT](LICENSE) © 2026 Dakota Parker
