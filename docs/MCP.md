# honed's MCP server

<!-- Generated from src/mcp.ts by `npm run spec`; do not edit. -->

Streamable HTTP at `/mcp`, stateless, answering JSON. A honed with no tokens, started on this machine alone, needs none and
answers only `127.0.0.1`, `localhost` or `[::1]`; once it has tokens, every request carries one as
`Authorization: Bearer honed_…`, from `honed token create`. Feedback is recorded as from that token's name.
`x-honed-namespaces` names the namespaces a session's repo uses, comma-separated: it sees the skills in them and honed's own
`honed/`, and no others. Without it, a session sees only `honed/`.
A refusal comes back as the tool's error, in the server's words.

Claude Code connects with the honed plugin (`claude plugin install honed@honed`), which also asks each session for
feedback. A repo binds its sessions to its namespaces by committing a `.mcp.json` at its root, with each person's
token in `HONED_TOKEN` in their environment (on a honed with no tokens, leave out `Authorization`):

```json
{
  "mcpServers": {
    "honed": {
      "type": "http",
      "url": "http://127.0.0.1:4321/mcp",
      "headers": {
        "Authorization": "Bearer ${HONED_TOKEN}",
        "X-Honed-Namespaces": "your-project, shared"
      }
    }
  }
}
```

The contract is [`mcp.json`](../mcp.json); a running honed serves it at `/mcp.json` and this page at `/docs/mcp`.
Its JSON API is described in [`API.md`](./API.md).

## Instructions

What the server tells an agent when it connects. The first part is the same for every session; the rest names the
skills the session is bound to. Here, as a session bound to no namespace sees it, on an empty library:

> honed is your organization's shared skills library, and it improves from your reports.
>
> - Before a task, search_skills for what it is about (or list_skills), and get_skill any whose description fits. Follow what you read.
> - If you edited something a skill mentions, or a skill gave you wrong information, report it before you finish, quoting the skill's text and showing the evidence. Use submit_feedback: quote is the skill's exact text, evidence the file as it is now or the command and what it printed, what_changed what you did or changed. Otherwise send nothing. Include files when you know the exact fix. Never include secrets or personal details.
> - To add a skill, read honed/skill-writing first, then submit_feedback under the new name with a draft of its SKILL.md.
>
> This session's repo is bound to no namespace, so it sees only honed's own honed/ skills:
> - none
>
> To bind a repo to the namespaces it uses (its own, plus any shared ones), commit this .mcp.json at its root, with your namespaces in x-honed-namespaces, and set HONED_TOKEN in each person's environment:
> {
>   "mcpServers": {
>     "honed": {
>       "type": "http",
>       "url": "http://127.0.0.1:4321/mcp",
>       "headers": {
>         "Authorization": "Bearer ${HONED_TOKEN}",
>         "X-Honed-Namespaces": "your-project, shared"
>       }
>     }
>   }
> }

## Tools

| Tool | Does | Reads only |
| --- | --- | --- |
| [`list_skills`](#list_skills) | List skills | yes |
| [`search_skills`](#search_skills) | Search skills | yes |
| [`get_skill`](#get_skill) | Get a skill | yes |
| [`submit_feedback`](#submit_feedback) | Submit feedback on a skill |  |

### list_skills

Every skill this repo is bound to, with its description.

No input.

### search_skills

Skills whose name, description or text match any word of query, best first, with where each matched.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `query` | string | yes |  |
| `limit` | integer, at most 50 |  |  |

### get_skill

A skill's SKILL.md and the paths of its other files; with path, that one file instead. To run a script, get it and run your copy.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `path` | string |  | One file of the skill, e.g. scripts/check.sh. Omit for SKILL.md and the file list. |
| `version` | integer |  | An earlier version; omit for the latest. |

### submit_feedback

If you edited something a skill mentions, or a skill gave you wrong information, report it before you finish, quoting the skill's text and showing the evidence. quote is that text exactly, evidence what shows it is wrong, and what_changed what you did instead or changed. A report missing any of these, or quoting text the skill does not have, is refused with how to fix it; resubmit it fixed. Include files to suggest exact text. Under a name no skill has yet, it asks for that skill: say what it is for in feedback, follow honed/skill-writing and draft its SKILL.md; no quote is needed. Skills are revised from these reports.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `name` | string | yes | The skill, e.g. team/code-review: an optional prefix for its group, then lowercase letters, digits and hyphens. |
| `quote` | string |  | The exact text in the skill that is wrong or that your edit made out of date, copied from get_skill: a whole sentence or line. Not needed for a new skill. |
| `evidence` | object[] |  | What shows the quote is wrong: each a file with its current contents, or a command with what it printed. Not needed for a new skill. |
| `evidence[].path` | string |  | A file that shows the quote is wrong, e.g. src/api.ts. |
| `evidence[].content` | string |  | That file's current contents, or the part that shows it. |
| `evidence[].command` | string |  | A command you ran, e.g. npm run lint. |
| `evidence[].output` | string |  | What the command actually printed. |
| `what_changed` | string |  | What you did instead of what the quote says, or what you changed that it describes. Not needed for a new skill. |
| `feedback` | string |  | Anything else worth knowing. For a new skill: what it is for. |
| `files` | object[] |  | Optional: files you suggest, each with its whole content. |
| `files[].path` | string | yes |  |
| `files[].content` | string | yes |  |
| `files[].executable` | boolean |  |  |
| `author` | string |  | Your role or task, e.g. reviewer on PR 12. |
