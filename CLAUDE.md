# Working in this package

Keep it fact-dense, and prefer a mechanism (a type, a test, a refusal) to a
comment. `docs/DESIGN.md` is the authority on what this is and why; change it
with the code.

- **The judge's brief is `src/judge-prompt.md`.** Every rule it gives the judge
  that the server can check (paths, SKILL.md frontmatter, sizes) is also checked
  in `domain.ts`, so a bad decision is refused rather than trusted.
- **Refusals are `Refusal`s**, in words the caller can act on: an MCP tool
  returns one as a tool error, the API as `{ error }` with its status, and the
  page shows it beside the button that was pressed.
- **The theme follows `prefers-color-scheme`**, with no toggle.

Gates, each run on its own: `npm run typecheck`, `npm test`, `npm run build`.
Tests fake the judge; after changing `judge.ts` or the prompt, run the server
(`npm run dev -- --dir <scratch dir>`) and put a proposal to the real one.
