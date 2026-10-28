// migrate.mjs — moving content between scopes: the one-time migration of pre-project content
// at the root into a project, and re-homing a hand-off or archive entry together with what
// belongs to it (an archive entry's version chain; the project facts and lessons drawn from it).

import fs from 'node:fs';
import path from 'node:path';
import { groupsFor, loadState, saveState, uniqueDest } from './archive.mjs';
import { parseFrontmatter, serializeFrontmatter } from './fm.mjs';
import { loadAllArchive, loadAllHandoffs, loadArchive, writeIndexes } from './index.mjs';
import { createProject, getProject } from './projects.mjs';
import { paths, readJson, rel, safeList, slugify, writeJson } from './repo.mjs';

const SOURCE_ID = /\b[AHR]-\d+\b/g; // what a memory file's `source` can cite: archive entry, hand-off, run

function rewriteHeader(file, patch) {
	const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
	fs.writeFileSync(file, serializeFrontmatter({ ...data, ...patch }, body));
}

function removeIfEmpty(dir) {
	if (!fs.existsSync(dir)) return;
	const left = safeList(dir).filter((f) => !['.gitkeep', 'INDEX.md', '.DS_Store'].includes(f));
	if (left.length) return;
	fs.rmSync(dir, { recursive: true, force: true });
}

function listRunDirs(dir) {
	return safeList(dir).filter((d) => /^R-\d+/.test(d) && fs.statSync(path.join(dir, d)).isDirectory());
}

/** Move every root-level run, hand-off and archive group into one project (created if needed). */
export function migrateLegacy(root, { name, description = '' }) {
	const slug = slugify(name, 40);
	const project = getProject(root, slug) || createProject(root, name, description);
	const from = paths(root);
	const to = paths(root, project.slug);
	const moved = { runs: [], handoffs: [], archiveGroups: [] };
	const fixPath = (s) => (typeof s === 'string' ? s.replace(/^(runs\/|handoffs\/|archive\/)/, `projects/${project.slug}/$1`) : s);

	fs.mkdirSync(to.runs, { recursive: true });
	for (const d of listRunDirs(from.runs)) {
		fs.renameSync(path.join(from.runs, d), path.join(to.runs, d));
		const rj = path.join(to.runs, d, 'run.json');
		const meta = readJson(rj, null);
		if (meta) writeJson(rj, { ...meta, project: project.slug, research: (meta.research || []).map(fixPath), handoff: fixPath(meta.handoff) });
		moved.runs.push(d);
	}
	fs.mkdirSync(to.handoffs, { recursive: true });
	for (const f of safeList(from.handoffs).filter((f) => /^H-\d+.*\.md$/.test(f))) {
		const dest = path.join(to.handoffs, f);
		fs.renameSync(path.join(from.handoffs, f), dest);
		rewriteHeader(dest, { project: project.slug });
		moved.handoffs.push(f);
	}
	fs.mkdirSync(to.archive, { recursive: true });
	for (const g of safeList(from.archive).filter((d) => !d.startsWith('.') && d !== 'inbox' && fs.statSync(path.join(from.archive, d)).isDirectory())) {
		const dest = path.join(to.archive, g);
		fs.renameSync(path.join(from.archive, g), dest);
		for (const f of safeList(dest).filter((f) => /^A-\d+.*\.md$/.test(f))) rewriteHeader(path.join(dest, f), { project: project.slug });
		moved.archiveGroups.push(g);
	}
	const state = loadState(root);
	const claimed = Object.fromEntries(Object.entries(state.claimed).map(([h, c]) => [h, { ...c, project: c.project || project.slug }]));
	const groups = { ...state.groups, [project.slug]: { ...groupsFor(state, ''), ...groupsFor(state, project.slug) } };
	delete groups[''];
	saveState(root, { ...state, claimed, groups });
	for (const f of [path.join(from.handoffs, 'INDEX.md'), path.join(from.archive, 'INDEX.md')]) if (fs.existsSync(f)) fs.rmSync(f);
	removeIfEmpty(from.runs);
	removeIfEmpty(from.handoffs);
	const indexes = writeIndexes(root);
	return { ok: true, project: { slug: project.slug, id: project.id, name: project.name }, moved, indexes };
}

