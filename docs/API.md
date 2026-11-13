# honed

> Version 0.3.9

honed's JSON API: the skills in the library, the feedback on them, and the judgments that changed them, read by the page and by anything else that wants them. Agents use the MCP server at `/mcp` instead (its docs are at `/docs/mcp`).

## Tokens

A honed with no tokens, started on this machine alone, is local: it answers only requests naming `127.0.0.1`, `localhost` or `[::1]` as their host, needs no token, and treats every caller as an admin.

The first token (`honed token create <name> [--admin]`) makes it shared at once: from then on every request but this contract and the docs carries one, as `Authorization: Bearer honed_…` or as the `honed_token` cookie that signing in on the page sets. A honed started on another host (`--host 0.0.0.0`) is shared from the start.

## Writes

Every write is a `POST` that carries the `x-honed: 1` header, so a cross-site form cannot make one, and takes an admin token. Each is kept as a version of the skill, recorded as a judgment by a person, with the reason given.

## Errors

A refusal answers `{ "error": "…" }` in words a person can act on, with its status: 400 for a request that cannot be done as asked, 401 for a missing or unknown token, 403 for a write without the header or an admin token (or a local honed asked under another host name), 404 for a skill, version or judgment that does not exist, and 409 for a change that conflicts with the skill as it is.

- License: MIT


## Path Table

