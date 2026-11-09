# Working in this package

Keep it fact-dense, and prefer a mechanism (a type, a test, a refusal) to a comment. `docs/DESIGN.md` is the
authority on what this is and why; change it with the code.

- **The model is skills, feedback and versions, and nothing else.** Four MCP tools, named with AWS's verbs. A new
  idea goes behind them, not beside them: it is an implementation detail until it is something every user must learn.
- **The reviser's brief is `src/judge-prompt.md`.** Every rule it states that the server can check (paths,
  `SKILL.md` frontmatter, the cap) is also checked in `domain.ts`, so a bad revision is refused rather than trusted.
- **Refusals are `Refusal`s**, in words the caller can act on: an MCP tool returns one as a tool error, the API as
  `{ error }` with its status, and the page shows it beside the button that was pressed.
- **The theme follows `prefers-color-scheme`**, with no toggle.

Gates, each run on its own: `npm run typecheck`, `npm test`, `npm run build`. Tests fake the reviser; after changing
`judge.ts` or the prompt, run the server (`npm run dev -- --dir <scratch dir>`) and submit feedback to the real one.
