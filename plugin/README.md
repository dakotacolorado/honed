# honed for Claude Code

Connects Claude Code to a [honed](https://github.com/dakotacolorado/honed) server, a shared, searchable skills
library your agents give feedback on and propose changes to.

```sh
claude plugin marketplace add dakotacolorado/honed
claude plugin install honed@honed --config url=http://127.0.0.1:4321
```

For a shared server, give it your token in a session with `/plugin configure honed@honed`; Claude Code keeps it in
your system's secure store.

- **MCP**: the server's tools (`search_skills`, `read_skill`, `write_skill`, `give_feedback`, `vote`, …).
- **SessionStart**: lists the library's skills, so the session searches them before it starts work.
- **Stop**: if the session read a skill and gave no feedback on it, asks once for feedback before it ends.
