# Ledger

[![skills.sh](https://skills.sh/b/rufait77/ledger)](https://skills.sh/rufait77/ledger)

Research in, reviewed hand-offs out, every decision indexed. **Ledger** is a
[Claude Code](https://claude.com/claude-code) skill (`/ledger`) for people who make decisions
from research: founders, product leads, consultants, anyone who turns a pile of reading into a
document that others act on.

You drop research exports into a folder and give a half-page problem statement. Claude writes a
spec, checks it against every decision you made before, has Codex review it, lets you accept or
reject the findings, and writes the final hand-off. Every decision in that hand-off is indexed,
so the next spec is checked against it. Your data lives in a private GitHub repository of your
own and follows you to every machine.

Current version: **2.1**.

## What you get

| Command | What it does |
|---|---|
| `/ledger run` | Research files + a problem statement → spec → Codex review → your triage → hand-off. Two stops for you, nothing else. |
| `/ledger check <topic>` | "What have we already decided about X?" Decisions, related hand-offs, old documents, memory. |
| `/ledger find <words>` | "Where did we write about X?" Full-text search over hand-offs, archive digests, original files and memory. Chinese, Japanese and Korean work. |
| `/ledger archive` | Dump old research and specs (PDF, Word, Excel, HTML, Markdown, CSV, images, zips) into an inbox; they become grouped, indexed digests, sorted into your projects. Hundreds at a time. |
| `/ledger projects`, `create-project`, `select-project`, `close-project`, `move` | Projects keep unrelated subjects apart. A spec is only ever checked against its own project. |
| `/ledger status`, `setup`, `config`, `sync`, `abandon` | Housekeeping. `setup` does the machine onboarding itself. |

Everything deterministic (ids, files, indexes, git, Codex) is one Node script that prints JSON.
Claude reads and writes; it never guesses at state.

## Requirements

- [Claude Code](https://claude.com/claude-code) (desktop app or terminal).
- Node.js 20 or newer, git, and the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`).
- Optional: the [Codex CLI](https://github.com/openai/codex) for the review step
  (`npm install -g @openai/codex && codex login`, a ChatGPT account). Without it you paste
  findings from any reviewer and the run continues.

macOS, Windows and Linux.

## Install

**Option A: start from this repository as a template (recommended).** You get the folder
layout, the skill and the pre-approved permissions in one go:

```sh
gh repo create ledger --private --template rufait77/ledger --clone
cd ledger && claude
```

Then type `/ledger setup`. It reads your GitHub identity, points the folder at your new private
repo, installs what it can (Codex, the text extractors) and tells you the one or two sign-ins
it cannot do for you.

**Option B: install only the skill with the skills CLI.** In any folder that should become
your ledger:

```sh
npx skills add rufait77/ledger
claude
```

Then type `/ledger setup`. Claude asks once whether to make this folder your ledger, starts a
git repository, creates your private `<you>/ledger` repo on GitHub and pushes. Claude Code will
ask permission the first time the skill runs `node`, `git`, `gh` or `codex`; answer "Yes, and
don't ask again".

**A second machine:** clone your own `<you>/ledger` repo (or repeat Option A or B) and run
`/ledger setup` there. It syncs with what you already have.

## How a run works

1. Save research (a Gemini or ChatGPT export, a PDF, anything) into `research/inbox/` and type
   `/ledger run`. Claude lists the files and asks for the problem statement.
2. Claude reads the files and every related earlier decision of the project, writes the spec,
   and turns each contradiction with an earlier decision into a question for you.
3. Codex reviews the spec. Claude shows the findings with a recommendation on each.
4. You reply `accept all recommended`, or `accept 1 3, reject 2`, and answer the open questions.
5. Claude applies your verdicts, writes the hand-off into `projects/<project>/handoffs/`,
   indexes its decisions, and syncs. Done.

A rejection reason that generalises ("legal handles compliance, don't add it") is saved as a
preference and applied to future reviews.

## Projects and old files

Work is organised in **projects**. Each has its own runs, hand-offs, archive and memory, and a
spec is checked only against its own project. The first run on a machine asks which project;
the choice is remembered per machine.

Have a backlog of earlier research and specs? Copy them into `archive/inbox/` and type
`/ledger archive`. Claude asks whether everything belongs to one project or should be sorted,
then reads each file in the background, writes a short digest, groups versions of the same
document, keeps the original beside the digest, and empties the inbox. Decisions found in old
documents are kept apart as "never reviewed" and surface as questions in later specs, never as
settled policy. It is resumable: stop any time and run it again, on any machine.

## Where things live

```
research/inbox/              drop new research here
archive/inbox/               drop OLD documents here
PROJECTS.md                  every project, one row (generated)
projects/<slug>/
  runs/R-012-<subject>/      problem.md · spec.md · findings.md · triage.md
  handoffs/H-031-<subject>.md final hand-offs; INDEX.md is generated
  archive/<group>/A-012-….md digests of old documents; sources/ holds the originals
  memory/DECISIONS.md        this project's decisions (generated)
  memory/facts|lessons/      project-specific facts and lessons
memory/
  DECISIONS.md               all projects' decisions in one place (generated)
  preferences|facts|lessons/ how you like things done; company-wide facts; what failed and why
.ledger.local                the project selected on THIS machine (gitignored)
```

Generated files (`PROJECTS.md`, every `INDEX.md`, every `DECISIONS.md`) are rebuilt by the
skill; don't edit them. Hand-offs are append-only: a change of mind is a new hand-off that
supersedes the old one.

## Teams

Fork this repository as your team's private template and every member starts from it with
`gh repo create ledger --private --template <org>/ledger --clone`; the skill takes updates from
the template and refuses to push anything back to it. To make sure ledgers only live under
company GitHub accounts, add a `.ledger-team` file to your template:

```json
{ "accountEmailMustMatch": ["example.com"], "accountEmails": ["partner@elsewhere.org"] }
```

`/ledger setup` then verifies that the signed-in account has a verified email at such a domain,
or one of the listed addresses, before it creates or links a personal repo (it asks once for
`gh auth refresh -h github.com -s user:email`, which lets it read the verified emails), and
`sync` refuses any origin owned by another account.

## Updates

`/ledger setup` takes skill updates from this repository each time it runs and leaves your
data alone. With Option B, `npx skills update` does the same for the skill files.

## Privacy

- Your runs, hand-offs, archive and memory live only on your machines and in **your own
  private GitHub repository**. The skill refuses to sync into this template or into any
  organisation repository.
- The spec text is sent to Codex (your ChatGPT account) for review. Nothing else leaves.
- The skills CLI sends anonymous install telemetry to skills.sh; set `DISABLE_TELEMETRY=1`
  to opt out. This repository itself collects nothing.
- Keep secrets out of the ledger. The skill never asks for passwords, keys or tokens.

## Repository layout (for contributors)

The skill is `.claude/skills/ledger/` (`SKILL.md` plus `scripts/`). Everything else is the
folder skeleton a new ledger starts from. `.claude/settings.json` pre-approves the tools the
skill needs. The scripts' optional dependencies (PDF, Word, Excel and zip extraction) are
installed by `/ledger setup` into `.claude/skills/ledger/scripts/node_modules`, which is
gitignored.

Issues and pull requests are welcome. Please keep SKILL.md under 600 lines and keep every
command's output JSON.

## License

[MIT](LICENSE).
