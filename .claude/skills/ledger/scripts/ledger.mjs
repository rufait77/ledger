#!/usr/bin/env node
// ledger.mjs — command line for the ledger skill. Every command prints JSON.
//
//   status                               projects, open runs, inbox, archive, last hand-off, git state
//   projects                             list projects (+ selected on this machine, + pre-project content)
//   project create --name "…" [--description "…"]      create and select
//   project select --name "…"            select on this machine (slug, id, name, pick number or partial)
//   project close|reopen --name "…"
//   project move --id H-017|A-012 --to <slug> [--alone] [--keep-memory]   A- takes its versions; facts follow
//   project migrate --to "<name>" [--description "…"]  file pre-project root content into a project
//   inbox                                research files not yet claimed by a run
//   start --slug "…" [--files "a|b"] [--project s]     < problem.md   create a run in the selected project
//   context --run R-012 | --topic "…" [--project s]    what to read: related hand-offs, decisions, memory (one project)
//   review --run R-012 [--model m] [--effort e] [--findings f]   run Codex on the spec (or import pasted findings)
//   config [--model m|default] [--effort e|default]              show/set Codex defaults in .ledger (synced)
//   advance --run R-012 --stage <stage>  move a run forward
//   finalize --run R-012                 < handoff.md   number, file in the run's project, supersede, reindex
//   memory --kind preferences|facts|lessons --name "…" --topics "a,b" --source R-012 [--project s | --global]   < body.md
//   reindex                              regenerate every index file
//   sync [--message "…"]                 commit, pull --rebase, push
//   abandon --run R-012 [--reason "…"]
//   setup [--repo-name ledger]           make this machine ready: remotes, personal repo, sync, template updates, installs
//   init [--template <url>]              scaffold a new ledger repo in the current folder
//   archive next [--size 8] --project s | --sort      old files: hash + extract the inbox, hand out the next batch of briefs
//   archive add --name <file> --project s | --sort    < digest.md   file one digest
//   archive status | scan | unlock       progress, a dry scan (also deletes exact duplicates), clear the machine lock
//   find --query "…" [--project s | --all]            full-text search: hand-offs, digests, sources, memory

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './lib/fm.mjs';

process.noDeprecation = true; // Windows spawns CLI shims through a shell, which Node warns about

import { addEntry, archiveStatus, nextBatch, scanInbox, unlock } from './lib/archive.mjs';
import { loadArchive, loadHandoffs, searchAll, selectContext, writeIndexes } from './lib/index.mjs';
import { migrateLegacy, moveEntry } from './lib/migrate.mjs';
import { RESTART_ENV, ROOT_FOLDERS, onboard, reindexWithCodeOnDisk } from './lib/onboard.mjs';
import { createProject, getProject, legacyContent, listProjects, openProjects, resolveProject, selectedProject, setProjectStatus, setSelectedProject } from './lib/projects.mjs';
import {
	codexConfig, findRoot, git, gitState, nextId, paths, readJson, readStdin, rel, run, safeList, setCodexConfig, sha256, slugify,
	sync, today, writeJson,
} from './lib/repo.mjs';

const STAGES = ['intake', 'spec', 'review', 'triage', 'handoff', 'done', 'abandoned'];
const CODEX_TIMEOUT_MS = 15 * 60 * 1000;
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

function parseArgs(argv) {
	const opts = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) opts[a.slice(2)] = true;
			else opts[a.slice(2)] = argv[++i];
		} else opts._.push(a);
	}
	return opts;
}

