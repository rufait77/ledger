---
name: ledger
description: >-
  A research-to-hand-off pipeline with a decision ledger, organised in projects.
  "/ledger run" takes research files dropped in research/inbox plus a half-page problem
  statement, writes a spec that is checked against every earlier decision of the selected
  project, has Codex review it, lets the user accept or reject the findings, and writes the final
  hand-off draft into the project's handoffs/ with every decision indexed; the run resumes on
  any machine. "/ledger check <topic>" answers "what have we already decided about X".
  "/ledger archive" absorbs a dump of old research and spec files (PDF, Word, HTML, Markdown,
  CSV, images) into grouped digests, per project. "/ledger find <words>" searches everything.
  Projects: /ledger projects, create-project, select-project, close-project, move.
  Also status, setup, sync, abandon, config.
  TRIGGER when: the user runs /ledger, gives a problem statement to spec, has research files
  to turn into a spec or hand-off, pastes Codex review findings or accepts/rejects findings,
  has old documents to archive or process, wants to create, list or switch projects, or asks
  what was decided, planned, researched or written before about a topic ("did we settle
  refunds", "what did the last hand-off say about pricing", "did we ever research X").
  DO NOT TRIGGER for accounting ledgers or bookkeeping, for ordinary coding tasks in other
  repositories, or for questions the current conversation already answers.
argument-hint: "[run | check <topic> [all] | archive [status|unlock] | find <words> [all] | projects | create-project <name> | select-project <name> | close-project <name> | move H-017 to <project> | status | setup | config [model X] [effort Y] | sync | abandon R-NNN]"
allowed-tools: Bash(node:*) Bash(git:*) Bash(gh:*) Bash(codex:*) Agent
---

# ledger: research in, reviewed hand-offs out, every decision indexed, by project

One pipeline, two human decisions. Claude does the intake, the spec, the Codex review round
and the hand-off draft. The user decides the problem statement and the triage of findings.
Everything lives in **projects**: unrelated subjects (a pricing model, a soccer field) never
share an index or a decision check.

```
/ledger run                     start a run in the selected project, or continue the open one
/ledger check <topic> [all]     what we already decided about X in this project (read-only)
/ledger archive                 absorb the old files dropped in archive/inbox; resumable, any machine
/ledger find <words> [all]      where did we write about X: hand-offs, archive, sources, memory
/ledger projects                list projects; which one is selected on this machine
/ledger create-project <name>   create a project and select it
/ledger select-project <name>   switch the selected project on this machine
/ledger close-project <name>    mark a project done (hidden from pick lists, still searchable)
/ledger move H-017 to <project> re-home a hand-off or archive entry (A-012 + its versions) with its facts
/ledger status                  projects, open runs, inbox, archive progress, sync state
/ledger setup                   make this machine ready; does the work itself
/ledger sync                    commit + pull + push by hand (every mode already does it)
/ledger abandon R-012           close a run without a hand-off
/ledger config                  show or set Codex's model and reasoning effort for reviews
```

**Reading the argument.** `$ARGUMENTS`, lower-cased. First word is the mode; empty means
`run`. Everything after `check` or `find` is the topic; a trailing `all` widens it to every
project. `view-projects` means `projects`. A plain question about earlier decisions is `check`;
"did we ever write/research X" is `find`; "I've dropped the old files" is `archive`; a pasted
set of numbered findings, or an "accept 1 3, reject 2" reply, continues the open run.

**The script.** All deterministic work (ids, file moves, indexes, Codex, git) is one script
that always prints JSON:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" <command> [options]
```

Write that full prefix in real commands. It finds the repo root by itself (the `.ledger`
marker), so run it from anywhere inside the repo. Never run `git` yourself; use `sync`.

**Every mode** starts with `sync` (so the indexes are current across machines) and ends with
`sync` (so the other machines see the result). When the pull brings new commits, sync rebuilds
every index (archive, hand-offs, memory, decisions, `PROJECTS.md`) from the files now on disk
and commits the change, so an index that arrived stale is corrected on the spot; its `steps`
then say `rebuilt N index file(s) after the pull`. If sync fails, say so in one line and continue
with the local state; the next sync catches up. **Every reply that works inside a project
opens by naming it** ("Project **pricing-model** · …"), so a wrong selection is caught at a glance.

---

## The repo, in one glance

```
research/inbox/              the user drops Gemini / ChatGPT exports here (global; claimed into the selected project's run)
archive/inbox/               the user dumps OLD research and specs here (global; emptied by `archive`)
projects/<slug>/             one folder per project, e.g. projects/pricing-model/
  project.json               id P-01, name, one-line description, created, status
  runs/R-012-<slug>/         run.json · problem.md · research/ · spec.md · spec-v1.md · findings.md · triage.md
  handoffs/H-031-<slug>.md   final drafts; INDEX.md is generated
  archive/<group>/A-012-….md one digest per old document, grouped by subject; sources/ holds the original + its text
  memory/DECISIONS.md        this project's decisions (hand-off ones, then untriaged legacy ones) (generated)
  memory/facts|lessons/      project-specific facts and lessons; INDEX.md is generated
PROJECTS.md                  every project, one row each (generated)
memory/DECISIONS.md          roll-up of every project's decisions (generated)
memory/preferences|facts|lessons/   global: how the user works, company-wide facts and lessons
.ledger.local                the project selected on THIS machine (gitignored)
```

Ids (R-, H-, A-, P-) are unique across the whole repo, so "H-017 d2" never needs a project
qualifier. Stages in `run.json`: `spec → review → triage → handoff → done` (or `abandoned`).

---

## Projects: selecting, creating, listing

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" projects
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" project create --name "Soccer field" --description "Feasibility of a company soccer field"
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" project select --name "soccer"      # slug, id, name, pick number or unique partial
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" project close --name "soccer"       # or reopen
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" project move --id H-017 --to soccer-field
```

The selection is per machine and persists until changed. Any command that needs a project and
finds none selected fails with `code: no-project` and the project list: that is the pick
prompt below, never an error to apologise for.

**The pick prompt** (whenever a mode needs a project and none is selected):

> No project is selected on this machine. Projects:
> 1. pricing-model · 3 hand-offs · 14 decisions · 12 archived docs · last run 2026-10-02
> 2. soccer-field · 0 hand-offs · 0 decisions · 0 archived · created 2026-10-09
>
> Reply with a number or a name to select one, or `new <name>` to create one.

A number or name → `project select --name <reply>`; `new <name>` → ask one question, "one
line on what this project is about (or skip)", then `project create`. Then continue the mode.

`/ledger create-project <name>` asks that same one-line question, creates, selects, syncs
with `--message "ledger: project <slug> created"`, and reports:

```
ledger - PROJECT CREATED
Project:   soccer-field (P-02) — "Feasibility of a company soccer field"
Folders:   projects/soccer-field/{runs, handoffs, archive, memory}
Selected:  yes, on this machine
Next:      drop research into research/inbox and type /ledger run
```

`/ledger projects` reports from `projects`:

```
ledger - PROJECTS (selected on this machine: pricing-model)
P-01  pricing-model   3 hand-offs · 14 decisions · 12 archived · open run R-012 at triage · last 2026-10-02
P-02  soccer-field   0 hand-offs · 0 decisions · 0 archived · created today
Closed: 1 (pricing-2024)
```

`/ledger select-project <name>` → one line: "Selected **soccer-field** (P-02) on this machine. No
open runs here. Inbox: 0 files." If the name is ambiguous, the result lists `candidates`: ask.

**Pre-project content.** If `projects`, `status` or `setup` report `legacy.any` true (runs,
hand-offs or archive groups at the root, filed before projects existed), ask once before
anything else:

> Your existing 1 run and 1 hand-off (Pricing rollout) were filed before projects existed.
> Name the project they belong to, or say `general`.

Then `project migrate --to "<the name given>" [--description "…"]`, which moves everything into that
project, rewrites paths and headers, regenerates the indexes, and selects it if nothing was
selected. Nothing is renumbered. Then `sync` and continue.

---

## Mode: `run`

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" sync --message "ledger: start of session"
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" status
```

Order of business: (1) `legacy.any` → the migration question above. (2) `selectedProject`
null → the pick prompt. (3) An open run in the selected project → continue it at its `stage`
(sections below); more than one → ask which. Open runs in other projects get one line
("R-009 in soccer-field is waiting at triage") and are not touched. (4) Otherwise Intake.
The user can say `switch` at any stop to pick another project.

### Intake (first stop: the problem statement)

Read `inbox` from `status`. Ask one question, in this shape:

> Project **pricing-model** · 2 new research files: `gemini-pricing.pdf` (today 14:02, 1.2 MB),
> `chatgpt-pricing.md` (today 14:10, 40 KB). What's the problem statement? I'll use all of
> them unless you say otherwise.

If the inbox is empty, still ask for the problem statement; a run can be research-free.
When the user answers, pick a 3–6 word slug naming the subject (never "new run"), then:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" start --slug "pricing model v2 rollout" <<'LEDGER_EOF'
<the problem statement, verbatim>
LEDGER_EOF
```

Add `--files "a.pdf|b.md"` only if the user excluded some. The run is created in the selected
project. Continue straight into Spec.

### Spec (automatic)

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" context --run R-012
```

The result is what to read, and nothing more. It is **strictly this project**:
- `handoffs[]`: related hand-offs with their decisions (`active` or superseded). `body` is
  included only when three or fewer matched; otherwise read a file with Read only if its
  summary makes it clearly load-bearing.
- `archive[]`: digests of OLD documents on the subject (newest version of each only), with
  `legacyDecisions` that were never triaged by the user. Prior work, not policy.
- `memory[]`: every preference (global), plus matching facts and lessons (global and this
  project's). Follow preferences.
- `researchFiles[]`: read each with Read (PDF, MD and DOCX all work).
- `allTopics[]`: reuse these topic names.
- `elsewhere`: hit counts in other projects. Do **not** read them and do not use them in the
  spec; mention them in one line at the triage stop ("soccer-field has 2 related items") so
  the user can `move` something if it was filed in the wrong project.

Then write `projects/<slug>/runs/R-012-…/spec.md` with exactly these sections:

```markdown
# Spec: <title>
Project <slug> · Run R-012 · <date> · topics: a, b

## Problem
<the user's statement, verbatim>

## Prior work and conflicts
- H-017 (2026-09-14, pricing): <one line on what it decided>
- A-012 (2025-03-12, archive, never triaged): <one line on what the old document concluded>
- …
Conflicts to resolve:
1. H-017 d2 says "<decision>"; this statement assumes <X>. Which stands?
2. A-012 d1 (archive, 2025-03, never triaged) said "<conclusion>"; this statement assumes <Y>. Still valid?
(or: "No conflicts with earlier decisions.")

## Proposed solution
## Scope / out of scope
## Risks
## Open questions for the user
<the conflicts above, plus anything the research left unclear; numbered>
## Sources
<research files, hand-offs and memory files actually used>
```

Conflict rule: compare the statement and the proposed solution against every `active`
decision returned by `context`; ignore superseded ones. Every contradiction becomes a
question. Never silently pick a side. Legacy decisions from `archive[]` are weaker: a
contradiction with one is a "still valid?" question, and a hand-off decision on the same
subject always wins over it. Then go straight to Review; no stop here.

### Review (automatic, then the second stop)

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" review --run R-012
```

This runs Codex on the spec and writes `findings.md`. Codex's model and reasoning effort come
from the defaults in `.ledger` (see [Mode: `config`](#mode-config)). If the user asked for
something different for this run ("review with high effort", "use gpt-5.1 for the review"),
add `--model <name>` and/or `--effort minimal|low|medium|high|xhigh`; `default` means Codex's
own default. The result reports which model and effort were used; say so in the triage stop.
If it fails with `codex-not-installed` or `codex-not-signed-in`, stop and tell the user the fix
from the troubleshooting table; they can also paste findings from the Codex app, which you save
to a file and import with `review --run R-012 --findings <file>`.

With findings in hand, rewrite `findings.md` so each finding keeps Codex's text and gains
one line: `**Recommend: accept**, because …` or `**Recommend: reject**, because …`. Base the
recommendation on the spec, the research and the lessons in memory (for example a lesson that
Codex over-flags scope). Then stop:

> Project **pricing-model** · Codex returned 6 findings: 3 recommended accept (1, 3, 5), 3
> reject (2, 4, 6). Reply `accept all recommended`, or `accept 1 3 5, reject 2 4 6`, or tell
> me what to change. Also answer the open questions: (1) H-017 d2 says 15%; your statement
> assumes 20%. Which stands?

Show the findings (title + recommendation, one line each) so they can decide without opening
the file. End your turn.

### Triage (the user decides, then automatic)

Parse the reply: `accept all recommended`, number lists, or free text. Write
`triage.md` in the run folder: one line per finding with verdict and their reason if given, plus
their answers to the open questions. Copy `spec.md` to `spec-v1.md`, then rewrite `spec.md`
applying the accepted findings and the answers; delete the resolved questions from "Open
questions".

If a rejection reason generalises ("don't add compliance sections to pricing specs"), save
it, and tell them you did:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" memory --kind preferences --name "no compliance sections in pricing specs" --topics "pricing,specs" --source R-012 <<'LEDGER_EOF'
The user rejected a Codex finding asking for a compliance section in a pricing spec (R-012): compliance is handled by legal separately. Don't add such sections unless they ask.
LEDGER_EOF
```

Preferences are always global. `--kind lessons` ("X failed because Y") and `--kind facts`
(stable facts) go into the selected project; add `--global` when the fact is company-wide
("the site sells in USD and GBP only"). Then `advance --run R-012 --stage handoff` and continue.

### Hand-off (automatic)

Write the draft and hand it to `finalize`, which numbers it, files it in the run's project,
marks superseded hand-offs and regenerates the indexes:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" finalize --run R-012 <<'LEDGER_EOF'
---
title: Pricing model v2 rollout
topics: [pricing, finance]
supersedes: [H-017]
summary: One line for the index, under 160 characters.
decisions:
  - Annual discount stays at 15%.
  - Tier D launches after finance sign-off, target 2026-11-01.
---
## Summary
## Context
## Decisions
<each decision with its reason; the same list as the header, expanded>
## What to do
<concrete, actionable, for engineers unless a preference says otherwise>
## Out of scope
## Open items
<each with an owner and a date where known>
## Sources
LEDGER_EOF
```

Header rules: `decisions` are one sentence each and are what future specs are checked
against, so make them precise ("15%", "2026-11-01", names). `supersedes` lists only
hand-offs of this project whose decision this one replaces. Topics come from `allTopics`.

Then `sync --message "ledger: R-012 → H-031 <title>"` and report:

```
ledger - R-012 DONE
Project:    pricing-model
Hand-off:   projects/pricing-model/handoffs/H-031-pricing-model-v2-rollout.md  (5 decisions, supersedes H-017)
Findings:   6 reviewed · 3 accepted · 3 rejected
Conflicts:  1 resolved (H-017 d2 → 15% stands)
Memory:     +1 preference (no compliance sections in pricing specs)
Elsewhere:  soccer-field has 2 related items (not used)
Synced:     pushed to origin/main | local only: <reason>
```

---

## Mode: `check <topic> [all]`

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" sync --message "ledger: check"
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" context --topic "<topic and its synonyms>"
```

Needs a selected project (else the pick prompt). Expand the topic into its words and close
synonyms before calling (`refunds` → "refunds refund returns chargeback money back"). Digests
and hand-offs are written in English even when the originals are Chinese, so give a Chinese
topic its English words too (`退款` → "退款 refund refunds returns"), and an English topic its
Chinese words when the project's originals are Chinese. Present:
active decisions (with refs and dates), related hand-offs (id, date, title, path), open items
from those hand-offs, matching archive digests with their legacy decisions (clearly marked
"archive, never triaged"), matching memory, and whether anything in the question contradicts
an active decision. End with the footer from `elsewhere`: "Also 2 matches in soccer-field;
say `check <topic> all` to see them." With `all`, run `context --topic … --project <slug>`
for each open project and present each project's section separately. If nothing matched, say
so and list `allTopics`. Read-only: no files change.

## Mode: `find <words> [all]`

"Where did we write about X?" Full text, including superseded archive versions and the
extracted source texts, so it finds things `check` would not:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" find --query "<the words and their synonyms>"          # selected project
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" find --query "<…>" --all                               # every project, hits labelled
```

Chinese, Japanese and Korean words match (compared in two-character pieces), as do ids (`H-017`,
`A-012`), dates (`2026-03-15`, `2026年3月15日`; an entry's own date or month counts too), amounts
and versions (`1234.5678`, `1,000`, `v1.5`) and numbers of three or more digits. Shorter words and
numbers (`40`, `AI`) are ignored; when no word is left, the result's `note` says so. One term (a
word, an id, or one unbroken Chinese phrase) finds every entry that holds it, best first; `matches`
shows the top 12 and `total` counts them all. With several terms, one of them in an entry's title,
topics, summary or decisions is enough; matches only in its text need several.

Present each match on one line: project (when `all`), kind, id, title, date, status (say
"superseded by …" where it applies), path, and the snippet; say "12 of N shown" when `total` is
larger. Then the `elsewhere` footer.
Offer to open one with Read. Read-only. Rule of thumb: `check` for decisions, `find` for documents.

## Mode: `archive`

Old research and specs, hundreds at a time, become grouped digests inside projects, which
`context`, `check` and `find` then see. The user dumps the files in `archive/inbox/`. Supported:
PDF, Word (.docx), Excel (.xlsx, .xls), HTML, Markdown, text, CSV, images (PNG, JPG, WEBP, GIF;
read visually), and zip files, which `next` unpacks into the inbox (members named
`<zip>__<path>`, nested zips three levels deep) and deletes once everything in it is out, so
their contents go through the normal flow; `expanded` in the result says what came out of each.
Only macOS junk (`__MACOSX/`, `.DS_Store`, `._*`) is left out; files in dot-folders such as
`.claude/` come out like any other. A zip that cannot be unpacked whole (unreadable, over 2000
files or 500 MB, or a file in it that cannot be written) stays in the inbox with nothing of it
unpacked, and its `expanded[].error` says why: report it at the end. The mode is resumable: stop
at any point, run `/ledger archive` again on any machine, it continues.

First, `sync --message "ledger: archive start"`, then ask **once per archive session**:

> Archive: file everything into **pricing-model** (the selected project), or sort by project?
> In sort mode each document picks one of your projects (pricing-model, soccer-field); one
> that fits none goes to `unsorted`, which you can re-home later with `/ledger move`.

(If no project is selected and the user does not say "sort", show the pick prompt.) Then:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" archive next --project pricing-model     # fixed
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" archive next --sort                     # sort
```

`next` hashes the inbox, **deletes exact duplicates** of files already filed anywhere or of each
other (listed in `removed`), extracts the text, and returns `batch[]` of up to 8 files, each
with a ready-made `brief` that already carries the mode. If `done` is true, report and stop.
If `code` is `archive-locked`, another machine is mid-way: say so and stop; `archive unlock` only
when the user confirms that machine is idle.

**Dispatch, don't digest.** For every file in `batch[]`, start one subagent (Agent tool,
general-purpose) whose whole prompt is that file's `brief`, verbatim, up to four at a time.
Each subagent reads the extracted text (or looks at the image), writes the digest and files it
itself with `archive add`; its reply is the JSON that `add` printed. The main session never
reads the documents and never writes a digest: it dispatches, checks `ok`, and keeps count.
That is what makes 200 files fit in one or two sessions. Subagents never create projects: in
sort mode they choose an existing one or `unsorted`.

A reply with `ok: false`, or a subagent that errors, leaves its file in the inbox; `next`
offers it again. If the same file fails twice, report it by name and continue without it.
Files `next` lists under `unsupported` stay untouched; mention them at the end.

After each batch, `sync --message "ledger: archive batch, N filed"` (use the same `--project`
or `--sort` on every `next`), print one progress line:

> Filed 8 (A-013..A-020) · pricing-model +5 (new group refund-policy), soccer-field +2, unsorted +1 · 142 left

then call `next` again. Loop until `done`. If the context is compacted on the way, nothing
is lost: the state is on disk and in git, and the next `/ledger archive` continues.

When `done`, report:

```
ledger - ARCHIVE (sort mode)
Filed:      37 documents · pricing-model 24 (9 groups, 3 new) · soccer-field 11 · unsorted 2
Superseded: 5 older versions
Duplicates: 2 deleted from the inbox (identical to A-004, A-019)
Unpacked:   2 zips (14 files)
Zip kept:   site-export.zip (3120 files, over the limit): split it or unpack it by hand
Skipped:    deck.pptx (not a supported type): convert or remove it
Memory:     +2 facts
Synced:     pushed to origin/main
Next:       /ledger move A-031 to <project> for the 2 unsorted ones (A-031, A-034)
```

`/ledger archive status` (or "how far is the archive") runs `archive status` and reports
waiting, filed per project, groups, and whether another machine holds the lock. `extractors`
says whether the PDF, Word, Excel and zip libraries are installed (`setup` installs them);
when one is missing, say so once; the briefs then tell subagents to read those files directly
(zips cannot be unpacked without the library and stay in the inbox, reported in `zipError`).

## Mode: `status`

`sync`, then `status`. Report the selected project, every open project with hand-offs,
decisions, archived docs and open runs, pre-project content if any, unclaimed inbox files,
the archive (`waiting`, `filed`, a lock if any), and git state (ahead/behind/dirty). Suggest
the next action in one line.

## Mode: `setup`

You are the agent on this machine: setup **does** the work, it doesn't hand the user a to-do list.
One command performs everything that can be done without a browser, idempotently:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" setup
```

If that answers `code: not-a-ledger`, the skill was installed on its own into a folder that is
not a ledger yet. Ask once: "Make this folder your ledger? It will hold your runs, hand-offs and
memory and sync to a private repo of yours." On yes, `init --template https://github.com/rufait77/ledger`
(marker, folders, ignore rules, a git repo if there is none), then `setup` again.

What it does, in order: checks Node and git; installs the GitHub CLI if missing (Homebrew on
macOS, winget on Windows); reads the signed-in GitHub identity (`gh api user`); with `.ledger-team`,
verifies a company email on the account (else `repoOutcome: account-not-verified`, nothing is
created); sets the commit author for this repo from it; makes `origin` point at **`<login>/ledger`, the user's private
personal repo**, re-pointing it if the folder was cloned from the shared template or any org;
creates that personal repo if it doesn't exist and pushes, or reconciles with it if it does
(takes its commits, replays local ones on top, pushes); adds a read-only `template` remote and
merges any skill updates from it; installs Codex and the archive's text extractors if missing;
creates folders and rebuilds indexes. The rule it enforces: **nothing of the user's ever syncs
to the template or to an organisation repo.** If the pull or the template merge changed the
skill's scripts, setup restarts once with the new version before the installs, folders and
indexes, so the old code never finishes the job; the result is the restarted run's, and its
`actions` say so.

The only things it can't do are the browser sign-ins. They come back in `yourSteps`: `gh auth login`,
`gh auth refresh -h github.com -s user:email` (lets it see the verified emails) and/or `codex login`.
If `yourSteps` is non-empty:
1. Tell the user to run exactly those commands **in the Terminal app** (not here), one at a time,
   and to come back and say "done". Explain in one line why: the sign-in opens a browser and
   needs an interactive terminal.
2. When they say done, run `setup` again. It picks up where it left off.

If the result's `legacy.any` is true, ask the migration question (Projects section) and run
`project migrate` before reporting. Then report, in this shape and no longer:

```
ledger - SETUP on this machine
GitHub:     @<login> · <email> verified · personal repo <login>/ledger
Repo:       <one line from repoOutcome: "created and pushed" | "linked: took N commits, replayed M" | "already in sync" | "re-pointed from the template to your repo">
Done here:  <each entry of actions, one per line, verbatim>
Template:   <skill updates taken | up to date>
Codex:      installed and signed in | <what's missing>
Projects:   2 (pricing-model, soccer-field) · selected on this machine: pricing-model | none yet
Archive:    <archive.filed> filed · <waiting> waiting · extractors: PDF ok, Word ok | <missing> (optional)
Open runs:  R-012 at triage (pricing-model: pricing model v2) | none · Inbox: 2 files waiting
Ready:      yes, run /ledger run | not yet: <the yourSteps or failed check>
```

Checks marked `optional` (the extractors) never block `ready`. If `repoOutcome` is
`conflict`, say which files and ask the user whether to keep this machine's version or the
repo's; don't guess. Never run `git` yourself to "help".

## Mode: `config`

Codex's model and reasoning effort for reviews. Stored in `.ledger`, so a change syncs to every
machine on the next sync.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" config                       # show
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" config --model gpt-5.1 --effort high
node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" config --model default        # back to Codex's default
```

`/ledger config` alone shows the current values. `/ledger config effort high`, `/ledger config
model gpt-5.1`, `/ledger config model default` set them. Effort levels: minimal, low, medium,
high, xhigh. Don't validate model names yourself; Codex rejects an unknown one at the next review,
and the run then waits at `review` with the error. After a change, `sync` so other machines get it.

## Modes: `sync`, `abandon`, `move`, `close-project`

`sync` runs the script's sync and reports its `steps`. `abandon R-012` asks for a one-line
reason, runs `abandon --run R-012 --reason "…"`, then `sync`. `move H-017 to soccer` runs
`project move --id H-017 --to soccer`, then `sync`. An archive entry moves together with every
entry linked to it by supersedes / superseded_by (its other versions, and drafts a version
replaced), so its chain stays whole. The project facts and lessons whose `source` cites a moved
entry, a moved hand-off or that hand-off's run follow it. Report in one short list: `moved` (ids
and groups) and `memory`, then whatever needs the user: `memoryKept` (stayed, with the reason),
`leftInGroup` (likely siblings left behind, such as a translation kept in its own chain: ask
whether they should move too), `activated` (a superseded version that is now current in the new
project, e.g. an old draft or a translation: ask whether that is right), `sourcesMissing`,
`groupsMerged` and `chainProblem`. Only if the user asks to move one version on its own, add
`--alone`: the versions left behind are relinked around it (`relinked`) and keep the facts drawn
from it; the newest version of a document cannot move alone (`code: newest-version`).
`--keep-memory` leaves facts and lessons where they are.
`close-project` and `reopen` run `project close|reopen --name …`, then `sync`.

---

## Troubleshooting

| Script output | Meaning | Fix |
|---|---|---|
| `not-a-ledger` | Claude Code is open in a folder that is not a ledger | open it in the ledger folder; in `setup`, offer `init` to make this folder one |
| `no-project` | nothing selected on this machine | the pick prompt: select or create, then continue |
| `unknown-project` with `candidates` | the name matched several or none | ask the user which; show `candidates` |
| `legacy.any: true` | runs/hand-offs/archive at the root from before projects | the migration question, then `project migrate` |
| `codex-not-installed` / `codex-not-signed-in` | Codex CLI missing on this machine, or not logged in | Terminal: `npm install -g @openai/codex`, then `codex login` |
| `codex-timeout` | Codex hung | rerun `review`; if it repeats, paste findings from the Codex app |
| sync: `Conflicts in …` | two machines edited the same non-generated file | tell the user which file; resolve by hand once |
| sync: `indexes not rebuilt: reindex failed` | the pull worked, but rebuilding the indexes with the new code failed | run `reindex` to see the error; once it works, `sync` commits the result |
| sync: `template-remote` | origin points at the shared template `rufait77/ledger`, not the user's own repo | show the three commands in the result's `fix` verbatim; nothing was pushed |
| sync: `no remote: local only` | repo has no origin | run `/ledger setup`: it creates `<login>/ledger` and pushes; or `gh repo create ledger --private --template rufait77/ledger --clone` |
| `gh auth status` failing, or check `company account verified` false | GitHub sign-in missing or expired; the sign-in cannot read its emails yet; or the account has no verified company email | Terminal: `gh auth login` with the company account; `gh auth refresh -h github.com -s user:email` when asked. A personal account can never hold a ledger |
| sync: `account-not-verified` / `origin-owner-mismatch` | this machine has not verified the company account, or origin belongs to another account | run `/ledger setup`; nothing was pushed |
| setup: `setup-restart-failed` | the pull updated the skill and the new version did not start | run `/ledger setup` again; the pull is done, so it starts on the new code |
| `archive-locked` | another machine started archiving less than 6 h ago | wait, or `archive unlock` once the user confirms it is idle |
| archive: `extractors.pdf/docx/xlsx/zip: false` | a library is not installed in the skill's scripts folder | run `/ledger setup`; meanwhile subagents read PDF/Word/Excel files directly; zips wait |
| archive: file listed in `unsupported` | not a supported type | the user converts or removes it; it is never deleted by the skill |
| archive: `expanded[].error` | a zip could not be unpacked whole: unreadable, over 2000 files or 500 MB, or a file in it could not be written (e.g. its name is too long) | nothing of it was unpacked and it stays in the inbox; the user splits it or unpacks it by hand, then `/ledger archive` again |
| `archive add` → `ok: false` | a subagent's header is incomplete, or names a project that doesn't exist | the message names the field; the subagent fixes it and retries |
| `finalize` → `incomplete-handoff` | the hand-off did not arrive whole on stdin (a section or header field is missing); no id was allocated | send the whole document again; `missing` names what was absent |

## What NOT to do

- Don't write a spec or hand-off without running `context` first; the conflict check is the
  point of the ledger.
- Don't resolve a conflict yourself. It becomes a question for the user.
- Don't read or use another project's hand-offs, archive or decisions in a spec. Projects are
  strictly separate; `elsewhere` is a footer, not context.
- Don't edit `PROJECTS.md` or any `INDEX.md` / `DECISIONS.md`. Regenerated.
- Don't edit an existing hand-off to change its meaning. Write a new one that supersedes it.
- Don't create a project on your own initiative; the user names projects. Subagents choose
  `unsorted` when nothing fits.
- Don't digest archive documents in the main session, and don't call `archive add` yourself:
  one subagent per file, brief verbatim. Don't delete anything in `archive/inbox/` by hand;
  the script removes exact duplicates and zips it has fully unpacked, nothing else.
- Don't present a legacy (archive) decision as settled policy in a spec or hand-off. It was
  never triaged; it is a question until the user answers it in a run.
- Don't run `git` directly, and don't ask for passwords, keys or tokens in the chat.
- Don't stop more than twice per run (plus the project pick when nothing is selected).
- Don't put full research or transcript text into memory files: one fact per file.
