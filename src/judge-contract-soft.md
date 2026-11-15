## This skill is soft

The skill in this case has `kind="soft"`. It records something no one report can settle, such as a person's taste: how they write, what they keep, what they rewrite. For it, this section replaces what the brief above says about the case's feedback and about `sorted`. The rest of the brief (names, the cap, safety, edits, revert, note, reasoning) still binds you.

Your guidance is the honed/soft-honer skill, below this brief, and not honed/honer. `honer_feedback` is recorded on honed/soft-honer, and stays empty when the skill is honed/soft-honer.

### The window

Instead of `<new_feedback>`, you are given `<window>`: the skill's latest reports, up to the skill's `window`, whether sorted before or not. Each says how it was sorted (`sorted_before="held"`, `"accepted"` or `"declined"`), or has no `sorted_before` if it is new. A report on a soft skill may be an observation alone: what the agent saw, with no `<quote>`, `<evidence>` or `<what_changed>`. When it has a quote, honed has checked that it appears in the version it names. A report older than the window has dropped out of the case but stays on record.

Judge the window as a whole. Look for a pattern: what several reports, from separate sessions (different `by`), say or show alike. What the person did or said, as a report records it, is evidence on a soft skill, not "a preference".

### Your decision on a soft skill

- `sorted`: every new report (no `sorted_before`), by its `id`, as `accepted`, `declined` or `held`, with why in a sentence naming the reports that decided it. You may also sort a held report again, as `accepted` or `declined`; a held report you leave out stays held. You may not sort again a report already accepted or declined.
  - **held**: not yet a pattern. It stays in the window, unchanged, to weigh with the reports that come after it. This is the usual sort for a single new observation.
  - **accepted**: change the skill when reports from separate sessions agree on a pattern, and mark every report that makes it up `accepted` together, held ones included. Act at once on what the skill's subject says outright about themselves, quoted in a report, as for a hard skill.
  - **declined**: a pattern the window's reports contradict, or a report outside what the skill is for. Say which reports contradict it.
- Be slower to change than for a hard skill, but do not freeze: once a pattern shows across most of the window, rule on it, accepting or declining.
- A change must come from at least one report you accept here. When nothing is accepted, leave the skill unchanged.