const stem = (name) => name.replace(/\.[^.]+$/, '');
const commonPrefix = (a, b) => {
	let n = 0;
	while (n < a.length && a[n] === b[n]) n++;
	return n;
};

/**
 * Move an entry's original and extracted text into the destination group's sources/, never overwriting a
 * file there, plus companions: files beside them that no digest cites but that are another form of the
 * same original (x.docx next to x.docx.md, x.xlsx next to x.md). A companion belongs to the entry whose
 * cited file is its extraction (x.docx.md for x.docx), else to the entries citing a file of the same stem,
 * and moves only when every such entry moves. Returns the header paths that changed, the cited files that
 * were missing, and the companions moved.
 */
function moveSources(a, destGroupDir, groupEntries, movingIds) {
	const sources = path.join(destGroupDir, 'sources');
	fs.mkdirSync(sources, { recursive: true });
	const cited = (e) => [e.data.source, e.data.source_text].filter(Boolean).map((s) => path.basename(s));
	const named = new Set(groupEntries.flatMap(cited));
	const owners = (f) => {
		const exact = groupEntries.filter((e) => cited(e).some((n) => stem(n) === f));
		return exact.length ? exact : groupEntries.filter((e) => cited(e).some((n) => stem(n) === stem(f)));
	};
	const patch = {};
	const missing = [];
	const companions = [];
	for (const key of ['source', 'source_text']) {
		if (!a.data[key]) continue;
		const src = path.join(path.dirname(a.file), a.data[key]);
		for (const f of safeList(path.dirname(src))) {
			const own = named.has(f) ? [] : owners(f);
			if (!own.includes(a) || !own.every((e) => movingIds.has(e.data.id))) continue;
			fs.renameSync(path.join(path.dirname(src), f), uniqueDest(sources, f, a.data.id));
			companions.push(f);
		}
		if (!fs.existsSync(src)) {
			missing.push(a.data[key]);
			continue;
		}
		const dest = uniqueDest(sources, path.basename(src), a.data.id); // never overwrite another entry's original
		fs.renameSync(src, dest);
		if (`sources/${path.basename(dest)}` !== a.data[key]) patch[key] = `sources/${path.basename(dest)}`;
	}
	return { patch, missing, companions };
}

/** Re-home one hand-off (H-) or archive entry (A-) into another project. */
export function moveEntry(root, id, toSlug, opts = {}) {
	const to = getProject(root, toSlug);
	if (!to) return { ok: false, error: `No project "${toSlug}".` };
	if (/^H-\d+$/.test(id)) return moveHandoff(root, id, to, opts);
	if (/^A-\d+$/.test(id)) return moveArchive(root, id, to, opts);
	return { ok: false, error: 'Pass a hand-off id (H-017) or an archive id (A-012).' };
}

/** A hand-off moves alone; the facts and lessons citing it or its run (saved during triage) follow it. */
function moveHandoff(root, id, to, { keepMemory = false } = {}) {
	const h = loadAllHandoffs(root).find((x) => x.data.id === id);
	if (!h) return { ok: false, error: `No hand-off ${id}.` };
	if (h.project === to.slug) return { ok: true, id, project: to.slug, unchanged: true };
	const dest = path.join(paths(root, to.slug).handoffs, path.basename(h.file));
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.renameSync(h.file, dest);
	rewriteHeader(dest, { project: to.slug });
	const runs = findRunsReferencing(root, h.relFile);
	for (const r of runs) writeJson(r.file, { ...r.meta, handoff: rel(root, dest) });
	const runIds = runs.map((r) => (path.basename(path.dirname(r.file)).match(/^R-\d+/) || [])[0]).filter(Boolean);
	const memory = keepMemory ? { moved: [], kept: [] } : moveMemory(root, h.project, to.slug, [id, ...runIds]);
	const linked = [...h.data.supersedes, h.data.superseded_by].filter(Boolean);
	const note = linked.length ? `its hand-off links (${linked.join(', ')}) now cross projects` : undefined;
	return { ok: true, id, kind: 'handoff', from: h.project, project: to.slug, file: rel(root, dest), memory: memory.moved, memoryKept: memory.kept, note, indexes: writeIndexes(root) };
}

/**
 * An archive entry moves with every entry linked to it by supersedes / superseded_by (a version chain
 * stays inside one project), links kept. With `alone` only the entry moves, keeping only its links into
 * the destination, and the chain left behind is relinked around it; the newest version of a chain
 * cannot move alone, since nothing could say which version is newest after it.
 */
