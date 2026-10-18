// archive.mjs — old research and spec files, absorbed into the ledger, per project.
//
// Flow: files are dumped in archive/inbox (global) → `scan` hashes them, drops exact duplicates
// and extracts their text into archive/.staging (gitignored) → `next` hands Claude a batch, one
// brief per file → a subagent per file writes the digest and files it with `add`, which moves
// the original and its text into projects/<project>/archive/<group>/sources/, writes the digest
// A-NNN-<slug>.md next to them, records the hash in archive/.state.json (git-tracked, so any
// machine can continue) and rebuilds the indexes. The inbox is empty when everything is filed.
//
// Two modes: fixed (every file goes into one project) and sort (the subagent picks the project
// from the list, or `unsorted`). Concurrency: `add` runs under a directory lock. Cross-machine:
// `next` records a soft lock (host + time) in the state file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontmatter, serializeFrontmatter } from './fm.mjs';
import { isCjkWord, keywords, loadAllArchive, loadArchive, loadHandoffs, scoreText, writeIndexes } from './index.mjs';
import { UNSORTED, UNSORTED_DESCRIPTION, UNSORTED_NAME, ensureProject, getProject, openProjects } from './projects.mjs';
import { paths, readJson, rel, safeList, sha256, slugify, today, writeJson } from './repo.mjs';

