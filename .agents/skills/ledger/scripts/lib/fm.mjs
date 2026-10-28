// fm.mjs — the small YAML subset used in hand-off and memory headers.
//
// Supported:  key: value   ·   key: [a, b]   ·   key:\n  - item   ·   "quoted strings"
// That is all a header needs, and it keeps the repo free of dependencies.

function unquote(v) {
	const s = v.trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1).replace(/\\"/g, '"');
	}
	return s;
}

function parseInline(v) {
	const s = v.trim();
	if (s.startsWith('[') && s.endsWith(']')) {
		const inner = s.slice(1, -1).trim();
		return inner ? inner.split(',').map(unquote).filter(Boolean) : [];
	}
	if (s === 'true') return true;
	if (s === 'false') return false;
	return unquote(s);
}

export function parseFrontmatter(raw) {
	const text = String(raw || '').replace(/^﻿/, '');
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { data: {}, body: text, hasFrontmatter: false };
	const data = {};
	let listKey = null;
	for (const raw of m[1].split(/\r?\n/)) {
		if (!raw.trim() || raw.trim().startsWith('#')) continue;
		const item = raw.match(/^\s+-\s+(.*)$/);
		if (item && listKey) {
			data[listKey].push(unquote(item[1]));
			continue;
		}
		const kv = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (!kv) continue;
		const [, key, value] = kv;
		if (value.trim() === '') {
			data[key] = [];
			listKey = key;
		} else {
			data[key] = parseInline(value);
			listKey = null;
		}
	}
	return { data, body: m[2], hasFrontmatter: true };
}

function quoteIfNeeded(v) {
	const s = String(v);
	return /[:#\[\]{}"'\n]|^\s|\s$/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** Arrays named in BLOCK_LISTS are written one item per line; the rest inline. */
const BLOCK_LISTS = new Set(['decisions']);

export function serializeFrontmatter(data, body = '') {
	const lines = ['---'];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			if (BLOCK_LISTS.has(key) || value.some((v) => /[,\[\]]/.test(String(v)))) {
				lines.push(`${key}:`);
				for (const v of value) lines.push(`  - ${quoteIfNeeded(v)}`);
			} else {
				lines.push(`${key}: [${value.map(quoteIfNeeded).join(', ')}]`);
			}
		} else {
			lines.push(`${key}: ${quoteIfNeeded(value)}`);
		}
	}
	lines.push('---', '');
	return lines.join('\n') + body.replace(/^\r?\n+/, '');
}