function moveArchive(root, id, to, { alone = false, keepMemory = false } = {}) {
	const archive = loadAllArchive(root);
	const a = archive.find((x) => x.data.id === id);
	if (!a) return { ok: false, error: `No archive entry ${id}.` };
	if (a.project === to.slug) return { ok: true, id, project: to.slug, unchanged: true };
	const from = a.project;
	const chain = versionChain(archive, id);
	const left = alone ? chain.filter((m) => m !== a) : [];
	if (left.length && a.data.status !== 'superseded') {
		return {
			ok: false,
			code: 'newest-version',
			id,
			error: `${id} is the newest version of its document (with ${left.map((m) => m.data.id).join(', ')}); moving it alone would leave the others without one. Move the whole chain instead.`,
		};
	}
	const moving = alone ? [a] : chain;
	const movingIds = new Set(moving.map((m) => m.data.id));
	const inDest = new Set(archive.filter((x) => x.project === to.slug).map((x) => x.data.id));
	const keepLink = (x) => (alone ? inDest.has(x) : movingIds.has(x) || inDest.has(x));
	const state = loadState(root);
	const fromGroups = groupsFor(state, from);
	const toGroups = { ...groupsFor(state, to.slug) };
	const moved = [];
	const sourcesMissing = [];
	const groupsMerged = [];
	const leftDirs = new Set();
	for (const m of moving) {
		const destGroup = path.join(paths(root, to.slug).archive, m.group);
		fs.mkdirSync(destGroup, { recursive: true });
		const groupEntries = archive.filter((e) => e.project === from && e.group === m.group);
		const sources = moveSources(m, destGroup, groupEntries, movingIds);
		const dest = path.join(destGroup, path.basename(m.file));
		fs.renameSync(m.file, dest);
		const links = { superseded_by: keepLink(m.data.superseded_by) ? m.data.superseded_by : null, supersedes: m.data.supersedes.filter(keepLink) };
		if (alone && !links.superseded_by) links.status = 'active';
		rewriteHeader(dest, { project: to.slug, ...sources.patch, ...links });
		const had = toGroups[m.group];
		const came = fromGroups[m.group];
		if (had && came && had.name !== came.name && !groupsMerged.some((g) => g.group === m.group)) groupsMerged.push({ group: m.group, name: came.name, into: had.name });
		toGroups[m.group] = had || came || { name: m.group };
		leftDirs.add(path.dirname(m.file));
		moved.push({ id: m.data.id, group: m.group, file: rel(root, dest), ...(sources.companions.length ? { companions: sources.companions } : {}) });
		if (sources.missing.length) sourcesMissing.push({ id: m.data.id, missing: sources.missing });
	}
	// Repair the chain left behind (alone) and the chain the entry joins in the destination.
	const leftFix = left.length ? repairChain(left, { successor: new Map([[id, a.data.superseded_by]]) }) : null;
	const destFix = repairChain(versionChain(loadArchive(root, to.slug), id));
	const relinked = [...new Set([...(leftFix ? leftFix.changed : []), ...destFix.changed])];
	const chainProblem = [leftFix && leftFix.problem, destFix.problem].filter(Boolean).join('; ') || undefined;
	const groupsRemoved = [];
	for (const dir of leftDirs) {
		removeIfEmpty(path.join(dir, 'sources'));
		removeIfEmpty(dir);
		if (!fs.existsSync(dir)) groupsRemoved.push(path.basename(dir));
	}
	const groups = { ...state.groups, [to.slug]: toGroups };
	if (state.groups[from || '']) groups[from || ''] = Object.fromEntries(Object.entries(fromGroups).filter(([slug]) => !groupsRemoved.includes(slug)));
	const groupOf = new Map(moved.map((m) => [m.id, m.group]));
	const claimed = Object.fromEntries(Object.entries(state.claimed).map(([h, c]) => [h, groupOf.has(c.id) ? { ...c, project: to.slug, group: groupOf.get(c.id) } : c]));
	saveState(root, { ...state, groups, claimed });
	const memory = keepMemory ? { moved: [], kept: [] } : moveMemory(root, from, to.slug, [...movingIds], left.map((m) => m.data.id));
	// A version that was superseded and has no newer version where it landed is now active there.
	const activated = loadArchive(root, to.slug)
		.filter((e) => movingIds.has(e.data.id) && e.data.status !== 'superseded')
		.map((e) => moving.find((m) => m.data.id === e.data.id))
		.filter((m) => m.data.status === 'superseded')
		.map((m) => ({ id: m.data.id, was: `superseded by ${m.data.superseded_by || '?'} in ${from || 'the root'}` }));
	// Likely siblings left in the groups the entries came from (e.g. a translation kept in its own chain):
	// they mention a moved id, or share the start of a title with one.
	const mention = new RegExp(`\\b(${[...movingIds].join('|')})\\b`);
	const titles = moving.map((m) => String(m.data.title).toLowerCase());
	const related = (e) => mention.test(e.body) || titles.some((t) => commonPrefix(t, String(e.data.title).toLowerCase()) >= 20);
	const leftInGroup = loadArchive(root, from).filter((e) => [...groupOf.values()].includes(e.group) && related(e)).map((e) => e.data.id);
	const others = moved.filter((m) => m.id !== id).map((m) => m.id);
	const note = alone
		? `moved alone${relinked.length ? '; the versions left behind were relinked around it' : ''}`
		: others.length ? `moved with ${others.join(', ')}, linked to it by supersedes / superseded_by; the links are kept` : undefined;
	return {
		ok: true,
		id,
		kind: 'archive',
		from,
		project: to.slug,
		file: moved.find((m) => m.id === id).file,
		moved,
		relinked,
		activated,
		chainProblem,
		leftInGroup,
		sourcesMissing,
		groupsRemoved,
		groupsMerged,
		memory: memory.moved,
		memoryKept: memory.kept,
		note,
		indexes: writeIndexes(root),
	};
}

