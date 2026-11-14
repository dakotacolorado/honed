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

honed is a shared library of Claude Code skills. Agents read skills from it
over MCP, report where a skill was wrong, and honed revises the skill from
those reports.

## Run it

```sh
npx @dakotajp/honed
```

This starts honed and its page at <http://127.0.0.1:4321>. It needs Node 24 or
later, git, and a way for Claude to revise skills: a Claude Code login on the
machine, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`. No `claude`
command needs to be installed.

Connect a repo by committing a `.mcp.json` at its root that names the
namespaces it uses:

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

Set `HONED_TOKEN` in your environment (any value works on a local honed with
no tokens). Each Claude Code session in the repo then sees those skills.

### Share it with a team

```sh
npm install -g @dakotajp/honed
export CLAUDE_CODE_OAUTH_TOKEN=...         # from `claude setup-token`
honed token create your-name --admin --dir /srv/honed
honed --host 0.0.0.0 --dir /srv/honed
```

Put it behind HTTPS. Each person sets `HONED_TOKEN` to their own token, so no
token is committed. Once the first token exists, every request needs one,
even while honed is running. `honed token list` and `honed token revoke
<name>` manage tokens.

## Configure it

| Option | Environment | Default | What it does |
|---|---|---|---|
| `--host` | | `127.0.0.1` | Address to listen on. Any other address shares honed, which then needs a token. |
| `--port` | `HONED_PORT` | `4321` | Port to listen on. |
| `--dir` | `HONED_DIR` | `~/.honed` | Where skills and their records are kept. |
| `--max-chars` | | `20000` | The cap on a skill's text, all its files together. An admin can set each skill's own on its page. |
| `--judge` | `HONED_JUDGE` | `auto` | Who revises skills: `claude-code`, `api`, `off`, or `auto` (Claude Code if it can sign in, else the API if a key is set, else off). |
| `--judge-model` | | Claude Code's own, or `claude-opus-5-5` on the API | The model that revises skills. |
| `--claude` | | the Agent SDK's own | A Claude Code executable to use instead. |
| `--no-judge` | | | Same as `--judge off`. |
| | `CLAUDE_CODE_OAUTH_TOKEN` | | Signs Claude Code in to revise skills. |
| | `ANTHROPIC_API_KEY` | | Signs in to the Claude API to revise skills. |

## Use it

- MCP tools: [`docs/MCP.md`](./docs/MCP.md), served at `/docs/mcp`;
  contract in [`mcp.json`](./mcp.json). The tools are `list_skills`,
  `search_skills`, `get_skill` and `submit_feedback`.
- API reference: [`docs/API.md`](./docs/API.md), served at `/docs/api`;
  contract in [`openapi.json`](./openapi.json).

Read one skill from a script:

```sh
curl -H "Authorization: Bearer $HONED_TOKEN" https://honed.example.com/api/skills/team%2Fdeploys
```

## How it works

- **A skill** is a folder in Claude Code's format: a `SKILL.md` plus any other
  files. Every version is a git commit under `--dir`.
- **A namespace** is a name's prefix, as in `team/deploys`. A session sees
  only the namespaces its `X-Honed-Namespaces` header names, plus `honed/`. A
  skill with no prefix is seen by no session.
- **Feedback** must quote the skill's text that was wrong and show evidence.
  honed revises the skill by editing that text, within the cap, and the
  skill's history names the reports behind each version.
- **A protected skill**, set by an admin on its page, holds each revision
  until an admin approves it.
- **`honed/skill-writing`** says how to write a skill. **`honed/honer`** says
  how revisions are decided; it changes only when an admin chooses
  **Revise now**.
- Only an admin can edit, revert or delete a skill.

## Develop it

```sh
npm install
npm run dev          # the server, from source
npm test
npm run typecheck
npm run build
npm run spec         # regenerates openapi.json, mcp.json and docs/
```

## License

[MIT](LICENSE) © 2026 Dakota Parker
