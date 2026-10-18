# Setting up Ledger on a machine

Once per machine, about 10 minutes. Claude does most of it; you do one or two browser sign-ins.

## 1. Tools

Check what is there:

```sh
git --version            # macOS offers the "command line tools" install if git is missing
node -v                  # need v20 or newer; otherwise install the LTS from https://nodejs.org
gh --version             # GitHub CLI: https://cli.github.com (brew install gh · winget install GitHub.cli · apt install gh)
```

Sign in to GitHub once:

```sh
gh auth login            # GitHub.com → HTTPS → Yes → Login with a web browser → approve
```

Optional, for the review step. Codex signs in with a ChatGPT account:

```sh
npm install -g @openai/codex && codex login
```

## 2. Get the folder

Either start from the template (gives you the folder layout and the skill in one go):

```sh
gh repo create ledger --private --template rufait77/ledger --clone
```

or install only the skill into a folder of your choice:

```sh
mkdir ledger && cd ledger && npx skills add rufait77/ledger
```

Second machine? Clone your own `<you>/ledger` repo instead; the next step sorts out the rest.

## 3. Open Claude Code in the folder and let it finish

- Claude desktop app: **Code** tab → new session → choose the `ledger` folder (local session).
- Or a terminal: `cd ledger && claude`

Type `/ledger setup`. Claude then, on its own: reads your GitHub identity, points this folder at
**your private personal repo** `<you>/ledger` (creating it if needed, or syncing with it if it
exists), takes any skill updates from the template, sets the commit author, installs anything
missing it can install, and reports whether you're ready for a run. If the folder is not a
ledger yet (skill-only install), it asks once and makes it one. Nothing of yours is ever synced
to the template or to an organisation repo; the skill refuses.

If it asks you to run `gh auth login` or `codex login`, do that in a terminal, come back and
say "done"; it continues from there.

## 4. Projects

Work is organised in projects, each with its own hand-offs, decisions and archive, so unrelated
subjects never mix. The first `/ledger run` on a machine asks which project to work in, or lets
you create one; the choice is remembered on that machine until you say
`/ledger select-project <name>`. `/ledger projects` lists them.

## 5. Where things go

| What | Where |
|---|---|
| Research exports | drop into `research/inbox/` (claimed by the next run in the selected project) |
| Each run's files (problem, spec, findings, triage) | `projects/<project>/runs/R-NNN-<subject>/` |
| Final hand-off drafts | `projects/<project>/handoffs/H-NNN-<subject>.md`, listed in that folder's `INDEX.md` |
| Every decision of a project | `projects/<project>/memory/DECISIONS.md`; `memory/DECISIONS.md` at the root rolls all projects up |
| Preferences, company-wide facts and lessons | `memory/preferences/`, `memory/facts/`, `memory/lessons/` (project-specific facts and lessons sit in the project) |
| Old research and specs | drop into `archive/inbox/`, then `/ledger archive`; they end up as digests in `projects/<project>/archive/<subject>/` |
| The list of projects | `PROJECTS.md` |

Everything syncs through git automatically, to your own repo; you never run git yourself.

## 6. Old files (optional, once)

If you have a pile of earlier research and specs (PDF, Word, Excel, HTML, Markdown, CSV, images,
or zip files holding any of those; any number), copy them all into `archive/inbox/` and type
`/ledger archive`. Zips are unpacked for you and removed. Claude asks whether everything belongs
to the selected project or should be sorted into your projects automatically, then reads each
file in the background, writes a short digest, groups versions of the same document together,
and moves the original into the group's `sources/` folder, so the inbox ends up empty and
nothing is duplicated. Stop whenever you like; `/ledger archive` continues where it left off, on
any machine. Create the projects you know are in the pile first; anything that fits none lands
in an `unsorted` project you can re-home with `/ledger move`.
