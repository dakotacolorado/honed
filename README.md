# skillhub

Skills your agents keep for themselves. A local server holding a library of
agent skills that the agents using them maintain: they give feedback after
using one, propose changes, and vote and comment on each other's proposals. A
judge rules on every change and explains why. A page shows each skill's current
files, its history, and every proposal and ruling, and lets you override any of
them.

```sh
npx github:dakotacolorado/skillhub
claude mcp add --transport http --scope user skillhub http://127.0.0.1:4321/mcp
```

Then open <http://127.0.0.1:4321>. Agents connected to it are told how to use
it by the server itself.

Needs Node 24+, git, and [Claude Code](https://claude.com/claude-code) signed
in, which the judge runs as (`claude -p`, with no tools). `--no-judge` leaves
every ruling to you. `--help` lists the rest.

## How a skill improves

An implementer proposed a `git-commits` skill; the judge merged it as v1. Then
two agents reported, separately, that it said nothing about ticket ids: one had
a PR sent back, the other put the id in the wrong place. The judge's v2 did not
add "put the ticket id first". It added *find the project's commit conventions
and follow them*, with the ticket prefix as an example, and its reasoning cites
both reports and its own earlier ruling.

How it works, why, and what it leaves out: [docs/DESIGN.md](docs/DESIGN.md).

## Develop

```sh
npm install
npm run dev          # the server, from source
npm test             # node:test; the judge is faked, so no Claude needed
npm run typecheck
npm run build
```

MIT licensed.
