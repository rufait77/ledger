// repo.mjs — where things are, ids, hashing, and git.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MARKER = '.ledger';
export const LOCAL = '.ledger.local'; // per-machine state (selected project); gitignored
export const PROJECTS_DIR = 'projects';
const GENERATED_FILE = /(^|\/)(PROJECTS\.md|handoffs\/INDEX\.md|memory\/INDEX\.md|memory\/DECISIONS\.md|archive\/INDEX\.md)$/;

/** Generated index files (root or inside any project) are rebuilt, never merged by hand. */
export function isGenerated(file) {
	return GENERATED_FILE.test(String(file).replace(/\\/g, '/'));
}

export function findRoot(start = process.cwd()) {
	let dir = path.resolve(start);
	for (;;) {
		if (fs.existsSync(path.join(dir, MARKER))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Where things are. With a project slug, runs/handoffs/archive/memory are the project's;
 * without one they are the root's (global memory, and pre-project "legacy" content).
 * The two drop zones (research/inbox, archive/inbox) and the archive state are always global.
 */
export function paths(root, project = null) {
	const base = project ? path.join(root, PROJECTS_DIR, project) : root;
	return {
		root,
		project,
		base,
		inbox: path.join(root, 'research', 'inbox'),
		claimed: path.join(root, 'research', '.claimed.json'),
		runs: path.join(base, 'runs'),
		handoffs: path.join(base, 'handoffs'),
		memory: path.join(base, 'memory'),
		globalMemory: path.join(root, 'memory'),
		archive: path.join(base, 'archive'),
		archiveInbox: path.join(root, 'archive', 'inbox'),
		archiveState: path.join(root, 'archive', '.state.json'),
		archiveStaging: path.join(root, 'archive', '.staging'),
		projects: path.join(root, PROJECTS_DIR),
		local: path.join(root, LOCAL),
	};
}

export function rel(root, p) {
	return path.relative(root, p).split(path.sep).join('/');
}

export function today() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function slugify(text, max = 48) {
	const s = String(text || '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max)
		.replace(/-+$/g, '');
	return s || 'untitled';
}

/** Next sequential id in a folder: R-001, H-017 ... (folders or files named <prefix>-NNN-...). */
export function nextId(dir, prefix) {
	let max = 0;
	for (const name of safeList(dir)) {
		const m = name.match(new RegExp(`^${prefix}-(\\d+)`));
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

export function safeList(dir) {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

export function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

export function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function sha256(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function readStdin() {
	try {
		return fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); // PowerShell pipes and Windows editors prepend a BOM
	} catch {
		return '';
	}
}

const IS_WINDOWS = process.platform === 'win32';

/** Windows runs CLI shims (.cmd) through cmd.exe, which only sees one string: quote each argument ourselves. */
function quoteForCmd(arg) {
	const s = String(arg);
	return /^[\w.,:\/=@+-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Windows, shell-free: a real .exe is run by its full path; an npm shim (codex.cmd / codex.ps1)
 * is run as Node + its JavaScript entry. cmd.exe is a last resort, because it mangles arguments
 * that contain quotes, `<` or `|` (a review prompt does).
 */
function resolveWindows(cmd) {
	if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return { file: cmd, prefix: [] }; // an explicit executable path (process.execPath): run it directly, never through cmd.exe
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		if (!dir) continue;
		const exe = path.join(dir, `${cmd}.exe`);
		if (fs.existsSync(exe)) return { file: exe, prefix: [] };
		for (const shim of [`${cmd}.ps1`, `${cmd}.cmd`]) {
			const p = path.join(dir, shim);
			if (!fs.existsSync(p)) continue;
			const m = fs.readFileSync(p, 'utf8').match(/node_modules[\\/][^"'%\s]+\.c?m?js/);
			if (m) return { file: process.execPath, prefix: [path.join(dir, m[0].replace(/\//g, path.sep))] };
		}
	}
	return null;
}

/** Run a command; never throws. Direct exec everywhere it can be; quoted cmd.exe string only as a fallback. */
export function run(cmd, args, { cwd, timeoutMs = 120000, env = {} } = {}) {
	const win = IS_WINDOWS ? resolveWindows(cmd) : null;
	const res = win
		? spawnSync(win.file, [...win.prefix, ...args], {
				cwd,
				encoding: 'utf8',
				timeout: timeoutMs,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', NO_COLOR: '1', ...env },
			})
		: IS_WINDOWS
		? spawnSync([cmd, ...args.map(quoteForCmd)].join(' '), {
				cwd,
				encoding: 'utf8',
				timeout: timeoutMs,
				shell: true,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', NO_COLOR: '1', ...env },
			})
		: spawnSync(cmd, args, {
				cwd,
				encoding: 'utf8',
				timeout: timeoutMs,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', NO_COLOR: '1', ...env },
			});
	return {
		ok: res.status === 0 && !res.error,
		code: res.status,
		notInstalled: Boolean(res.error && res.error.code === 'ENOENT') || /not recognized|command not found/i.test(res.stderr || ''),
		timedOut: Boolean(res.error && res.error.code === 'ETIMEDOUT'),
		stdout: (res.stdout || '').trim(),
		stderr: (res.stderr || '').trim(),
	};
}

export function git(root, args, opts = {}) {
	return run('git', args, { cwd: root, ...opts });
}

/** The template repo this ledger was copied from (recorded in the .ledger marker). Never a sync target. */
export function templateRemote(root) {
	const marker = readJson(path.join(root, MARKER), {});
	return marker.template ? String(marker.template).trim() : null;
}

/** Codex defaults from the .ledger marker: { model, effort }. Unset = Codex's own defaults. */
export function codexConfig(root) {
	const marker = readJson(path.join(root, MARKER), {});
	const c = marker.codex && typeof marker.codex === 'object' ? marker.codex : {};
	return { model: c.model || null, effort: c.effort || null };
}

export function setCodexConfig(root, patch) {
	const file = path.join(root, MARKER);
	const marker = readJson(file, { version: 1 });
	const codex = { ...(marker.codex || {}) };
	for (const [k, v] of Object.entries(patch)) {
		if (v === null || v === 'default' || v === '') delete codex[k];
		else if (v !== undefined) codex[k] = v;
	}
	writeJson(file, { ...marker, codex });
	return codexConfig(root);
}

export function normalizeRemote(url) {
	return String(url || '').trim().replace(/\.git$/, '').replace(/\/$/, '').replace(/^git@github\.com:/, 'https://github.com/').toLowerCase();
}

export function isTemplateRemote(root, remoteUrl) {
	const template = templateRemote(root);
	return Boolean(template && remoteUrl) && normalizeRemote(remoteUrl) === normalizeRemote(template);
}

export function rehomeCommands() {
	return ['Run /ledger setup: it re-points this folder to your personal repo <you>/ledger (creating it if needed) and pushes.'];
}

export function gitState(root) {
	const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
	if (!inside.ok) return { isRepo: false };
	const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
	const remote = git(root, ['remote', 'get-url', 'origin']);
	const dirty = git(root, ['status', '--porcelain']).stdout.split('\n').filter(Boolean).length;
	let ahead = null;
	let behind = null;
	const counts = git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
	if (counts.ok) [behind, ahead] = counts.stdout.split(/\s+/).map(Number);
	return { isRepo: true, branch, remote: remote.ok ? remote.stdout : null, dirtyFiles: dirty, ahead, behind };
}

/**
 * Commit everything, rebase on the remote, push. Conflicts in generated index files are
 * resolved by regenerating them (the caller passes `regenerate`); anything else aborts
 * the rebase and is reported, so no half-merged state is ever left behind. When the pull
 * brought new commits, every generated file is rebuilt and the change committed before the push.
 */
export function sync(root, message, regenerate) {
	const state = gitState(root);
	if (!state.isRepo) return { ok: false, error: 'Not a git repository.' };
	if (isTemplateRemote(root, state.remote)) {
		return {
			ok: false,
			code: 'template-remote',
			error:
				`origin points at the shared template (${state.remote}). Your runs must live in your own private repo. ` +
				'Nothing was pushed.',
			fix: rehomeCommands(),
		};
	}
	const steps = [];
	if (state.dirtyFiles > 0) {
		git(root, ['add', '-A']);
		const c = git(root, ['commit', '-q', '-m', message || `ledger: ${today()}`]);
		steps.push(c.ok ? 'committed' : `commit: ${c.stderr || c.stdout}`);
	}
	if (!state.remote) return { ok: true, steps: [...steps, 'no remote: local only'], pushed: false };
	const remoteBranch = git(root, ['ls-remote', '--heads', 'origin', state.branch], { timeoutMs: 60000 });
	if (remoteBranch.ok && !remoteBranch.stdout) {
		// First push ever: nothing to rebase on, so publish the branch and set upstream.
		const first = git(root, ['push', '-q', '-u', 'origin', state.branch], { timeoutMs: 180000 });
		steps.push(first.ok ? 'first push, upstream set' : `push: ${first.stderr || first.stdout}`);
		return { ok: first.ok, steps, pushed: first.ok };
	}
	const headBefore = git(root, ['rev-parse', 'HEAD']).stdout;
	const pull = git(root, ['pull', '--rebase', '-q'], { timeoutMs: 180000 });
	if (!pull.ok) {
		const conflicted = git(root, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
		if (conflicted.length && conflicted.every(isGenerated)) {
			if (regenerate() === false) {
				git(root, ['rebase', '--abort']);
				return { ok: false, steps, error: `Could not rebuild ${conflicted.join(', ')} after the pull; rebase aborted, nothing changed.` };
			}
			git(root, ['add', ...conflicted]);
			const cont = git(root, ['-c', 'core.editor=true', 'rebase', '--continue']);
			steps.push(cont.ok ? `regenerated ${conflicted.join(', ')}` : `rebase: ${cont.stderr}`);
			if (!cont.ok) return { ok: false, steps, error: cont.stderr || cont.stdout };
		} else {
			git(root, ['rebase', '--abort']);
			return {
				ok: false,
				steps,
				error: conflicted.length
					? `Conflicts in ${conflicted.join(', ')}; rebase aborted, nothing changed.`
					: pull.stderr || pull.stdout || 'pull failed',
			};
		}
	} else steps.push('pulled');
	// New commits came in: rebuild every generated file from the files now on disk and commit the result.
	// Pulled indexes can be stale: written by an older skill version, combined from two Macs' edits by
	// the rebase, or missing an entry that arrived without its index.
	if (typeof regenerate === 'function' && headBefore && git(root, ['rev-parse', 'HEAD']).stdout !== headBefore) {
		if (regenerate() === false) steps.push('indexes not rebuilt: reindex failed');
		else {
			const listed = (args) => git(root, ['-c', 'core.quotePath=false', ...args]).stdout.split('\n').filter(Boolean);
			const changed = [...listed(['diff', '--name-only']), ...listed(['ls-files', '--others', '--exclude-standard'])].filter(isGenerated);
			if (changed.length) {
				git(root, ['add', '--', ...changed]);
				const c = git(root, ['commit', '-q', '-m', 'ledger: indexes rebuilt after pull']);
				steps.push(c.ok ? `rebuilt ${changed.length} index file(s) after the pull` : `commit: ${c.stderr || c.stdout}`);
			}
		}
	}
	const push = git(root, ['push', '-q'], { timeoutMs: 180000 });
	steps.push(push.ok ? 'pushed' : `push: ${push.stderr || push.stdout}`);
	return { ok: push.ok, steps, pushed: push.ok };
}
