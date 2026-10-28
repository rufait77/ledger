# Ledger

This repository is its owner's decision ledger: research goes in, specs are reviewed, and
final hand-off drafts come out, with every decision indexed so later work is checked
against it. The `ledger` skill in `.agents/skills/ledger/` runs the whole workflow; type
`$ledger` (for example `$ledger run`, `$ledger check pricing`, `$ledger archive`).

## At the start of every session

1. Read `memory/INDEX.md` and every file under `memory/preferences/`. They say how the owner
   wants things done.
2. If the request is about the workflow (a problem to spec, findings to triage, "what did
   we decide about X"), use the `ledger` skill. Don't improvise the pipeline by hand.

## Rules

- **Everything lives in a project** (`projects/<slug>/`): runs, hand-offs, archive, project
  memory. Unrelated subjects never share an index or a decision check. The project selected
  on this machine is in `.ledger.local`; the skill asks when none is selected. Ids stay
  unique across the repo.
- **Generated files are never edited by hand:** `PROJECTS.md`, every `INDEX.md`, every
  `DECISIONS.md`. The skill regenerates them.
- **Hand-offs are append-only.** A change of mind is a new hand-off that `supersedes` the
  old one, never an edit of the old file.
- **Decisions are checked, not assumed.** A spec names every related earlier decision and
  turns every contradiction into a question for the owner. Superseded decisions are history.
- **The archive is prior work, not policy.** `archive/` holds digests of old documents
  (`A-NNN`), grouped by subject, with the originals in each group's `sources/`. Decisions
  found there were never triaged: surface them as questions, never as settled. Old files
  go through `$ledger archive` (dropped in `archive/inbox/`), never filed by hand.
- **The owner decides twice:** the problem statement and the triage of review findings.
  Everything else runs without asking.
- **No secrets** in any file here: no passwords, API keys or tokens.
- **No git by hand.** The skill commits, pulls and pushes at the start and end of each mode.
- Hand-off drafts are written for engineers unless a preference file says otherwise.