function print(obj) {
	process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function fail(error, extra = {}) {
	print({ ok: false, error, ...extra });
	process.exit(1);
}

/** The document a command takes: stdin, or `--file <path>` for shells without a heredoc (PowerShell). */
function inputText(opts) {
	if (opts.file && opts.file !== true) {
		const p = path.resolve(String(opts.file));
		if (!fs.existsSync(p)) fail(`No file ${opts.file}.`);
		return fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
	}
	return readStdin();
}

// ---------------------------------------------------------------- projects

function projectSummary(root, p) {
	const handoffs = loadHandoffs(root, p.slug);
	const archive = loadArchive(root, p.slug);
	const open = listRuns(root).filter((r) => r.project === p.slug && !['done', 'abandoned'].includes(r.meta.stage));
	const last = [...handoffs.map((h) => h.data.date), ...archive.map((a) => String(a.data.added || '')), ...open.map((r) => String(r.meta.updated || '').slice(0, 10))].filter(Boolean).sort().pop() || p.created;
	return {
		id: p.id,
		slug: p.slug,
		name: p.name,
		description: p.description,
		status: p.status,
		created: p.created,
		handoffs: handoffs.length,
		decisions: handoffs.reduce((n, h) => n + h.data.decisions.length, 0),
		archive: archive.length,
		openRuns: open.map((r) => ({ id: r.id, slug: r.meta.slug, stage: r.meta.stage })),
		lastActivity: last,
	};
}

function projectsReport(root) {
	return { selected: selectedProject(root), projects: listProjects(root).map((p) => projectSummary(root, p)), legacy: legacyContent(root) };
}

/** The project a command works in: --project (resolved), else the one selected on this machine. */
function pickProject(root, opts) {
	if (opts.project && opts.project !== true) {
		const r = resolveProject(root, String(opts.project));
		if (!r.project) fail(`No project matches "${opts.project}".`, { code: 'unknown-project', candidates: r.candidates.map((c) => c.slug), projects: openProjects(root).map((p) => p.slug) });
		return r.project.slug;
	}
	return selectedProject(root);
}

function requireProject(root, opts) {
	const slug = pickProject(root, opts);
	if (!slug) fail('No project is selected on this machine.', { code: 'no-project', ...projectsReport(root) });
	return slug;
}

function cmdProjects(root) {
	print({ ok: true, ...projectsReport(root) });
}

function cmdProject(root, opts) {
	const sub = opts._[1] || 'list';
	if (sub === 'list') return cmdProjects(root);
	if (sub === 'create') {
		if (!opts.name || opts.name === true) fail('Pass --name "project name".');
		let project;
		try {
			project = createProject(root, String(opts.name), opts.description && opts.description !== true ? String(opts.description) : '');
		} catch (e) {
			fail(e.message);
		}
		setSelectedProject(root, project.slug);
		writeIndexes(root);
		return print({ ok: true, created: true, selected: project.slug, project: projectSummary(root, project), dir: rel(root, project.dir) });
	}
	if (sub === 'select') {
		const r = resolveProject(root, String(opts.name === true ? '' : opts.name || opts._[2] || ''));
		if (!r.project) fail(`No project matches "${opts.name || ''}".`, { code: 'unknown-project', candidates: r.candidates.map((c) => c.slug), ...projectsReport(root) });
		setSelectedProject(root, r.project.slug);
		return print({ ok: true, selected: r.project.slug, project: projectSummary(root, r.project), inbox: unclaimedInbox(root).length });
	}
	if (sub === 'close' || sub === 'reopen') {
		const r = resolveProject(root, String(opts.name || ''));
		if (!r.project) fail(`No project matches "${opts.name || ''}".`, { candidates: r.candidates.map((c) => c.slug) });
		const p = setProjectStatus(root, r.project.slug, sub === 'close' ? 'closed' : 'open');
		writeIndexes(root);
		return print({ ok: true, project: projectSummary(root, p) });
	}
	if (sub === 'move') {
		if (!opts.id || !opts.to) fail('Pass --id H-017 (or A-012) and --to <project>.');
		const r = resolveProject(root, String(opts.to));
		if (!r.project) fail(`No project matches "${opts.to}".`, { candidates: r.candidates.map((c) => c.slug) });
		const res = moveEntry(root, String(opts.id).toUpperCase(), r.project.slug, { alone: Boolean(opts.alone), keepMemory: Boolean(opts['keep-memory']) });
		print(res);
		return process.exit(res.ok ? 0 : 1);
	}
	if (sub === 'migrate') {
		if (!opts.to || opts.to === true) fail('Pass --to "project name" for the pre-project content.');
		if (!legacyContent(root).any) return print({ ok: true, nothingToMigrate: true });
		const res = migrateLegacy(root, { name: String(opts.to), description: opts.description && opts.description !== true ? String(opts.description) : '' });
		if (!selectedProject(root)) setSelectedProject(root, res.project.slug);
		return print({ ...res, selected: selectedProject(root) });
	}
	fail(`Unknown project command "${sub}". Use list, create, select, close, reopen, move or migrate.`);
}

// ---------------------------------------------------------------- runs

function listRuns(root) {
	const scopes = [null, ...listProjects(root).map((p) => p.slug)];
	const out = [];
	for (const project of scopes) {
		const dir = paths(root, project).runs;
		for (const d of safeList(dir).filter((d) => /^R-\d+/.test(d))) {
			const meta = readJson(path.join(dir, d, 'run.json'), null);
			if (meta) out.push({ dir: path.join(dir, d), id: d.match(/^(R-\d+)/)[1], project: meta.project || project, meta });
		}
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

function nextRunId(root) {
	let max = 0;
	for (const r of listRuns(root)) max = Math.max(max, Number(r.id.slice(2)));
	return `R-${String(max + 1).padStart(3, '0')}`;
}

function findRun(root, id) {
	if (!id) return null;
	const prefix = String(id).toUpperCase().match(/^R-\d+/);
	return prefix ? listRuns(root).find((r) => r.id === prefix[0]) || null : null;
}

function saveRun(r) {
	r.meta.updated = new Date().toISOString();
	writeJson(path.join(r.dir, 'run.json'), r.meta);
}

function unclaimedInbox(root) {
	const p = paths(root);
	const claimed = readJson(p.claimed, { files: {} });
	return safeList(p.inbox)
		.filter((f) => !f.startsWith('.'))
		.map((f) => path.join(p.inbox, f))
		.filter((f) => fs.statSync(f).isFile())
		.map((f) => ({ file: f, name: path.basename(f), bytes: fs.statSync(f).size, modified: fs.statSync(f).mtime.toISOString(), hash: sha256(f) }))
		.filter((f) => !claimed.files[f.hash])
		.sort((a, b) => b.modified.localeCompare(a.modified));
}

function runRow(r) {
	return { id: r.id, project: r.project, slug: r.meta.slug, stage: r.meta.stage, started: r.meta.started, updated: r.meta.updated, dir: r.meta && r.dir ? r.dir : null };
}

// ---------------------------------------------------------------- commands

function cmdStatus(root) {
	const runs = listRuns(root);
	const open = runs.filter((r) => !['done', 'abandoned'].includes(r.meta.stage));
	const a = archiveStatus(root);
	const report = projectsReport(root);
	const selected = report.selected;
	const handoffs = selected ? loadHandoffs(root, selected) : [];
	const last = handoffs[handoffs.length - 1];
	print({
		ok: true,
		root,
		selectedProject: selected,
		projects: report.projects,
		legacy: report.legacy,
		openRuns: open.map((r) => ({ ...runRow(r), dir: rel(root, r.dir) })),
		recentDone: runs.filter((r) => r.meta.stage === 'done').slice(-3).map((r) => ({ id: r.id, project: r.project, slug: r.meta.slug, handoff: r.meta.handoff })),
		inbox: unclaimedInbox(root).map(({ name, bytes, modified }) => ({ name, bytes, modified })),
		lastHandoffInSelected: last ? { id: last.data.id, title: last.data.title, date: last.data.date } : null,
		archive: { waiting: a.waiting, unsupported: a.unsupported.length, filed: a.filed, perProject: a.perProject.map((x) => ({ project: x.project, filed: x.filed, groups: x.groups.length })), lock: a.lock, extractors: a.extractors },
		git: gitState(root),
	});
}

function cmdInbox(root) {
	print({ ok: true, files: unclaimedInbox(root).map(({ file, ...rest }) => ({ ...rest, path: rel(root, file) })) });
}

function cmdStart(root, opts) {
	const problem = inputText(opts).trim();
	if (!problem) fail('Pass the problem statement on stdin (or --file <path>).');
	if (!opts.slug) fail('Pass --slug "three to six words naming the subject".');
	const project = requireProject(root, opts);
	const p = paths(root, project);
	const available = unclaimedInbox(root);
	const wanted = opts.files ? String(opts.files).split('|').map((s) => s.trim()).filter(Boolean) : null;
	const chosen = wanted ? available.filter((f) => wanted.includes(f.name) || wanted.includes(rel(root, f.file))) : available;
	const id = nextRunId(root);
	const dir = path.join(p.runs, `${id}-${slugify(opts.slug)}`);
	fs.mkdirSync(path.join(dir, 'research'), { recursive: true });
	const claimed = readJson(p.claimed, { files: {} });
	const moved = [];
	for (const f of chosen) {
		const dest = path.join(dir, 'research', f.name);
		fs.renameSync(f.file, dest);
		claimed.files[f.hash] = { run: id, project, name: f.name, claimed: new Date().toISOString() };
		moved.push(rel(root, dest));
	}
	writeJson(p.claimed, claimed);
	fs.writeFileSync(path.join(dir, 'problem.md'), `# Problem statement\n\n${problem}\n`);
	const meta = { id, project, slug: slugify(opts.slug), title: opts.slug, stage: 'spec', started: new Date().toISOString(), research: moved, handoff: null };
	writeJson(path.join(dir, 'run.json'), meta);
	print({ ok: true, run: id, project, dir: rel(root, dir), research: moved, skippedInbox: available.length - chosen.length, problemFile: rel(root, path.join(dir, 'problem.md')) });
}

function cmdContext(root, opts) {
	let text = opts.topic && opts.topic !== true ? String(opts.topic) : '';
	let r = null;
	let project;
	if (opts.run) {
		r = findRun(root, opts.run);
		if (!r) fail(`No run ${opts.run}.`);
		text = `${text} ${fs.readFileSync(path.join(r.dir, 'problem.md'), 'utf8')} ${r.meta.title}`;
		project = r.project;
	} else project = requireProject(root, opts);
	if (!text.trim()) fail('Pass --run R-012 or --topic "…".');
	const ctx = selectContext(root, text, { project });
	const elsewhere = searchAll(root, text, { project }).elsewhere;
	print({ ok: true, run: r ? r.id : null, project, ...ctx, elsewhere, researchFiles: r ? r.meta.research : [] });
}

/** The reviewer's brief. The same text goes to the Codex CLI (Claude Code edition) or to a reviewer subagent (`review --prompt`). */
function reviewPrompt(specRel) {
	return (
		`You are reviewing a product/engineering specification before it is handed off. Read the file ${specRel} in this repository. ` +
		'Reply with NUMBERED FINDINGS ONLY, each as: "N. <short title> — severity: high|medium|low — what is wrong or missing — what to change". ' +
		'Cover: contradictions, missing scope boundaries, unverified assumptions, risks without mitigations, and anything an engineer could not act on. ' +
		'Do not rewrite the spec, do not add praise, do not add a summary.'
	);
}

function codexReview(root, specRel, outFile, { model, effort }) {
	const prompt = reviewPrompt(specRel);
	const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', root, '--output-last-message', outFile];
	if (model) args.push('-m', model);
	if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
	args.push(prompt);
	const res = run('codex', args, { cwd: root, timeoutMs: CODEX_TIMEOUT_MS });
	if (res.notInstalled) return { ok: false, code: 'codex-not-installed', error: 'Codex CLI is not installed: npm install -g @openai/codex' };
	if (res.timedOut) return { ok: false, code: 'codex-timeout', error: 'Codex did not answer within 15 minutes.' };
	const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : res.stdout;
	if (!res.ok || !text) {
		const signedOut = /log ?in|unauthori[sz]ed|401|not authenticated/i.test(`${res.stderr}\n${res.stdout}`);
		return { ok: false, code: signedOut ? 'codex-not-signed-in' : 'codex-failed', error: (res.stderr || res.stdout || 'no output').slice(-1500) };
	}
	return { ok: true, text };
}

function cmdReview(root, opts) {
	const r = findRun(root, opts.run);
	if (!r) fail(`No run ${opts.run}.`);
	const spec = path.join(r.dir, 'spec.md');
	if (!fs.existsSync(spec)) fail('spec.md does not exist yet; write the spec first.');
	const findings = path.join(r.dir, 'findings.md');
	const defaults = codexConfig(root);
	const model = opts.model === 'default' ? null : opts.model || defaults.model;
	const effort = opts.effort === 'default' ? null : opts.effort || defaults.effort;
	if (effort && !EFFORT_LEVELS.includes(effort)) fail(`--effort must be one of ${EFFORT_LEVELS.join(', ')} (or "default").`);
	if (opts.prompt) {
		// No reviewer is run here: the agent hands this prompt to a reviewer of its own (a fresh-context subagent)
		// and imports the reply with --findings. Used by the Codex edition, where a nested Codex cannot run.
		return print({
			ok: true, run: r.id, project: r.project, stage: r.meta.stage, specFile: rel(root, spec), prompt: reviewPrompt(rel(root, spec)),
			next: `review --run ${r.id} --findings <file holding the reviewer's reply> --reviewer <who reviewed>`,
		});
	}
	let source;
	if (opts.findings) {
		const src = path.resolve(root, String(opts.findings));
		if (!fs.existsSync(src)) fail(`No file ${opts.findings}.`);
		const reviewer = opts.reviewer && opts.reviewer !== true ? String(opts.reviewer) : null;
		fs.writeFileSync(findings, `# Review findings (${reviewer ? `from ${reviewer}` : 'pasted from Codex'}, ${today()})\n\n${fs.readFileSync(src, 'utf8').trim()}\n`);
		source = reviewer || 'pasted';
	} else {
		const tmp = path.join(r.dir, '.codex-output.md');
		const res = codexReview(root, rel(root, spec), tmp, { model, effort });
		if (fs.existsSync(tmp)) fs.rmSync(tmp);
		if (!res.ok) {
			r.meta.stage = 'review';
			r.meta.reviewError = res.code;
			saveRun(r);
			fail(res.error, { code: res.code, run: r.id, model, effort, hint: 'Fix Codex, or save the findings from the Codex app to a file and rerun with --findings <file>.' });
		}
		const label = `Codex${model ? ` ${model}` : ''}${effort ? `, effort ${effort}` : ''}, ${today()}`;
		fs.writeFileSync(findings, `# Review findings (${label})\n\n${res.text}\n`);
		source = 'codex';
	}
	r.meta.stage = 'triage';
	r.meta.review = { source, model: model || 'codex default', effort: effort || 'codex default', at: new Date().toISOString() };
	delete r.meta.reviewError;
	saveRun(r);
	const count = (fs.readFileSync(findings, 'utf8').match(/^\s*\d+[.)]\s/gm) || []).length;
	print({ ok: true, run: r.id, project: r.project, source, model: r.meta.review.model, effort: r.meta.review.effort, findingsFile: rel(root, findings), findingsCount: count, text: fs.readFileSync(findings, 'utf8') });
}

function cmdConfig(root, opts) {
	const patch = {};
	if (opts.model !== undefined) patch.model = opts.model === true ? null : String(opts.model);
	if (opts.effort !== undefined) {
		const e = opts.effort === true ? null : String(opts.effort);
		if (e && e !== 'default' && !EFFORT_LEVELS.includes(e)) fail(`--effort must be one of ${EFFORT_LEVELS.join(', ')} (or "default").`);
		patch.effort = e;
	}
	const codex = Object.keys(patch).length ? setCodexConfig(root, patch) : codexConfig(root);
	print({ ok: true, changed: Object.keys(patch), codex: { model: codex.model || 'codex default', effort: codex.effort || 'codex default' }, effortLevels: EFFORT_LEVELS, file: '.ledger' });
}

function cmdAdvance(root, opts) {
	const r = findRun(root, opts.run);
	if (!r) fail(`No run ${opts.run}.`);
	if (!STAGES.includes(opts.stage)) fail(`Stage must be one of ${STAGES.join(', ')}.`);
	r.meta.stage = opts.stage;
	saveRun(r);
	print({ ok: true, run: r.id, project: r.project, stage: r.meta.stage });
}

/** Every hand-off number the repo knows about: hand-off files in every project, the hand-off each run
 *  recorded in run.json, and specs/H-NNN folders. A hand-off file deleted by hand therefore never
 *  frees its number for reuse (a gap is harmless; a reused id is not). */
function handoffIdsInUse(root) {
	const ids = new Set();
	for (const scope of [null, ...listProjects(root).map((p) => p.slug)]) {
		const p = paths(root, scope);
		for (const name of safeList(p.handoffs)) {
			const m = name.match(/^H-(\d+)/);
			if (m) ids.add(Number(m[1]));
		}
		for (const name of safeList(path.join(p.base, 'specs'))) {
			const m = name.match(/^H-(\d+)$/);
			if (m) ids.add(Number(m[1]));
		}
	}
	for (const r of listRuns(root)) {
		const m = String(r.meta.handoff || '').match(/H-(\d+)/);
		if (m) ids.add(Number(m[1]));
	}
	return ids;
}

function nextHandoffId(root) {
	const used = handoffIdsInUse(root);
	const max = used.size ? Math.max(...used) : 0;
	return `H-${String(max + 1).padStart(3, '0')}`;
}

const HANDOFF_SECTIONS = ['## Summary', '## Context', '## Decisions', '## What to do', '## Out of scope', '## Open items', '## Sources'];

/** A hand-off is numbered only when it arrived whole: a header with title, topics, summary and
 *  decisions, and a body with every required section, the last one non-empty. A truncated stdin
 *  (the cause of the H-011 gap on 2026-10-14) is refused before an id is allocated. */
function validateHandoff(text) {
	const { data, body, hasFrontmatter } = parseFrontmatter(text);
	const missing = [];
	if (!hasFrontmatter) missing.push('front matter');
	if (!data.title) missing.push('title');
	if (!Array.isArray(data.topics) || data.topics.length === 0) missing.push('topics');
	if (!data.summary) missing.push('summary');
	if (!Array.isArray(data.decisions) || data.decisions.length === 0) missing.push('decisions');
	const lines = String(body || '').split('\n');
	for (const h of HANDOFF_SECTIONS) if (!lines.some((l) => l.trim() === h)) missing.push(h);
	const last = lines.map((l, i) => (l.trim() === HANDOFF_SECTIONS[HANDOFF_SECTIONS.length - 1] ? i : -1)).filter((i) => i >= 0).pop();
	if (last !== undefined && !lines.slice(last + 1).some((l) => l.trim())) missing.push('## Sources (empty)');
	if (missing.length) {
		fail(`The hand-off is incomplete, so no id was allocated: missing ${missing.join(', ')}. Send the whole document again.`, { code: 'incomplete-handoff', missing });
	}
	return { data, body };
}

function cmdFinalize(root, opts) {
	const r = findRun(root, opts.run);
	if (!r) fail(`No run ${opts.run}.`);
	const text = inputText(opts);
	const { data, body } = validateHandoff(text);
	const p = paths(root, r.project);
	fs.mkdirSync(p.handoffs, { recursive: true });
	const id = nextHandoffId(root);
	const file = path.join(p.handoffs, `${id}-${slugify(data.title)}.md`);
	const supersedes = Array.isArray(data.supersedes) ? data.supersedes : data.supersedes ? [data.supersedes] : [];
	const header = {
		id,
		title: data.title,
		date: today(),
		run: r.id,
		project: r.project,
		topics: (Array.isArray(data.topics) ? data.topics : []).map((t) => slugify(t, 30)),
		status: 'final',
		supersedes,
		summary: data.summary || '',
		decisions: Array.isArray(data.decisions) ? data.decisions : [],
	};
	fs.writeFileSync(file, serializeFrontmatter(header, body));
	const superseded = [];
	for (const h of loadHandoffs(root, r.project)) {
		if (!supersedes.includes(h.data.id)) continue;
		const { data: d, body: b } = parseFrontmatter(fs.readFileSync(h.file, 'utf8'));
		fs.writeFileSync(h.file, serializeFrontmatter({ ...d, status: 'superseded', superseded_by: id }, b));
		superseded.push(h.data.id);
	}
	const indexes = writeIndexes(root);
	r.meta.stage = 'done';
	r.meta.handoff = rel(root, file);
	r.meta.finished = new Date().toISOString();
	saveRun(r);
	print({ ok: true, run: r.id, project: r.project, handoff: id, file: rel(root, file), decisions: header.decisions.length, superseded, indexes });
}

function cmdMemory(root, opts) {
	const body = inputText(opts).trim();
	if (!body) fail('Pass the memory text on stdin (or --file <path>).');
	if (!['preferences', 'facts', 'lessons'].includes(opts.kind)) fail('--kind must be preferences, facts or lessons.');
	if (!opts.name) fail('Pass --name "short name".');
	const project = opts.kind === 'preferences' || opts.global ? null : pickProject(root, opts);
	const dir = path.join(paths(root, project).memory, opts.kind);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${slugify(opts.name)}.md`);
	const existed = fs.existsSync(file);
	const header = {
		name: opts.name,
		topics: String(opts.topics || '').split(',').map((t) => slugify(t.trim(), 30)).filter(Boolean),
		date: today(),
		source: opts.source || '',
	};
	fs.writeFileSync(file, serializeFrontmatter(header, `\n${body}\n`));
	const indexes = writeIndexes(root);
	print({ ok: true, scope: project || 'global', file: rel(root, file), replaced: existed, indexes });
}

function cmdReindex(root) {
	print({ ok: true, ...writeIndexes(root) });
}

function cmdSync(root, opts) {
	// A conflict in a generated file is resolved by rebuilding it with the code the pull brought, not the code loaded here.
	const res = sync(root, opts.message, () => reindexWithCodeOnDisk(root));
	print({ ...res, git: gitState(root) });
	process.exit(res.ok ? 0 : 1);
}

function cmdAbandon(root, opts) {
	const r = findRun(root, opts.run);
	if (!r) fail(`No run ${opts.run}.`);
	r.meta.stage = 'abandoned';
	r.meta.abandonReason = opts.reason || '';
	saveRun(r);
	print({ ok: true, run: r.id, project: r.project, stage: 'abandoned' });
}

/** setup: performs every step it can (remotes, personal repo, sync, template updates, author, installs); reports the rest. */
function cmdSetup(root, opts) {
	const result = onboard(root, { login: opts.login, target: opts.target, repoName: opts['repo-name'] });
	if (result.restart) {
		// The pull updated the skill under this process: the same command, once, with the new code. Its JSON is the result.
		const child = spawnSync(process.execPath, process.argv.slice(1), {
			cwd: process.cwd(),
			encoding: 'utf8',
			stdio: ['inherit', 'pipe', 'inherit'],
			maxBuffer: 64 * 1024 * 1024,
			env: { ...process.env, [RESTART_ENV]: JSON.stringify(result.restart) },
		});
		if (child.stdout && child.stdout.trim()) {
			process.stdout.write(child.stdout);
			process.exit(child.status ?? 1);
		}
		print({
			ok: false,
			code: 'setup-restart-failed',
			error: `The pull updated the ledger skill, and setup could not restart with the new version (${child.error ? child.error.message : `exit ${child.status}`}). Run /ledger setup again.`,
			repoOutcome: result.restart.repoOutcome,
			actions: result.restart.actions,
		});
		process.exit(1);
	}
	const runs = listRuns(root).filter((r) => !['done', 'abandoned'].includes(r.meta.stage));
	const a = archiveStatus(root);
	const report = projectsReport(root);
	print({
		...result,
		selectedProject: report.selected,
		projects: report.projects.map(({ id, slug, name, status, handoffs, archive }) => ({ id, slug, name, status, handoffs, archive })),
		legacy: report.legacy,
		openRuns: runs.map((r) => ({ id: r.id, project: r.project, slug: r.meta.slug, stage: r.meta.stage })),
		inbox: unclaimedInbox(root).length,
		archive: { waiting: a.waiting, filed: a.filed, extractors: a.extractors },
	});
}

// What a ledger folder needs besides the marker when the skill was installed on its own (e.g. with the
// skills CLI into an empty folder): the ignore list and the LF rule for generated files that a clone of the
// template brings along. Written only when the file is missing; an existing one is left alone.
const INIT_FILES = {
	'.gitignore': ['.DS_Store', 'node_modules/', '.ledger.local', 'runs/*/.codex-output.md', 'projects/*/runs/*/.codex-output.md', 'archive/.staging/', ''].join('\n'),
	'.gitattributes': [
		'# The skill rewrites these generated files with LF on every machine. Checking them out as LF keeps',
		'# Windows (core.autocrlf=true) from showing an unchanged index as modified after a rebuild.',
		'# Nothing else is listed on purpose: originals in archive sources/ stay exactly as they arrived.',
		'PROJECTS.md text eol=lf', 'INDEX.md text eol=lf', 'DECISIONS.md text eol=lf', '',
	].join('\n'),
};

/** init: make the current folder a ledger (marker, folders, ignore rules, a git repo if there is none). Idempotent. */
function cmdInit(opts) {
	const root = process.cwd();
	const actions = [];
	if (!gitState(root).isRepo) {
		const g = git(root, ['init', '-q', '-b', 'main']);
		if (g.ok) actions.push('started a git repository here (branch main)');
		else fail(`Could not start a git repository here: ${g.stderr || g.stdout}`);
	}
	for (const [name, content] of Object.entries(INIT_FILES)) {
		if (fs.existsSync(path.join(root, name))) continue;
		fs.writeFileSync(path.join(root, name), content);
		actions.push(`wrote ${name}`);
	}
	for (const d of ROOT_FOLDERS) {
		fs.mkdirSync(path.join(root, d), { recursive: true });
		const keep = path.join(root, d, '.gitkeep');
		if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
	}
	const marker = path.join(root, '.ledger');
	const existing = readJson(marker, null);
	if (!existing) {
		writeJson(marker, { version: 2, created: today(), template: opts.template || null });
		actions.push('wrote the .ledger marker' + (opts.template ? ` (template: ${opts.template})` : ''));
	} else if (opts.template && existing.template !== opts.template) writeJson(marker, { ...existing, template: opts.template });
	if (!fs.existsSync(paths(root).claimed)) writeJson(paths(root).claimed, { files: {} });
	print({ ok: true, root, actions, ...writeIndexes(root) });
}

/** archive <sub>: next (batch + briefs), add (file one digest), status, scan, unlock. */
async function cmdArchive(root, opts) {
	const sub = opts._[1] || 'status';
	const sort = Boolean(opts.sort);
	if (sub === 'next') {
		const size = opts.size ? Math.max(1, Math.min(20, Number(opts.size) || 8)) : 8;
		const project = sort ? null : requireProject(root, opts);
		const res = await nextBatch(root, { size, force: Boolean(opts.force), project, sort });
		print(res);
		process.exit(res.ok ? 0 : 1);
	}
	if (sub === 'add') {
		const text = inputText(opts);
		if (!text.trim()) fail('Pass the digest (header + body) on stdin (or --file <path>).');
		const project = sort ? null : requireProject(root, opts);
		const res = addEntry(root, opts.name, text, { project, sort });
		print(res);
		process.exit(res.ok ? 0 : 1);
	}
	if (sub === 'scan') {
		const project = sort ? null : pickProject(root, opts);
		const res = await scanInbox(root, { project, sort: sort || !project });
		print({ ok: true, ...res, entries: res.entries.map(({ brief: _b, head: _h, ...e }) => e) });
		return;
	}
	if (sub === 'unlock') return print(unlock(root));
	if (sub === 'status') return print({ ok: true, selectedProject: selectedProject(root), ...archiveStatus(root) });
	fail(`Unknown archive command "${sub}". Use next, add, status, scan or unlock.`);
}

function cmdFind(root, opts) {
	const query = opts.query && opts.query !== true ? String(opts.query) : opts._.slice(1).join(' ');
	if (!query.trim()) fail('Pass --query "words to look for".');
	if (opts.all) return print({ ok: true, ...searchAll(root, query, { all: true, exact: true }) });
	const project = requireProject(root, opts);
	print({ ok: true, ...searchAll(root, query, { project, exact: true }) });
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0];
if (cmd === 'init') {
	cmdInit(opts);
} else {
	const root = findRoot(opts.root ? path.resolve(opts.root) : process.cwd());
	if (!root) fail('Not inside a ledger repo (no .ledger marker found). Open Claude Code in your ledger folder, or run `init` here to make this folder one.', { code: 'not-a-ledger' });
	const commands = {
		status: cmdStatus, projects: cmdProjects, project: cmdProject, inbox: cmdInbox, start: cmdStart, context: cmdContext,
		review: cmdReview, advance: cmdAdvance, finalize: cmdFinalize, memory: cmdMemory, reindex: cmdReindex, sync: cmdSync,
		abandon: cmdAbandon, setup: cmdSetup, config: cmdConfig, archive: cmdArchive, find: cmdFind,
	};
	const fn = commands[cmd];
	if (!fn) fail(`Unknown command "${cmd || ''}". Use one of: ${[...Object.keys(commands), 'init'].join(', ')}.`);
	await fn(root, opts);
}