const SCRIPTS_DIR = fileURLToPath(new URL('..', import.meta.url));
const PDFJS = path.join(SCRIPTS_DIR, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs');
const MAMMOTH = path.join(SCRIPTS_DIR, 'node_modules', 'mammoth', 'lib', 'index.js');
const SHEETJS = path.join(SCRIPTS_DIR, 'node_modules', 'xlsx', 'xlsx.js');
const FFLATE = path.join(SCRIPTS_DIR, 'node_modules', 'fflate', 'esm', 'index.mjs');
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv']);
const HTML_EXT = new Set(['.html', '.htm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const SHEET_EXT = new Set(['.xlsx', '.xls', '.xlsm']);
const DOCX_EXT = '.docx';
const PDF_EXT = '.pdf';
const ZIP_EXT = '.zip';
export const SUPPORTED = ['pdf', 'docx', 'xlsx', 'xls', 'html', 'htm', 'md', 'markdown', 'txt', 'csv', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'zip (expanded into the inbox)'];
const ZIP_MAX_MEMBERS = 2000;
const ZIP_MAX_BYTES = 500 * 1024 * 1024;
const ZIP_MAX_DEPTH = 3;
export const KINDS = ['spec', 'research', 'notes', 'comparison', 'plan', 'data', 'image', 'other'];
export const CONFIDENCE = ['high', 'medium', 'low'];
const MACHINE_LOCK_HOURS = 6;
const ADD_LOCK_WAIT_MS = 90000;
const ADD_LOCK_STALE_MS = 120000;
const KEYWORD_SAMPLE_CHARS = 30000;
const EMPTY_TEXT_CHARS = 40;

// ---------------------------------------------------------------- state

function normalizeGroups(g) {
	if (!g || typeof g !== 'object') return {};
	const flat = Object.values(g).some((v) => v && typeof v.name === 'string');
	return flat ? { '': g } : g; // '' = pre-project root scope, re-homed by the migration
}

export function loadState(root) {
	const s = readJson(paths(root).archiveState, {});
	return { version: 2, claimed: {}, lock: null, ...s, groups: normalizeGroups(s.groups) };
}

export function saveState(root, state) {
	writeJson(paths(root).archiveState, state);
}

export function groupsFor(state, project) {
	return state.groups[project || ''] || {};
}

export function extractorInstalled() {
	return fs.existsSync(PDFJS);
}

export function extractors() {
	return { pdf: fs.existsSync(PDFJS), docx: fs.existsSync(MAMMOTH), xlsx: fs.existsSync(SHEETJS), zip: fs.existsSync(FFLATE) };
}

export function scriptsDir() {
	return SCRIPTS_DIR;
}

// ---------------------------------------------------------------- text extraction

async function pdfText(file) {
	const { getDocument } = await import(pathToFileURL(PDFJS).href);
	const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
	const pages = [];
	for (let i = 1; i <= doc.numPages; i++) {
		const content = await (await doc.getPage(i)).getTextContent();
		const lines = [];
		let line = '';
		for (const item of content.items) {
			if (!('str' in item)) continue;
			line += item.str;
			if (item.hasEOL) {
				lines.push(line);
				line = '';
			}
		}
		if (line) lines.push(line);
		pages.push(lines.join('\n'));
	}
	const info = (await doc.getMetadata().catch(() => null))?.info || {};
	return { text: pages.join('\n\n'), pages: doc.numPages, created: pdfDate(info.CreationDate) || pdfDate(info.ModDate), title: info.Title || '' };
}

function pdfDate(v) {
	const m = String(v || '').match(/^D:(\d{4})(\d{2})(\d{2})/);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function docxText(file) {
	const mod = await import(pathToFileURL(MAMMOTH).href);
	const mammoth = mod.default || mod;
	const r = await mammoth.extractRawText({ buffer: fs.readFileSync(file) });
	return r.value || '';
}

/** Every sheet of a workbook as CSV text under a "## Sheet:" heading. */
async function sheetText(file) {
	const mod = await import(pathToFileURL(SHEETJS).href);
	const X = mod.default || mod;
	const wb = X.read(fs.readFileSync(file), { type: 'buffer', cellDates: true });
	return wb.SheetNames.map((n) => `## Sheet: ${n}\n${X.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })}`).join('\n\n');
}

/** macOS metadata that zips carry along: __MACOSX/ folders, .DS_Store and ._* (AppleDouble) files. Nothing else is junk. */
function zipJunk(member) {
	const parts = member.split(/[\\/]+/).filter(Boolean);
	const base = parts[parts.length - 1] || '';
	return parts.includes('__MACOSX') || base === '.DS_Store' || base.startsWith('._');
}

/** Inbox name of a zip member: <zip stem>__<path, with __ for every folder>. Never starts with '.', which the inbox ignores. */
function zipMemberName(stem, member) {
	return `${stem}__${member.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '__')}`.replace(/^\.+/, '');
}

/**
 * Zips in the inbox are unpacked into the inbox (member names flattened to <zip>__<path>) and
 * deleted, so their contents go through the normal flow. Nested zips are unpacked on the next
 * pass, three levels deep. Folders and macOS junk are skipped; files in dot-folders such as
 * .claude/ are not. A zip is deleted only when every member but the junk was written: one that
 * is unreadable, over the size or member cap (checked before anything is inflated), or has a
 * member that cannot be written stays in the inbox with nothing of it unpacked, and its entry's
 * `error` says why.
 */
async function expandZips(root) {
	const dir = paths(root).archiveInbox;
	const expanded = [];
	const tried = new Set();
	const zipsNow = () => safeList(dir).filter((n) => !n.startsWith('.') && n.toLowerCase().endsWith(ZIP_EXT));
	const untried = () => zipsNow().filter((n) => !tried.has(n));
	if (!fs.existsSync(FFLATE)) return { expanded, blocked: zipsNow(), error: zipsNow().length ? 'zip extractor missing: run /ledger setup' : null };
	const { unzipSync } = await import(pathToFileURL(FFLATE).href);
	for (let depth = 0; depth < ZIP_MAX_DEPTH && untried().length; depth++) {
		for (const name of untried()) {
			tried.add(name);
			const file = path.join(dir, name);
			const stem = name.replace(/\.zip$/i, '');
			const unreadable = (e) => `unreadable zip (${String(e.message || e).slice(0, 120)}); left in the inbox`;
			const wanted = (m) => !/[\\/]$/.test(m.name) && !zipJunk(m.name);
			let zip;
			const listing = [];
			try {
				zip = new Uint8Array(fs.readFileSync(file));
				unzipSync(zip, { filter: (m) => listing.push(m) && false }); // reads the directory only, inflates nothing
			} catch (e) {
				expanded.push({ zip: name, files: 0, error: unreadable(e) });
				continue;
			}
			const keep = listing.filter(wanted);
			const entry = { zip: name, files: 0, junk: listing.filter((m) => !/[\\/]$/.test(m.name)).length - keep.length, skipped: [] };
			const bytes = keep.reduce((n, m) => n + m.originalSize, 0);
			if (keep.length > ZIP_MAX_MEMBERS || bytes > ZIP_MAX_BYTES) {
				const mb = (n) => Math.ceil(n / 1048576);
				entry.error = `too big to unpack (${keep.length} files, ${mb(bytes)} MB; the limit is ${ZIP_MAX_MEMBERS} files and ${mb(ZIP_MAX_BYTES)} MB per zip); nothing unpacked, left in the inbox`;
				expanded.push(entry);
				continue;
			}
			let members;
			try {
				members = unzipSync(zip, { filter: wanted });
			} catch (e) {
				expanded.push({ ...entry, error: unreadable(e) });
				continue;
			}
			const written = [];
			for (const [member, data] of Object.entries(members)) {
				const flat = zipMemberName(stem, member);
				let dest = path.join(dir, flat);
				for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${i}-${flat}`);
				try {
					fs.writeFileSync(dest, data, { flag: 'wx' });
					written.push(dest);
				} catch (e) {
					entry.skipped.push(`${member} (${e.code || String(e.message || e).slice(0, 120)})`);
					break;
				}
			}
			if (entry.skipped.length) {
				for (const f of written) fs.rmSync(f, { force: true });
				entry.error = `could not write ${entry.skipped[0]}; nothing unpacked, left in the inbox`;
			} else {
				entry.files = written.length;
				fs.rmSync(file);
			}
			expanded.push(entry);
		}
	}
	return { expanded, blocked: zipsNow(), error: null };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlText(html) {
	return String(html)
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<title[^>]*>([\s\S]*?)<\/title>/i, '$1\n\n')
		.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
		.replace(/<(br|hr)\s*\/?>/gi, '\n')
		.replace(/<\/(td|th)>/gi, '\t')
		.replace(/<[^>]+>/g, '')
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
			if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
			return ENTITIES[e.toLowerCase()] ?? m;
		})
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Extract once per content hash into .staging/<hash>.txt + .json; later calls reuse it. */
async function ensureText(root, file, hash, ext) {
	const p = paths(root);
	fs.mkdirSync(p.archiveStaging, { recursive: true });
	const txt = path.join(p.archiveStaging, `${hash}.txt`);
	const meta = path.join(p.archiveStaging, `${hash}.json`);
	if (fs.existsSync(txt) && fs.existsSync(meta)) return { ...readJson(meta, {}), txt };
	let info;
	let text = '';
	try {
		if (TEXT_EXT.has(ext)) {
			text = fs.readFileSync(file, 'utf8');
			info = { extractor: 'text' };
		} else if (HTML_EXT.has(ext)) {
			text = htmlText(fs.readFileSync(file, 'utf8'));
			info = { extractor: 'html' };
		} else if (IMAGE_EXT.has(ext)) {
			info = { extractor: 'image' };
		} else if (SHEET_EXT.has(ext)) {
			if (!fs.existsSync(SHEETJS)) info = { extractor: 'none', error: 'excel extractor missing: run /ledger setup' };
			else {
				text = await sheetText(file);
				info = { extractor: 'sheetjs' };
			}
		} else if (ext === DOCX_EXT) {
			if (!fs.existsSync(MAMMOTH)) info = { extractor: 'none', error: 'docx extractor missing: run /ledger setup' };
			else {
				text = await docxText(file);
				info = { extractor: 'mammoth' };
			}
		} else if (!fs.existsSync(PDFJS)) {
			info = { extractor: 'none', error: 'pdf extractor missing: run /ledger setup' };
		} else {
			const r = await pdfText(file);
			text = r.text;
			info = { extractor: 'pdfjs', pages: r.pages, created: r.created, pdfTitle: r.title };
		}
	} catch (e) {
		info = { extractor: 'failed', error: String(e.message || e).slice(0, 200) };
	}
	fs.writeFileSync(txt, text);
	info = { pages: 0, created: null, ...info, chars: text.trim().length };
	writeJson(meta, info);
	return { ...info, txt };
}

// ---------------------------------------------------------------- hints

function filenameDate(name) {
	const m = name.match(/(20\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})/);
	if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
	const y = name.match(/\b(20\d{2})\b/);
	return y ? `${y[1]} (year only)` : null;
}

function versionHint(name) {
	const hints = [];
	const v = name.match(/\b(?:v|ver|version|rev)[ _.-]?(\d+(?:\.\d+)*)\b/i);
	if (v) hints.push(`v${v[1]}`);
	const copy = name.match(/\((\d+)\)\.[a-z]+$/i);
	if (copy) hints.push(`copy (${copy[1]})`);
	const word = name.match(/\b(final|draft|old|new|latest|updated|revised)\b/i);
	if (word) hints.push(word[1].toLowerCase());
	return hints.join(', ') || null;
}

function headerOnly(e) {
	return [
		[e.data.topics.join(' '), 4],
		[e.data.title, 3],
		[e.data.summary, 2],
	];
}

function topMatches(words, entries, max, pick) {
	return entries
		.map((e) => ({ e, score: scoreText(words, headerOnly(e)) }))
		.filter((x) => x.score >= 3)
		.sort((a, b) => b.score - a.score)
		.slice(0, max)
		.map(({ e }) => pick(e));
}

function bestGroup(words, archive) {
	const byGroup = new Map();
	for (const a of archive) byGroup.set(a.group, [...(byGroup.get(a.group) || []), a]);
	let best = null;
	for (const [slug, entries] of byGroup) {
		const text = entries.map((e) => `${e.data.title} ${e.data.topics.join(' ')} ${e.data.summary}`).join(' ');
		const score = scoreText(words, [[text, 1]]);
		if (score >= 4 && (!best || score > best.score)) best = { slug, score };
	}
	return best ? best.slug : null;
}

function bestProject(words, projects, archive) {
	let best = null;
	for (const p of projects) {
		const own = archive.filter((a) => a.project === p.slug);
		const text = `${p.name} ${p.description} ${own.map((e) => `${e.data.title} ${e.data.topics.join(' ')}`).join(' ')}`;
		const score = scoreText(words, [[`${p.name} ${p.description}`, 3], [text, 1]]);
		if (score >= 4 && (!best || score > best.score)) best = { slug: p.slug, score };
	}
	return best ? best.slug : null;
}

function describe(root, f, hash, ext, info, { archive, handoffs, projects, sort }) {
	const text = fs.readFileSync(info.txt, 'utf8');
	const stem = f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]/g, ' ');
	const found = keywords(`${stem} ${text.slice(0, KEYWORD_SAMPLE_CHARS)}`, { limit: 15, cjkLimit: 10 });
	// A Chinese file name names the subject better than the most frequent bigrams of the text.
	const cjk = [...new Set([...keywords(stem, { limit: 0, cjkLimit: 10 }), ...found.filter(isCjkWord)])].slice(0, 10);
	const words = [...found.filter((w) => !isCjkWord(w)), ...cjk];
	const proposedProject = sort ? bestProject(words, projects, archive) : null;
	const groupPool = sort ? archive.filter((a) => a.project === proposedProject) : archive;
	return {
		name: f.name,
		path: rel(root, f.file),
		bytes: f.bytes,
		hash,
		ext,
		extractor: info.extractor,
		pages: info.pages || 0,
		chars: info.chars || 0,
		textEmpty: (info.chars || 0) < EMPTY_TEXT_CHARS,
		isImage: IMAGE_EXT.has(ext),
		textFile: rel(root, info.txt),
		extractError: info.error || null,
		head: text.slice(0, 600).replace(/\s+/g, ' ').trim(),
		dateHints: { filename: filenameDate(f.name), pdfCreated: info.created || null, pdfTitle: info.pdfTitle || null, fileModified: f.modified.slice(0, 10) },
		versionHint: versionHint(f.name),
		keywords: words,
		proposedProject,
		proposedGroup: bestGroup(words, groupPool),
		related: topMatches(words, archive, 4, (a) => ({ id: a.data.id, title: a.data.title, date: a.data.date, project: a.project, group: a.group, status: a.data.status, kind: a.data.kind })),
		relatedHandoffs: topMatches(words, handoffs, 3, (h) => ({ id: h.data.id, title: h.data.title, date: h.data.date, project: h.project })),
	};
}

// ---------------------------------------------------------------- scan / next

function isSupported(name) {
	const ext = path.extname(name).toLowerCase();
	return ext === PDF_EXT || ext === DOCX_EXT || TEXT_EXT.has(ext) || HTML_EXT.has(ext) || IMAGE_EXT.has(ext) || SHEET_EXT.has(ext);
}

function inboxFiles(root) {
	const dir = paths(root).archiveInbox;
	return safeList(dir)
		.filter((n) => !n.startsWith('.'))
		.map((n) => ({ name: n, file: path.join(dir, n) }))
		.filter((f) => fs.statSync(f.file).isFile())
		.map((f) => ({ ...f, bytes: fs.statSync(f.file).size, modified: fs.statSync(f.file).mtime.toISOString() }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Hash every inbox file, delete exact duplicates of anything already filed (or of each other), extract text. */
export async function scanInbox(root, { project = null, sort = false } = {}) {
	const zips = await expandZips(root);
	const state = loadState(root);
	const projects = openProjects(root);
	const archive = sort ? loadAllArchive(root) : loadArchive(root, project);
	const handoffs = sort ? projects.flatMap((p) => loadHandoffs(root, p.slug)) : loadHandoffs(root, project);
	const seen = new Map();
	const entries = [];
	const removed = [];
	const unsupported = [];
	const keptZips = new Set(zips.expanded.filter((e) => e.error).map((e) => e.zip)); // reported in `expanded` with the reason
	for (const f of inboxFiles(root)) {
		if (!isSupported(f.name)) {
			if (!keptZips.has(f.name)) unsupported.push(f.name);
			continue;
		}
		const hash = sha256(f.file);
		const prior = state.claimed[hash] || seen.get(hash);
		if (prior) {
			fs.rmSync(f.file);
			removed.push({ name: f.name, duplicateOf: prior.id || prior.name, project: prior.project || null, reason: prior.id ? 'already filed' : 'same content as another inbox file' });
			continue;
		}
		seen.set(hash, { name: f.name });
		const ext = path.extname(f.name).toLowerCase();
		const info = await ensureText(root, f.file, hash, ext);
		entries.push(describe(root, f, hash, ext, info, { archive, handoffs, projects, sort }));
	}
	return { entries, removed, unsupported, expanded: zips.expanded, zipError: zips.error, extractors: extractors() };
}

function groupSummary(state, archive, project) {
	const byGroup = new Map();
	for (const a of archive.filter((a) => a.project === project)) byGroup.set(a.group, [...(byGroup.get(a.group) || []), a]);
	const names = groupsFor(state, project);
	return [...byGroup.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([slug, entries]) => ({ slug, name: (names[slug] || {}).name || slug, documents: entries.length, sample: entries.slice(-3).map((a) => `${a.data.id} ${a.data.title}`) }));
}

function machineLockBlocks(state) {
	if (!state.lock || state.lock.host === os.hostname()) return null;
	const ageH = (Date.now() - Date.parse(state.lock.at || 0)) / 3600000;
	return ageH < MACHINE_LOCK_HOURS ? { host: state.lock.host, at: state.lock.at, ageHours: Math.round(ageH * 10) / 10 } : null;
}

export async function nextBatch(root, { size = 8, force = false, project = null, sort = false } = {}) {
	if (!sort && !project) return { ok: false, code: 'no-project', error: 'Archive into which project? Pass --project <slug>, or --sort to let each document choose.' };
	const blocked = machineLockBlocks(loadState(root));
	if (blocked && !force) {
		return {
			ok: false,
			code: 'archive-locked',
			error: `Another machine (${blocked.host}) started archiving ${blocked.ageHours} h ago and has not finished. Sync and wait, or run "archive unlock" if it is really idle.`,
			lock: blocked,
		};
	}
	const scan = await scanInbox(root, { project, sort });
	const state = loadState(root);
	if (!scan.entries.length) {
		if (state.lock) saveState(root, { ...state, lock: null });
		return { ok: true, done: true, batch: [], remaining: 0, removed: scan.removed, unsupported: scan.unsupported, expanded: scan.expanded, zipError: scan.zipError, filed: Object.keys(state.claimed).length };
	}
	saveState(root, { ...state, lock: { host: os.hostname(), at: new Date().toISOString(), project: sort ? 'sort' : project } });
	const projects = openProjects(root);
	const archive = loadAllArchive(root);
	const groups = Object.fromEntries((sort ? projects.map((p) => p.slug) : [project]).map((slug) => [slug, groupSummary(state, archive, slug)]));
	const batch = scan.entries.slice(0, size).map((e) => ({ ...e, brief: brief(root, e, { project, sort, projects, groups }) }));
	return {
		ok: true,
		done: false,
		mode: sort ? 'sort' : 'fixed',
		project: sort ? null : project,
		batch,
		remaining: scan.entries.length,
		afterThisBatch: scan.entries.length - batch.length,
		removed: scan.removed,
		unsupported: scan.unsupported,
		expanded: scan.expanded,
		zipError: scan.zipError,
		extractors: scan.extractors,
		groups,
	};
}

// ---------------------------------------------------------------- the brief a subagent gets

function sourceInstruction(e) {
	if (e.isImage) return `This is an IMAGE: look at it with the Read tool and describe what it shows (a chart, a screenshot, a diagram, a photo of a whiteboard…), reading any text in it.`;
	if (e.textEmpty) return `The extracted text is empty (${e.extractError || 'no text layer, probably a scanned document'}): read the document itself with the Read tool, ${e.ext === '.pdf' ? '20 pages per call (pages parameter), ' : ''}in full.`;
	return `Its text is already extracted: read ${e.textFile} IN FULL with the Read tool (${e.chars.toLocaleString()} characters; use offset/limit to page through a long file). Do not read the original.`;
}

function groupLines(groups, sort) {
	const lines = [];
	for (const [slug, list] of Object.entries(groups)) {
		for (const g of list) lines.push(`  - ${sort ? `[${slug}] ` : ''}${g.slug} — "${g.name}" (${g.documents} doc${g.documents === 1 ? '' : 's'}: ${g.sample.join('; ')})`);
	}
	return lines.length ? lines.join('\n') : '  (none yet: you will name the first one)';
}

function brief(root, e, { project, sort, projects, groups }) {
	const script = path.join(SCRIPTS_DIR, 'ledger.mjs');
	const projectBlock = sort
		? `PROJECT: choose the project this document belongs to, from this list, or \`${UNSORTED}\` if none fits (never invent a new one):
${projects.map((p) => `  - ${p.slug} — "${p.name}"${p.description ? `: ${p.description}` : ''}`).join('\n') || '  (no projects yet: use unsorted)'}
Proposed by keyword match: ${e.proposedProject || 'no good match'}. Put it in the header as \`project: <slug>\`.`
		: `PROJECT: ${project} (fixed for this archive session; do not add a project key).`;
	const relatedLines = e.related.length
		? e.related.map((r) => `  - ${r.id} "${r.title}" (${r.date || 'undated'}, ${r.kind}, ${sort ? `project ${r.project}, ` : ''}group ${r.group}${r.status === 'superseded' ? ', superseded' : ''})`).join('\n')
		: '  (none found by keyword)';
	const handoffLines = e.relatedHandoffs.length ? e.relatedHandoffs.map((h) => `  - ${h.id} "${h.title}" (${h.date}${sort ? `, project ${h.project}` : ''})`).join('\n') : '  (none)';
	const addFlag = sort ? '--sort' : `--project "${project}"`;
	return `You are filing ONE old document into the ledger archive at ${root}. Work on your own; your reply is only the result described at the end.

DOCUMENT: ${e.path} (${e.ext.slice(1)}, ${e.bytes.toLocaleString()} bytes${e.pages ? `, ${e.pages} pages` : ''}). ${sourceInstruction(e)}
Date evidence, best first: dates written in the content, then the filename, then the PDF creation date; the file's modified date is unreliable. Filename → ${e.dateHints.filename || 'none'}; PDF created → ${e.dateHints.pdfCreated || 'n/a'}; file modified → ${e.dateHints.fileModified}.${e.versionHint ? ` Version hint in the filename: ${e.versionHint}.` : ''}
Keywords seen: ${e.keywords.join(', ') || 'none (image or empty text)'}.

${projectBlock}

EXISTING GROUPS${sort ? ' (by project, in brackets)' : ''} (a group holds the versions of one document and the documents on one narrow subject; reuse one in the same project when the subject matches, otherwise create one):
${groupLines(groups, sort)}
Proposed group by keyword match: ${e.proposedGroup || 'no good match'}.
Possibly related archive entries (check whether this document is another VERSION of one of them; a version chain stays inside one project):
${relatedLines}
Related hand-offs (context only; an archive entry never supersedes a hand-off):
${handoffLines}

TASK: read the document, write its digest for engineers, and file it by running EXACTLY this command with the header and body filled in:

node "${script}" archive add --name "${e.name}" ${addFlag} <<'LEDGER_EOF'
---
title: <the document's own title, or a precise descriptive one>
kind: <one of: ${KINDS.join(' | ')}>
date: <YYYY-MM-DD; if only a month or year is known, use its first day and lower the confidence>
date_confidence: <high | medium | low>${sort ? `\nproject: <a slug from the PROJECT list, or ${UNSORTED}>` : ''}
group: <an existing slug from the list, or a new 2-4 word slug such as pricing-model>
group_name: <human name, ONLY when the group is new, e.g. "Pricing model">
topics: [two, to, five, short, topics]
supersedes: [A-007]
superseded_by: A-012
summary: <one line, under 160 characters: what it is and what it concluded>
decisions:
  - <one sentence per decision or firm conclusion the document states; precise: numbers, names, dates>
---
## What it is
<type, author or tool if known, intended audience, when and why it was written; 2-3 lines>
## Summary
<5-10 lines>
## Key findings
<bullets; each self-contained, with the numbers>
## Decisions stated
<the header's decisions, each with the reason the document gives>
## Open questions it leaves
<bullets, or "none">
## Relationships
<which entries above it is a version of, overlaps with, or builds on; or "none known">
LEDGER_EOF

Header rules: omit \`supersedes\` unless this document is a NEWER version of a listed archive entry in the same project; omit \`superseded_by\` unless a listed entry is a NEWER version of this one (then name only the newest). Omit \`decisions\` when the document decides nothing (a data table or an image usually decides nothing). Omit \`group_name\` for an existing group. Keep every other key.
If the command prints "ok": false, fix exactly what it names and run it again (at most twice).

OPTIONAL, at most once: if the document states ONE fact that is durable and still true of the project or business (a fact, not a plan, not a decision), and the project's memory/INDEX.md does not already hold it, save it:
node "${script}" memory --kind facts --name "<short name>" --topics "a,b" --source <the A-id you just got> --project <the project slug you filed into> <<'LEDGER_EOF'
<the fact in one or two sentences, naming the source document>
LEDGER_EOF

REPLY with only the JSON that \`archive add\` printed, plus one line "memory: <file>" if you saved a fact. No other text.`;
}

// ---------------------------------------------------------------- add (under a lock)

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(root, fn) {
	const dir = path.join(paths(root).archiveStaging, '.add-lock');
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	const started = Date.now();
	for (;;) {
		try {
			fs.mkdirSync(dir);
			break;
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
			if (Date.now() - fs.statSync(dir).mtimeMs > ADD_LOCK_STALE_MS) {
				fs.rmSync(dir, { recursive: true, force: true });
				continue;
			}
			if (Date.now() - started > ADD_LOCK_WAIT_MS) throw new Error('Another "archive add" has held the lock for over 90 s; run it again.');
			sleep(150 + Math.floor(Math.random() * 200));
		}
	}
	try {
		return fn();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const asList = (v) => (Array.isArray(v) ? v : v ? [String(v)] : []);

function validateHeader(data, hasFrontmatter, archive, target) {
	const problems = [];
	if (!hasFrontmatter) problems.push('stdin must start with a --- header block');
	if (!data.title) problems.push('title is required');
	if (!KINDS.includes(data.kind)) problems.push(`kind must be one of ${KINDS.join(', ')}`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''))) problems.push('date must be YYYY-MM-DD');
	if (!CONFIDENCE.includes(data.date_confidence)) problems.push(`date_confidence must be one of ${CONFIDENCE.join(', ')}`);
	if (!data.group) problems.push('group is required');
	if (!data.summary) problems.push('summary is required');
	const topics = asList(data.topics);
	if (!topics.length) problems.push('topics must list at least one topic');
	const byId = new Map(archive.map((a) => [a.data.id, a]));
	const supersedes = asList(data.supersedes);
	for (const id of supersedes) {
		if (!byId.has(id)) problems.push(`supersedes names ${id}, which is not an archive entry`);
		else if (byId.get(id).project !== target) problems.push(`supersedes names ${id}, which is in project "${byId.get(id).project}", not "${target}": a version chain stays in one project`);
	}
	if (data.superseded_by) {
		const sb = byId.get(String(data.superseded_by));
		if (!sb) problems.push(`superseded_by names ${data.superseded_by}, which is not an archive entry`);
		else if (sb.project !== target) problems.push(`superseded_by names ${data.superseded_by}, which is in project "${sb.project}", not "${target}"`);
	}
	return { problems, topics, supersedes };
}

function nextArchiveId(archive, state) {
	let max = 0;
	for (const id of [...archive.map((a) => a.data.id), ...Object.values(state.claimed).map((c) => c.id)]) {
		const m = String(id || '').match(/^A-(\d+)/);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `A-${String(max + 1).padStart(3, '0')}`;
}

/** A free path for `name` in `dir`: the name itself, else `<id>-<name>`, else `<id>-2-<name>`, … (never an existing file). */
export function uniqueDest(dir, name, id) {
	let dest = path.join(dir, name);
	for (let n = 1; fs.existsSync(dest); n++) dest = path.join(dir, n === 1 ? `${id}-${name}` : `${id}-${n}-${name}`);
	return dest;
}

function rewriteHeader(file, patch) {
	const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
	fs.writeFileSync(file, serializeFrontmatter({ ...data, ...patch }, body));
}

/** Move the original (and its extracted text, when it is not already text) from the inbox into the group's sources/. */
function placeSources(p, name, hash, id, sources) {
	const dest = uniqueDest(sources, name, id);
	fs.renameSync(path.join(p.archiveInbox, name), dest);
	let sourceText = null;
	const ext = path.extname(name).toLowerCase();
	const stagedTxt = path.join(p.archiveStaging, `${hash}.txt`);
	const keepText = !TEXT_EXT.has(ext) && !IMAGE_EXT.has(ext);
	if (keepText && fs.existsSync(stagedTxt) && fs.statSync(stagedTxt).size > 0) {
		const txtDest = uniqueDest(sources, `${path.basename(dest, path.extname(dest))}.txt`, id);
		fs.renameSync(stagedTxt, txtDest);
		sourceText = `sources/${path.basename(txtDest)}`;
	}
	for (const f of [stagedTxt, path.join(p.archiveStaging, `${hash}.json`)]) if (fs.existsSync(f)) fs.rmSync(f);
	return { dest, sourceText };
}

function applySupersession(archive, id, supersedes, supersededBy) {
	const superseded = [];
	for (const a of archive) {
		if (supersedes.includes(a.data.id)) {
			rewriteHeader(a.file, { status: 'superseded', superseded_by: id });
			superseded.push(a.data.id);
		}
		if (supersededBy === a.data.id && !a.data.supersedes.includes(id)) rewriteHeader(a.file, { supersedes: [...a.data.supersedes, id] });
	}
	return superseded;
}

function resolveTarget(root, data, { project, sort }) {
	if (!sort) return project ? { target: project } : { problem: 'pass --project <slug> or --sort' };
	const slug = slugify(String(data.project || ''), 40);
	if (!slug || slug === 'untitled') return { problem: `sort mode: the header needs project: <slug> (an existing project or ${UNSORTED})` };
	if (slug === UNSORTED) {
		ensureProject(root, UNSORTED, UNSORTED_NAME, UNSORTED_DESCRIPTION);
		return { target: UNSORTED };
	}
	if (!getProject(root, slug)) return { problem: `project "${slug}" does not exist; use one of: ${openProjects(root).map((p) => p.slug).join(', ') || '(none)'}, or ${UNSORTED}` };
	return { target: slug };
}

/** File one digest: move the original + text into the project's group, write A-NNN-<slug>.md, record the hash, reindex. */
export function addEntry(root, name, digestText, { project = null, sort = false } = {}) {
	const { data, body, hasFrontmatter } = parseFrontmatter(digestText);
	return withLock(root, () => {
		const archive = loadAllArchive(root);
		const state = loadState(root);
		const t = resolveTarget(root, data, { project, sort });
		if (t.problem) return { ok: false, error: t.problem, problems: [t.problem] };
		const target = t.target;
		const p = paths(root, target);
		const { problems, topics, supersedes } = validateHeader(data, hasFrontmatter, archive, target);
		const src = path.join(p.archiveInbox, String(name || ''));
		if (!name || !fs.existsSync(src)) problems.push(`no file named "${name}" in archive/inbox (already filed, or the name is wrong)`);
		const slug = slugify(data.group, 40);
		const groupIsNew = !groupsFor(state, target)[slug] && !archive.some((a) => a.project === target && a.group === slug);
		if (groupIsNew && !data.group_name) problems.push(`group "${slug}" is new in project "${target}": add group_name`);
		if (problems.length) return { ok: false, error: problems.join('; '), problems };

		const hash = sha256(src);
		if (state.claimed[hash]) return { ok: false, error: `This content is already filed as ${state.claimed[hash].id} (project ${state.claimed[hash].project || 'root'}).` };
		const id = nextArchiveId(archive, state);
		const gdir = path.join(p.archive, slug);
		const sources = path.join(gdir, 'sources');
		fs.mkdirSync(sources, { recursive: true });
		const { dest, sourceText } = placeSources(p, name, hash, id, sources);
		const supersededBy = data.superseded_by ? String(data.superseded_by) : null;
		const header = {
			id,
			title: String(data.title),
			kind: data.kind,
			date: data.date,
			date_confidence: data.date_confidence,
			project: target,
			group: slug,
			topics: topics.map((x) => slugify(x, 30)),
			status: supersededBy ? 'superseded' : 'active',
			superseded_by: supersededBy,
			supersedes,
			summary: String(data.summary),
			decisions: asList(data.decisions),
			source: `sources/${path.basename(dest)}`,
			source_text: sourceText,
			added: today(),
		};
		const file = path.join(gdir, `${id}-${slugify(data.title)}.md`);
		fs.writeFileSync(file, serializeFrontmatter(header, body));
		const superseded = applySupersession(archive, id, supersedes, supersededBy);
		const groups = groupIsNew ? { ...state.groups, [target]: { ...groupsFor(state, target), [slug]: { name: String(data.group_name), created: today() } } } : state.groups;
		const claimed = { ...state.claimed, [hash]: { id, name, project: target, group: slug, at: new Date().toISOString() } };
		saveState(root, { ...state, groups, claimed });
		const indexes = writeIndexes(root);
		return {
			ok: true,
			id,
			project: target,
			file: rel(root, file),
			group: slug,
			groupNew: groupIsNew,
			title: header.title,
			date: header.date,
			decisions: header.decisions.length,
			superseded,
			supersededBy,
			source: rel(root, dest),
			remainingInInbox: inboxFiles(root).length,
			indexes,
		};
	});
}

export function unlock(root) {
	const state = loadState(root);
	saveState(root, { ...state, lock: null });
	return { ok: true, cleared: state.lock || null };
}

export function archiveStatus(root) {
	const state = loadState(root);
	const archive = loadAllArchive(root);
	const inbox = inboxFiles(root);
	const supported = inbox.filter((f) => isSupported(f.name));
	const last = [...archive].sort((a, b) => String(b.data.added || '').localeCompare(String(a.data.added || '')))[0];
	const slugs = [...new Set(archive.map((a) => a.project))];
	return {
		waiting: supported.length,
		unsupported: inbox.filter((f) => !isSupported(f.name)).map((f) => f.name),
		supportedTypes: SUPPORTED,
		filed: archive.length,
		superseded: archive.filter((a) => a.data.status === 'superseded').length,
		perProject: slugs.map((slug) => ({ project: slug || '(not yet in a project)', filed: archive.filter((a) => a.project === slug).length, groups: groupSummary(state, archive, slug) })),
		lock: state.lock,
		lockedByOtherMachine: machineLockBlocks(state),
		extractors: extractors(),
		extractorInstalled: extractorInstalled(),
		lastFiled: last ? { id: last.data.id, project: last.project, title: last.data.title, added: last.data.added || null } : null,
	};
}