// ---------------------------------------------------------------- version chains

/** An entry's version chain: every entry of its project linked to it through supersedes / superseded_by, itself included. */
export function versionChain(archive, id) {
	const start = archive.find((a) => a.data.id === id);
	if (!start) return [];
	const same = archive.filter((a) => a.project === start.project);
	const links = new Map(same.map((a) => [a.data.id, new Set()]));
	for (const a of same) {
		for (const other of [...a.data.supersedes, a.data.superseded_by].filter((x) => x && links.has(x))) {
			links.get(a.data.id).add(other);
			links.get(other).add(a.data.id);
		}
	}
	const seen = new Set([id]);
	const todo = [id];
	while (todo.length) {
		for (const next of links.get(todo.pop())) {
			if (seen.has(next)) continue;
			seen.add(next);
			todo.push(next);
		}
	}
	return same.filter((a) => seen.has(a.data.id));
}

/**
 * Repair a version chain whose links reach outside it (a member moved away, or a link names another
 * project or a missing entry). Links to the outside are dropped. A version that named an outside entry as
 * its successor is relinked to the chain member that already lists it in supersedes, else to that outside
 * entry's own successor (`successor`: outside id → its superseded_by) when it is in the chain, else to the
 * head; a version whose links no longer reach the head (none left, or a cycle) is linked to the head.
 * Every other link is kept, so a chain linked step by step stays that way. The head is the chain's one
 * active member: a lone member becomes active; with no active member among several, or more than one,
 * only the outside links are dropped and `problem` says so, since nothing can tell which version is newest.
 */