| Method | Path | Description |
| --- | --- | --- |
| GET | [/api/skills](#getapiskills) | List or search skills |
| GET | [/api/skills/{name}](#getapiskillsname) | Get a skill |
| GET | [/api/judgments/{id}](#getapijudgmentsid) | Get a judgment |
| POST | [/api/skills/{name}/revert](#postapiskillsnamerevert) | Revert a skill to an earlier version |
| POST | [/api/skills/{name}/edit](#postapiskillsnameedit) | Write or remove one of a skill's files |
| POST | [/api/skills/{name}/preview](#postapiskillsnamepreview) | Preview an edit as a diff |
| POST | [/api/skills/{name}/limit](#postapiskillsnamelimit) | Set a skill's size limit |
| POST | [/api/skills/{name}/delete](#postapiskillsnamedelete) | Delete a skill |
| POST | [/api/skills/{name}/judge](#postapiskillsnamejudge) | Revise a skill now |

## Reference Table

| Name | Path | Description |
| --- | --- | --- |
| bearerAuth | [#/components/securitySchemes/bearerAuth](#componentssecurityschemesbearerauth) | A token from `honed token create`. |
| cookieAuth | [#/components/securitySchemes/cookieAuth](#componentssecurityschemescookieauth) | Set by signing in on the page. |
| ListedSkill | [#/components/schemas/ListedSkill](#componentsschemaslistedskill) |  |
| SkillSummary | [#/components/schemas/SkillSummary](#componentsschemasskillsummary) |  |
| Error | [#/components/schemas/Error](#componentsschemaserror) |  |
| SkillDetail | [#/components/schemas/SkillDetail](#componentsschemasskilldetail) |  |
| SkillFile | [#/components/schemas/SkillFile](#componentsschemasskillfile) |  |
| Version | [#/components/schemas/Version](#componentsschemasversion) |  |
| Feedback | [#/components/schemas/Feedback](#componentsschemasfeedback) |  |
| DraftFile | [#/components/schemas/DraftFile](#componentsschemasdraftfile) |  |
| JudgmentDetail | [#/components/schemas/JudgmentDetail](#componentsschemasjudgmentdetail) |  |
| Judgment | [#/components/schemas/Judgment](#componentsschemasjudgment) |  |
| Revert | [#/components/schemas/Revert](#componentsschemasrevert) |  |
| FileChange | [#/components/schemas/FileChange](#componentsschemasfilechange) |  |
| Preview | [#/components/schemas/Preview](#componentsschemaspreview) |  |
| Skill | [#/components/schemas/Skill](#componentsschemasskill) |  |
| Limit | [#/components/schemas/Limit](#componentsschemaslimit) |  |
| Delete | [#/components/schemas/Delete](#componentsschemasdelete) |  |
| Revising | [#/components/schemas/Revising](#componentsschemasrevising) |  |

## Path Details

***

### [GET]/api/skills

- Summary  
  List or search skills

- Operation id  
  listSkills

- Description  
  Every skill in the library, by name; with `q`, the skills whose name, description or text match any of its words, best first, each with where it matched.

- Tags  
  skills

- Security  
  bearerAuth  
  cookieAuth  
  None

#### Parameters(Query)

```typescript
// Words to search for. Omit to list every skill.
q?: string
```

```typescript
// With `q`, the most results to return.
limit?: integer //default: 20
```

#### Responses

- 200 Every skill, by name; with `q`, the matches, best first, each with its `snippet`.

`application/json`

```typescript
#/components/schemas/SkillSummary & {
   // Only with `q`: where the query matched, each match between « and ».
   snippet?: string
 }[]
```

- 401 No token, or one this server did not issue, on a shared honed.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 403 A local honed asked under a host name other than this machine's.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

***

### [GET]/api/skills/{name}

- Summary  
  Get a skill

- Operation id  
  getSkill

- Description  
  A skill with its files, every version, and its latest feedback.

- Tags  
  skills

- Security  
  bearerAuth  
  cookieAuth  
  None

#### Parameters(Path)

```typescript
// The skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`. The slash is not escaped.
name: string //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$
```

#### Responses

- 200 The skill.

`application/json`

```typescript
{
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  name: string
  version: integer
  // ISO 8601, UTC.
  createdAt: string
  // The most text it may hold, set by an admin; null for the library's default.
  maxChars: integer | null
  files: {
    path: string
    content: string
    executable: boolean
  }[]
  versions: {
    // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
    skill: string
    version: integer
    // The commit in the library's git repository that holds it.
    commit: string
    // What changed, in a line.
    note: string
    // The judgment that made it.
    judgment: string
    // ISO 8601, UTC.
    at: string
  }[]
  feedback: {
    id: string
    // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
    skill: string
    // The version it was about; 0 for a skill that did not exist yet.
    version: integer
    // Anything else the agent said; for a new skill, what it is for.
    text: string
    // The exact text of the skill the report is about, found in that version's files; null for a new skill or the honer's own notes.
    quote: string | null
    evidence: Partial(     // A file, with its contents as the agent found them.
{
       path: string
       content: string
     }) & Partial(     // A command the agent ran, with what it printed.
{
       command: string
       output: string
     })[]
    // What the agent did instead of what the quote says, or what it changed; null when there is no quote.
    whatChanged: string | null
    draft: {
      path: string
      content: string
      executable?: boolean
    }[]
    // Its token's name, with the role the agent gave.
    author: string
    // ISO 8601, UTC.
    at: string
    // The judgment that considered it; null while it waits for one.
    judgment: string | null
    // How the judge sorted it: checkable (its evidence shows the quote wrong, so acted on at once) or judgment (held for agreement); null until sorted.
    sort: enum[checkable, judgment, ] | null
    // The judge's reason for sorting it so.
    sortWhy: string | null
    // The judgment that sorted it.
    sortedBy: string | null
  }[]
}
```

- 401 No token, or one this server did not issue, on a shared honed.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 403 A local honed asked under a host name other than this machine's.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 404 No skill has that name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

***

### [GET]/api/judgments/{id}

- Summary  
  Get a judgment

- Operation id  
  getJudgment

- Description  
  One change, or decision not to change, to a skill, with the feedback it considered: why the skill is as it is.

- Tags  
  judgments

- Security  
  bearerAuth  
  cookieAuth  
  None

#### Parameters(Path)

```typescript
// The judgment's id, as a skill's versions and feedback name it.
id: string
```

#### Responses

- 200 The judgment.

`application/json`

```typescript
#/components/schemas/Judgment & {
   feedback: {
     id: string
     // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
     skill: string
     // The version it was about; 0 for a skill that did not exist yet.
     version: integer
     // Anything else the agent said; for a new skill, what it is for.
     text: string
     // The exact text of the skill the report is about, found in that version's files; null for a new skill or the honer's own notes.
     quote: string | null
     evidence: Partial(      // A file, with its contents as the agent found them.
{
        path: string
        content: string
      }) & Partial(      // A command the agent ran, with what it printed.
{
        command: string
        output: string
      })[]
     // What the agent did instead of what the quote says, or what it changed; null when there is no quote.
     whatChanged: string | null
     draft: {
       path: string
       content: string
       executable?: boolean
     }[]
     // Its token's name, with the role the agent gave.
     author: string
     // ISO 8601, UTC.
     at: string
     // The judgment that considered it; null while it waits for one.
     judgment: string | null
     // How the judge sorted it: checkable (its evidence shows the quote wrong, so acted on at once) or judgment (held for agreement); null until sorted.
     sort: enum[checkable, judgment, ] | null
     // The judge's reason for sorting it so.
     sortWhy: string | null
     // The judgment that sorted it.
     sortedBy: string | null
   }[]
 }
```

- 401 No token, or one this server did not issue, on a shared honed.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 403 A local honed asked under a host name other than this machine's.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 404 No judgment has that id.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

***

### [POST]/api/skills/{name}/revert

- Summary  
  Revert a skill to an earlier version

- Operation id  
  revertSkill

- Description  
  Makes a new version holding an earlier version's files. Needs an admin token.

- Tags  
  writes

- Security  
  bearerAuth  
  cookieAuth  
  None

#### Parameters(Path)

```typescript
// The skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`. The slash is not escaped.
name: string //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$
```

#### Headers

```typescript
// Required on every write: a cross-site form cannot send it.
x-honed: enum[1]
```

#### RequestBody

The version to revert to.

- application/json

```typescript
{
  // The version to go back to, from 1 to the one before the current.
  version: Partial(integer) & Partial(string)
  // Why, kept in the skill's history. Defaults to a line saying what was done.
  reason?: string
}
```

#### Responses

- 200 The judgment recording the revert, and the version it made.

`application/json`

```typescript
{
  id: string
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  skill: string
  // The judge revising from feedback, a person's edit, revert or deletion, or a starter shipped with honed.
  by: enum[judge, person, starter]
  // For a person's change, whose token made it.
  actor: string | null
  state: enum[running, done, failed]
  // ISO 8601, UTC.
  startedAt: string
  // ISO 8601, UTC.
  finishedAt: string | null
  // Whether it changed the skill; null while running.
  changed: boolean | null
  // Why: the judge's reasoning, or the reason the person gave.
  reasoning: string
  // What went wrong, for a failed judgment.
  error: string | null
  // The version it made, if it made one; null for a deletion.
  version: integer | null
}
```

- 400 The change cannot be made as asked: the skill would break a rule (its frontmatter, a path, the cap), or a field is missing.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 401 No token, or one this server did not issue, on a shared honed.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 403 No `x-honed` header, a token that is not an admin's, or a local honed asked under another host name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 404 No skill has that name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

***

### [POST]/api/skills/{name}/edit

- Summary  
  Write or remove one of a skill's files

- Operation id  
  editSkill

- Description  
  Writes one file whole, or removes one, as a new version, held to the same rules as any skill. Needs an admin token.

- Tags  
  writes

- Security  
  bearerAuth  
  cookieAuth  
  None

#### Parameters(Path)

```typescript
// The skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`. The slash is not escaped.
name: string //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$
```

#### Headers

```typescript
// Required on every write: a cross-site form cannot send it.
x-honed: enum[1]
```

#### RequestBody

The file to write, or the one to remove.

- application/json

```typescript
{
  // The file to write, relative to the skill: `SKILL.md`, `scripts/check.sh`. Required unless `remove` is given.
  path?: string
  // Its whole new content. A file that exists keeps its executable bit.
  content?: string
  // Instead of writing a file, the path of one to remove.
  remove?: string
  // Why, kept in the skill's history. Defaults to a line saying what was done.
  reason?: string
}
```

#### Responses

- 200 The judgment recording the edit, and the version it made.

`application/json`

```typescript
{
  id: string
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  skill: string
  // The judge revising from feedback, a person's edit, revert or deletion, or a starter shipped with honed.
  by: enum[judge, person, starter]
  // For a person's change, whose token made it.
  actor: string | null
  state: enum[running, done, failed]
  // ISO 8601, UTC.
  startedAt: string
  // ISO 8601, UTC.
  finishedAt: string | null
  // Whether it changed the skill; null while running.
  changed: boolean | null
  // Why: the judge's reasoning, or the reason the person gave.
  reasoning: string
  // What went wrong, for a failed judgment.
  error: string | null
  // The version it made, if it made one; null for a deletion.
  version: integer | null
}
```

- 400 The change cannot be made as asked: the skill would break a rule (its frontmatter, a path, the cap), or a field is missing.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 401 No token, or one this server did not issue, on a shared honed.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 403 No `x-honed` header, a token that is not an admin's, or a local honed asked under another host name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 404 No skill has that name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 409 The change leaves the skill as it is.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

***

### [POST]/api/skills/{name}/preview

- Summary  
  Preview an edit as a diff

- Operation id  
  previewEdit

- Description  
  What the same request to `edit` would change, refused as it would be. Changes nothing. Needs an admin token, since the page shows it before saving.

- Tags  
  writes

- Security  
  bearerAuth  
  cookieAuth  
  None

#### Parameters(Path)

```typescript
// The skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`. The slash is not escaped.
name: string //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$
```

#### Headers

```typescript
// Required on every write: a cross-site form cannot send it.
x-honed: enum[1]
```

#### RequestBody

The file to write, or the one to remove.

- application/json

```typescript
{
  // The file to write, relative to the skill: `SKILL.md`, `scripts/check.sh`. Required unless `remove` is given.
  path?: string
  // Its whole new content. A file that exists keeps its executable bit.
  content?: string
  // Instead of writing a file, the path of one to remove.
  remove?: string
  // Why, kept in the skill's history. Defaults to a line saying what was done.
  reason?: string
}
```

#### Responses

- 200 The diff.

`application/json`

```typescript
{
  // The change as a diff, rendered as an HTML fragment for the page.
  html: string
}
```

- 400 The change cannot be made as asked: the skill would break a rule (its frontmatter, a path, the cap), or a field is missing.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 401 No token, or one this server did not issue, on a shared honed.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 403 No `x-honed` header, a token that is not an admin's, or a local honed asked under another host name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 404 No skill has that name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

***

### [POST]/api/skills/{name}/limit

- Summary  
  Set a skill's size limit

- Operation id  
  setSkillLimit

- Description  
  The most text the skill may hold, all its files together, for the judge's revisions and people's edits alike; it applies to every change from now on, and text already over it may only shrink. Needs an admin token.

- Tags  
  writes

- Security  
  bearerAuth  
  cookieAuth  
  None

#### Parameters(Path)

```typescript
// The skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`. The slash is not escaped.
name: string //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$
```

#### Headers

```typescript
// Required on every write: a cross-site form cannot send it.
x-honed: enum[1]
```

#### RequestBody

The limit to set.

- application/json

```typescript
{
  // The limit in characters, at least 1. Empty or omitted for the library's default.
  maxChars?: Partial(integer) & Partial(string)
}
```

#### Responses

- 200 The skill, with its limit now.

`application/json`

```typescript
{
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  name: string
  version: integer
  // ISO 8601, UTC.
  createdAt: string
  // The most text it may hold, set by an admin; null for the library's default.
  maxChars: integer | null
}
```

- 400 The change cannot be made as asked: the skill would break a rule (its frontmatter, a path, the cap), or a field is missing.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 401 No token, or one this server did not issue, on a shared honed.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 403 No `x-honed` header, a token that is not an admin's, or a local honed asked under another host name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 404 No skill has that name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

***

### [POST]/api/skills/{name}/delete

- Summary  
  Delete a skill

- Operation id  
  deleteSkill

- Description  
  Takes a skill out of the library and search; its history stays in git, and feedback under its name can bring it back. Feedback waiting on it is closed by the deletion. `honed/honer` cannot be deleted. Needs an admin token.

- Tags  
  writes

- Security  
  bearerAuth  
  cookieAuth  
  None

#### Parameters(Path)

```typescript
// The skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`. The slash is not escaped.
name: string //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$
```

#### Headers

```typescript
// Required on every write: a cross-site form cannot send it.
x-honed: enum[1]
```

#### RequestBody

Why.

- application/json

```typescript
{
  // Why, kept in the skill's history. Defaults to a line saying what was done.
  reason?: string
}
```

#### Responses

- 200 The judgment recording the deletion. Its `version` is null.

`application/json`

```typescript
{
  id: string
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  skill: string
  // The judge revising from feedback, a person's edit, revert or deletion, or a starter shipped with honed.
  by: enum[judge, person, starter]
  // For a person's change, whose token made it.
  actor: string | null
  state: enum[running, done, failed]
  // ISO 8601, UTC.
  startedAt: string
  // ISO 8601, UTC.
  finishedAt: string | null
  // Whether it changed the skill; null while running.
  changed: boolean | null
  // Why: the judge's reasoning, or the reason the person gave.
  reasoning: string
  // What went wrong, for a failed judgment.
  error: string | null
  // The version it made, if it made one; null for a deletion.
  version: integer | null
}
```

- 400 The change cannot be made as asked: the skill would break a rule (its frontmatter, a path, the cap), or a field is missing.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 401 No token, or one this server did not issue, on a shared honed.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 403 No `x-honed` header, a token that is not an admin's, or a local honed asked under another host name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 404 No skill has that name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 409 The skill is `honed/honer`.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

***

### [POST]/api/skills/{name}/judge

- Summary  
  Revise a skill now

- Operation id  
  reviseSkill

- Description  
  Has the judge consider the skill now, whatever feedback is waiting, judgment reports held for agreement included, which this approves; the only way `honed/honer` is revised. Answers at once: the judgment appears in the skill's history when done. Needs an admin token.

- Tags  
  writes

- Security  
  bearerAuth  
  cookieAuth  
  None

#### Parameters(Path)

```typescript
// The skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`. The slash is not escaped.
name: string //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$
```

#### Headers

```typescript
// Required on every write: a cross-site form cannot send it.
x-honed: enum[1]
```

#### Responses

- 200 The revision has started.

`application/json`

```typescript
{
  revising: enum[true]
}
```

- 400 The change cannot be made as asked: the skill would break a rule (its frontmatter, a path, the cap), or a field is missing.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 401 No token, or one this server did not issue, on a shared honed.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 403 No `x-honed` header, a token that is not an admin's, or a local honed asked under another host name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 404 No skill has that name.

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

- 409 This server was started without a judge (`--judge off`).

`application/json`

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

## References

### #/components/securitySchemes/bearerAuth

- Type: http
- Scheme: bearer

A token from `honed token create`.

### #/components/securitySchemes/cookieAuth

- Type: apiKey
- In: cookie
- Name: honed_token

Set by signing in on the page.

### #/components/schemas/ListedSkill

```typescript
#/components/schemas/SkillSummary & {
   // Only with `q`: where the query matched, each match between « and ».
   snippet?: string
 }
```

### #/components/schemas/SkillSummary

```typescript
{
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  name: string
  // The description in its SKILL.md's frontmatter.
  description: string
  // Its current version, counting from 1.
  version: integer
  // The text it holds, all its files together, in characters.
  chars: integer
  // The most text it may hold: its own limit, or the library's default.
  limit: integer
  // Feedback on its current version.
  feedback: integer
  // Feedback no revision has considered yet.
  waiting: integer
  // ISO 8601, UTC.
  updatedAt: string
}
```

### #/components/schemas/Error

```typescript
{
  // Why, in words a person can act on.
  error: string
}
```

### #/components/schemas/SkillDetail

```typescript
{
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  name: string
  version: integer
  // ISO 8601, UTC.
  createdAt: string
  // The most text it may hold, set by an admin; null for the library's default.
  maxChars: integer | null
  files: {
    path: string
    content: string
    executable: boolean
  }[]
  versions: {
    // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
    skill: string
    version: integer
    // The commit in the library's git repository that holds it.
    commit: string
    // What changed, in a line.
    note: string
    // The judgment that made it.
    judgment: string
    // ISO 8601, UTC.
    at: string
  }[]
  feedback: {
    id: string
    // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
    skill: string
    // The version it was about; 0 for a skill that did not exist yet.
    version: integer
    // Anything else the agent said; for a new skill, what it is for.
    text: string
    // The exact text of the skill the report is about, found in that version's files; null for a new skill or the honer's own notes.
    quote: string | null
    evidence: Partial(     // A file, with its contents as the agent found them.
{
       path: string
       content: string
     }) & Partial(     // A command the agent ran, with what it printed.
{
       command: string
       output: string
     })[]
    // What the agent did instead of what the quote says, or what it changed; null when there is no quote.
    whatChanged: string | null
    draft: {
      path: string
      content: string
      executable?: boolean
    }[]
    // Its token's name, with the role the agent gave.
    author: string
    // ISO 8601, UTC.
    at: string
    // The judgment that considered it; null while it waits for one.
    judgment: string | null
    // How the judge sorted it: checkable (its evidence shows the quote wrong, so acted on at once) or judgment (held for agreement); null until sorted.
    sort: enum[checkable, judgment, ] | null
    // The judge's reason for sorting it so.
    sortWhy: string | null
    // The judgment that sorted it.
    sortedBy: string | null
  }[]
}
```

### #/components/schemas/SkillFile

```typescript
{
  path: string
  content: string
  executable: boolean
}
```

### #/components/schemas/Version

```typescript
{
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  skill: string
  version: integer
  // The commit in the library's git repository that holds it.
  commit: string
  // What changed, in a line.
  note: string
  // The judgment that made it.
  judgment: string
  // ISO 8601, UTC.
  at: string
}
```

### #/components/schemas/Feedback

```typescript
{
  id: string
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  skill: string
  // The version it was about; 0 for a skill that did not exist yet.
  version: integer
  // Anything else the agent said; for a new skill, what it is for.
  text: string
  // The exact text of the skill the report is about, found in that version's files; null for a new skill or the honer's own notes.
  quote: string | null
  evidence: Partial(   // A file, with its contents as the agent found them.
{
     path: string
     content: string
   }) & Partial(   // A command the agent ran, with what it printed.
{
     command: string
     output: string
   })[]
  // What the agent did instead of what the quote says, or what it changed; null when there is no quote.
  whatChanged: string | null
  draft: {
    path: string
    content: string
    executable?: boolean
  }[]
  // Its token's name, with the role the agent gave.
  author: string
  // ISO 8601, UTC.
  at: string
  // The judgment that considered it; null while it waits for one.
  judgment: string | null
  // How the judge sorted it: checkable (its evidence shows the quote wrong, so acted on at once) or judgment (held for agreement); null until sorted.
  sort: enum[checkable, judgment, ] | null
  // The judge's reason for sorting it so.
  sortWhy: string | null
  // The judgment that sorted it.
  sortedBy: string | null
}
```

### #/components/schemas/DraftFile

```typescript
{
  path: string
  content: string
  executable?: boolean
}
```

### #/components/schemas/JudgmentDetail

```typescript
#/components/schemas/Judgment & {
   feedback: {
     id: string
     // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
     skill: string
     // The version it was about; 0 for a skill that did not exist yet.
     version: integer
     // Anything else the agent said; for a new skill, what it is for.
     text: string
     // The exact text of the skill the report is about, found in that version's files; null for a new skill or the honer's own notes.
     quote: string | null
     evidence: Partial(      // A file, with its contents as the agent found them.
{
        path: string
        content: string
      }) & Partial(      // A command the agent ran, with what it printed.
{
        command: string
        output: string
      })[]
     // What the agent did instead of what the quote says, or what it changed; null when there is no quote.
     whatChanged: string | null
     draft: {
       path: string
       content: string
       executable?: boolean
     }[]
     // Its token's name, with the role the agent gave.
     author: string
     // ISO 8601, UTC.
     at: string
     // The judgment that considered it; null while it waits for one.
     judgment: string | null
     // How the judge sorted it: checkable (its evidence shows the quote wrong, so acted on at once) or judgment (held for agreement); null until sorted.
     sort: enum[checkable, judgment, ] | null
     // The judge's reason for sorting it so.
     sortWhy: string | null
     // The judgment that sorted it.
     sortedBy: string | null
   }[]
 }
```

### #/components/schemas/Judgment

```typescript
{
  id: string
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  skill: string
  // The judge revising from feedback, a person's edit, revert or deletion, or a starter shipped with honed.
  by: enum[judge, person, starter]
  // For a person's change, whose token made it.
  actor: string | null
  state: enum[running, done, failed]
  // ISO 8601, UTC.
  startedAt: string
  // ISO 8601, UTC.
  finishedAt: string | null
  // Whether it changed the skill; null while running.
  changed: boolean | null
  // Why: the judge's reasoning, or the reason the person gave.
  reasoning: string
  // What went wrong, for a failed judgment.
  error: string | null
  // The version it made, if it made one; null for a deletion.
  version: integer | null
}
```

### #/components/schemas/Revert

```typescript
{
  // The version to go back to, from 1 to the one before the current.
  version: Partial(integer) & Partial(string)
  // Why, kept in the skill's history. Defaults to a line saying what was done.
  reason?: string
}
```

### #/components/schemas/FileChange

```typescript
{
  // The file to write, relative to the skill: `SKILL.md`, `scripts/check.sh`. Required unless `remove` is given.
  path?: string
  // Its whole new content. A file that exists keeps its executable bit.
  content?: string
  // Instead of writing a file, the path of one to remove.
  remove?: string
  // Why, kept in the skill's history. Defaults to a line saying what was done.
  reason?: string
}
```

### #/components/schemas/Preview

```typescript
{
  // The change as a diff, rendered as an HTML fragment for the page.
  html: string
}
```

### #/components/schemas/Skill

```typescript
{
  // A skill's name, with its group prefix if it has one: `git-commits`, `team/code-review`.
  name: string
  version: integer
  // ISO 8601, UTC.
  createdAt: string
  // The most text it may hold, set by an admin; null for the library's default.
  maxChars: integer | null
}
```

### #/components/schemas/Limit

```typescript
{
  // The limit in characters, at least 1. Empty or omitted for the library's default.
  maxChars?: Partial(integer) & Partial(string)
}
```

### #/components/schemas/Delete

```typescript
{
  // Why, kept in the skill's history. Defaults to a line saying what was done.
  reason?: string
}
```

### #/components/schemas/Revising

```typescript
{
  revising: enum[true]
}
```