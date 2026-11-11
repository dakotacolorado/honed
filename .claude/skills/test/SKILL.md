---
name: test
description: How to run honed's checks. Use before proposing a change to honed, and when reviewing one.
---

# Testing honed

From the repo root, after `npm ci`, each on its own, reading its exit status
(`echo $?`), never piped:

```sh
npm run typecheck
npm test
npm run build
```

Node 24 or later. `typecheck` is `tsc --noEmit`; `test` runs every
`src/**/*.spec.ts` with `node --test`; `build` writes `dist/`, what the
package publishes.

Every change bumps the version in `package.json` (at least the patch:
`npm version patch --no-git-tag-version`), since a version already tagged
`v<version>` is never released again.
