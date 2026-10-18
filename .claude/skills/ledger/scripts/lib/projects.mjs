// projects.mjs — the top-level partition of the ledger. A project owns its runs, hand-offs,
// archive and project memory under projects/<slug>/; the selected project is per machine
// (.ledger.local, gitignored). Ids (R-, H-, A-) stay unique across the whole repo.

import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, safeList, slugify, today, writeJson } from './repo.mjs';

export const UNSORTED = 'unsorted';
export const UNSORTED_NAME = 'Unsorted';
export const UNSORTED_DESCRIPTION = 'Documents the archive could not place in a project; re-home them with /ledger move.';
const PROJECT_FOLDERS = ['runs', 'handoffs', 'archive', 'memory/facts', 'memory/lessons'];

export function listProjects(root) {
	const dir = paths(root).projects;
	return safeList(dir)
		.filter((d) => !d.startsWith('.'))
		.map((slug) => ({ slug, dir: path.join(dir, slug), meta: readJson(path.join(dir, slug, 'project.json'), null) }))
		.filter((p) => p.meta && p.meta.id)
		.map(({ slug, dir: d, meta }) => ({ slug, dir: d, id: meta.id, name: meta.name || slug, description: meta.description || '', created: meta.created || '', status: meta.status || 'open', closed: meta.closed || null }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

export function openProjects(root) {
	return listProjects(root).filter((p) => p.status !== 'closed');
}

export function getProject(root, slug) {
	return listProjects(root).find((p) => p.slug === slug) || null;
}

export function selectedProject(root) {
	const local = readJson(paths(root).local, {});
	return local.project && getProject(root, local.project) ? local.project : null;
}

export function setSelectedProject(root, slug) {
	const file = paths(root).local;
	writeJson(file, { ...readJson(file, {}), project: slug });
}

/** Match a user's words to one project: slug, id, name, pick-list number, or a unique partial match. */
export function resolveProject(root, query) {
	const q = String(query || '').trim().toLowerCase();
	if (!q) return { project: null, candidates: [] };
	const all = listProjects(root);
	const exact = all.find((p) => p.slug === q || p.id.toLowerCase() === q || p.name.toLowerCase() === q);
	if (exact) return { project: exact, candidates: [] };
	const n = Number(q);
	if (Number.isInteger(n) && n >= 1) {
		const open = openProjects(root);
		if (open[n - 1]) return { project: open[n - 1], candidates: [] };
	}
	const slugQ = slugify(q);
	const partial = all.filter((p) => p.slug.includes(slugQ) || slugQ.includes(p.slug) || p.name.toLowerCase().includes(q));
	return partial.length === 1 ? { project: partial[0], candidates: [] } : { project: null, candidates: partial };
}

function nextProjectId(root) {
	let max = 0;
	for (const p of listProjects(root)) {
		const m = String(p.id).match(/^P-(\d+)$/);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `P-${String(max + 1).padStart(2, '0')}`;
}

export function createProject(root, name, description = '') {
	const slug = slugify(name, 40);
	if (!name || !String(name).trim() || slug === 'untitled') throw new Error('Give the project a name.');
	if (getProject(root, slug)) throw new Error(`Project "${slug}" already exists.`);
	if (['inbox', 'projects', 'memory', 'research', 'archive'].includes(slug)) throw new Error(`"${slug}" is a reserved name.`);
	const dir = path.join(paths(root).projects, slug);
	for (const d of PROJECT_FOLDERS) {
		fs.mkdirSync(path.join(dir, d), { recursive: true });
		fs.writeFileSync(path.join(dir, d, '.gitkeep'), '');
	}
	const meta = { id: nextProjectId(root), name: String(name).trim(), description: String(description || '').trim(), created: today(), status: 'open' };
	writeJson(path.join(dir, 'project.json'), meta);
	return { slug, dir, ...meta, closed: null };
}

export function ensureProject(root, slug, name, description) {
	return getProject(root, slug) || createProject(root, name, description);
}

export function setProjectStatus(root, slug, status) {
	const p = getProject(root, slug);
	if (!p) throw new Error(`No project "${slug}".`);
	const file = path.join(p.dir, 'project.json');
	const meta = readJson(file, {});
	writeJson(file, { ...meta, status, closed: status === 'closed' ? today() : null });
	return getProject(root, slug);
}

/** Runs, hand-offs and archive groups still at the root, filed before projects existed. */
export function legacyContent(root) {
	const p = paths(root);
	const runs = safeList(p.runs).filter((d) => /^R-\d+/.test(d)).length;
	const handoffs = safeList(p.handoffs).filter((f) => /^H-\d+.*\.md$/.test(f)).length;
	const archiveGroups = safeList(p.archive).filter((d) => !d.startsWith('.') && d !== 'inbox' && fs.statSync(path.join(p.archive, d)).isDirectory()).length;
	return { runs, handoffs, archiveGroups, any: runs + handoffs + archiveGroups > 0 };
}