export function repairChain(members, { successor = new Map(), write = true } = {}) {
	const ids = new Set(members.map((m) => m.data.id));
	const inside = (x) => Boolean(x) && ids.has(x);
	const want = new Map(members.map((m) => [m.data.id, { status: m.data.status, superseded_by: inside(m.data.superseded_by) ? m.data.superseded_by : null, supersedes: m.data.supersedes.filter(inside) }]));
	const active = members.filter((m) => m.data.status !== 'superseded');
	const head = active.length === 1 ? active[0] : members.length === 1 ? members[0] : null;
	const problem = head ? undefined : active.length ? `${active.map((m) => m.data.id).join(', ')} are all active` : `no version of ${[...ids].join(', ')} is active`;
	if (head) {
		Object.assign(want.get(head.data.id), { status: 'active', superseded_by: null });
		const repointed = new Set();
		for (const m of members) {
			if (m === head || !m.data.superseded_by || inside(m.data.superseded_by)) continue;
			const listers = members.filter((x) => x !== m && x !== head && want.get(x.data.id).supersedes.includes(m.data.id));
			const next = successor.get(m.data.superseded_by);
			want.get(m.data.id).superseded_by = listers.length === 1 ? listers[0].data.id : inside(next) && next !== m.data.id ? next : head.data.id;
			repointed.add(m.data.id);
		}
		for (const m of members) {
			const w = want.get(m.data.id);
			if (m === head) continue;
			const seen = new Set();
			let x = w.superseded_by;
			while (x && x !== head.data.id && !seen.has(x)) {
				seen.add(x);
				x = want.get(x).superseded_by;
			}
			if (x !== head.data.id) {
				w.superseded_by = head.data.id;
				repointed.add(m.data.id);
			}
		}
		// Keep supersedes reciprocal for what changed: the head is superseded by nothing, and a relinked
		// version is listed by its new successor only.
		for (const m of members) {
			const w = want.get(m.data.id);
			w.supersedes = w.supersedes.filter((x) => x !== head.data.id && (!repointed.has(x) || want.get(x).superseded_by === m.data.id));
			for (const x of repointed) if (want.get(x).superseded_by === m.data.id && !w.supersedes.includes(x)) w.supersedes.push(x);
		}
	}
	const changed = [];
	for (const m of members) {
		const w = want.get(m.data.id);
		const have = { status: m.data.status, superseded_by: m.data.superseded_by || null, supersedes: m.data.supersedes };
		if (JSON.stringify(have) === JSON.stringify(w)) continue;
		changed.push(m.data.id);
		if (write) rewriteHeader(m.file, w);
	}
	return { head: head ? head.data.id : null, changed, problem };
}

/** Where each archive entry, hand-off and run lives (project slug, or null for the root). */
function locations(root) {
	const where = new Map([...loadAllArchive(root), ...loadAllHandoffs(root)].map((e) => [e.data.id, e.project]));
	for (const project of [null, ...safeList(paths(root).projects)]) {
		for (const d of listRunDirs(paths(root, project).runs)) where.set(d.match(/^R-\d+/)[0], project);
	}
	return where;
}

/**
 * Move the project facts and lessons whose `source` cites a moved id into the destination project.
 * One that also cites something staying in another project, that cites an old version moved alone while
 * its other versions stay (`versionsStaying`), or whose file name is taken there, stays and is reported.
 * Global memory (memory/ at the root) never moves.
 */
function moveMemory(root, fromSlug, toSlug, movedIds, versionsStaying = []) {
	const moved = [];
	const kept = [];
	if (!fromSlug) return { moved, kept };
	const ids = new Set(movedIds);
	const where = locations(root);
	for (const kind of ['facts', 'lessons']) {
		const dir = path.join(paths(root, fromSlug).memory, kind);
		for (const f of safeList(dir).filter((f) => f.endsWith('.md'))) {
			const file = path.join(dir, f);
			const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
			const cited = [...new Set(String(data.source || '').match(SOURCE_ID) || [])];
			if (!cited.some((c) => ids.has(c))) continue;
			const behind = cited.filter((c) => !ids.has(c) && where.has(c) && where.get(c) !== toSlug);
			if (behind.length) {
				kept.push({ file: rel(root, file), reason: `also cites ${behind.map((c) => `${c} (${where.get(c) || 'root'})`).join(', ')}, which stays` });
				continue;
			}
			if (versionsStaying.length) {
				kept.push({ file: rel(root, file), reason: `the other versions (${versionsStaying.join(', ')}) stay in ${fromSlug}` });
				continue;
			}
			const dest = path.join(paths(root, toSlug).memory, kind, f);
			if (fs.existsSync(dest)) {
				kept.push({ file: rel(root, file), reason: `${rel(root, dest)} already exists` });
				continue;
			}
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.renameSync(file, dest);
			moved.push(rel(root, dest));
		}
	}
	return { moved, kept };
}

function findRunsReferencing(root, handoffRel) {
	const out = [];
	const roots = [paths(root).runs, ...safeList(paths(root).projects).map((s) => paths(root, s).runs)];
	for (const dir of roots) {
		for (const d of listRunDirs(dir)) {
			const file = path.join(dir, d, 'run.json');
			const meta = readJson(file, null);
			if (meta && meta.handoff === handoffRel) out.push({ file, meta });
		}
	}
	return out;
}
