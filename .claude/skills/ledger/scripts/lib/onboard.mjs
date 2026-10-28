// onboard.mjs — `ledger setup`: make this machine ready, doing every step that can be done
// without a browser. The two sign-ins (gh auth login, codex login) are reported as the user's
// steps; everything else (remotes, personal repo, reconciliation, template updates, author,
// folders, indexes) is performed here, idempotently.
//
// Invariant: the sync target is always <github login>/<repo name>, a PRIVATE PERSONAL repo.
// Never an organisation. The template (recorded in .ledger) is a read-only source of updates.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractors, scriptsDir } from './archive.mjs';
import { writeIndexes } from './index.mjs';
import { emailAllowed, git, gitState, isGenerated, isTemplateRemote, localState, normalizeRemote as normalize, run, setLocalState, teamPolicy, templateRemote } from './repo.mjs';

const REPO_NAME = 'ledger';
export const ROOT_FOLDERS = ['research/inbox', 'archive/inbox', 'memory/preferences', 'memory/facts', 'memory/lessons', 'projects'];

// A pull or a template merge can replace the skill's own files while this process is still running
// the code it loaded at start. That old code must not finish the job: it would create folders and
// write indexes for the old layout and commit them. Setup restarts itself once with the new code;
// the restarted process gets the first run's actions and outcome through this variable.
export const RESTART_ENV = 'LEDGER_SETUP_RESTARTED';

/** Hash of the skill's scripts (node_modules left out): changes when a pull or merge replaced the code on disk. */
export function scriptsFingerprint() {
	const base = scriptsDir();
	const h = crypto.createHash('sha256');
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			if (e.name === 'node_modules' || e.name === '.DS_Store') continue;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) h.update(path.relative(base, p)).update('\0').update(fs.readFileSync(p)).update('\0');
		}
	};
	walk(base);
	return h.digest('hex');
}

/** Rebuild the generated files with the skill code now on disk (a pull may just have replaced it), in a fresh process. */
export function reindexWithCodeOnDisk(root) {
	return run(process.execPath, [path.join(scriptsDir(), 'ledger.mjs'), 'reindex'], { cwd: root, timeoutMs: 300000 }).ok;
}

function regenerateAndContinue(root, op) {
	const conflicted = git(root, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
	if (conflicted.length && conflicted.every(isGenerated) && reindexWithCodeOnDisk(root)) {
		git(root, ['add', ...conflicted]);
		const cont = git(root, ['-c', 'core.editor=true', op, '--continue']);
		return { ok: cont.ok, note: `regenerated ${conflicted.join(', ')}` };
	}
	git(root, [op, '--abort']);
	return { ok: false, note: conflicted.length ? `conflicts in ${conflicted.join(', ')}; ${op} aborted` : `${op} failed` };
}

export function onboard(root, opts = {}) {
	let prior = null;
	try {
		prior = process.env[RESTART_ENV] ? JSON.parse(process.env[RESTART_ENV]) : null;
	} catch {
		prior = null;
	}
	const startPrint = scriptsFingerprint();
	const checks = [];
	const actions = prior && Array.isArray(prior.actions) ? [...prior.actions] : [];
	const yourSteps = [];
	const add = (name, ok, detail, fix, optional = false) =>
		checks.push({ name, ok: Boolean(ok), detail: detail || '', fix: ok ? undefined : fix, optional: optional || undefined });

	// --- tools -------------------------------------------------------------------------------
	const [major] = process.versions.node.split('.').map(Number);
	add('Node.js 20+', major >= 20, process.version, 'Install the LTS from nodejs.org, then quit and reopen Claude.');
	const g = run('git', ['--version']);
	add('git', g.ok, g.stdout, 'Run `git --version` in Terminal and accept the command line tools install.');

	let gh = run('gh', ['--version'], { timeoutMs: 30000 });
	if (gh.notInstalled) {
		const installer = process.platform === 'win32'
			? ['winget', ['install', '--id', 'GitHub.cli', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'], 'winget']
			: run('brew', ['--version']).ok ? ['brew', ['install', 'gh'], 'Homebrew'] : null;
		if (installer) {
			const b = run(installer[0], installer[1], { timeoutMs: 600000 });
			if (b.ok) {
				actions.push(`installed GitHub CLI with ${installer[2]} (a new session may be needed before it is on the PATH)`);
				gh = run('gh', ['--version'], { timeoutMs: 30000 });
			}
		}
	}
	add(
		'GitHub CLI installed',
		gh.ok,
		gh.stdout.split('\n')[0],
		process.platform === 'win32' ? 'In Terminal: winget install --id GitHub.cli -e ; then restart Claude.' : 'Install from cli.github.com (macOS .pkg), then run /ledger setup again.',
	);

	let signedIn = false;
	if (gh.ok) {
		const st = run('gh', ['auth', 'status'], { timeoutMs: 30000 });
		signedIn = st.ok && /Logged in/i.test(`${st.stdout}\n${st.stderr}`);
	}
	add('GitHub signed in', signedIn, '', 'In Terminal: gh auth login  (GitHub.com → HTTPS → Yes → Login with a web browser)');
	if (gh.ok && !signedIn) yourSteps.push('gh auth login');

	// --- identity: the personal account is the only valid target --------------------------------
	let login = opts.login || null;
	let name = null;
	let email = null;
	if (signedIn && !login) {
		const u = run('gh', ['api', 'user', '--jq', '[.login,.name,.email,.id]|@tsv'], { timeoutMs: 30000 });
		if (u.ok) {
			const [l, n, e, id] = u.stdout.split('\t');
			login = l;
			name = n && n !== 'null' ? n : l;
			email = e && e !== 'null' && e !== '' ? e : `${id}+${l}@users.noreply.github.com`;
		}
	}
	add('GitHub identity known', Boolean(login), login ? `@${login}` : '', 'Sign in first; identity comes from `gh api user`.');

	// --- git author (repo-local, so nothing else on the machine changes) -------------------------
	const haveName = git(root, ['config', 'user.name']).stdout;
	const haveEmail = git(root, ['config', 'user.email']).stdout;
	if ((!haveName || !haveEmail) && login) {
		git(root, ['config', 'user.name', name || login]);
		git(root, ['config', 'user.email', email || `${login}@users.noreply.github.com`]);
		actions.push(`set commit author to ${name || login} <${email || `${login}@users.noreply.github.com`}> for this repo`);
	}
	const author = `${git(root, ['config', 'user.name']).stdout} <${git(root, ['config', 'user.email']).stdout}>`;
	add('git author set', !/^ <>$/.test(author), author, 'Sign in to GitHub and run /ledger setup again.');

	// --- company account (team policy) ---------------------------------------------------------
	// With a .ledger-team file, a ledger on GitHub may only be created or linked under an account that
	// has a verified email at one of the company's domains. Checked before any repo is touched; the
	// verified account is recorded in .ledger.local, and sync refuses any other origin owner.
	const policy = teamPolicy(root);
	const githubTarget = !opts.target || /github\.com/i.test(String(opts.target));
	let accountOk = true;
	if (policy && githubTarget) {
		const wanted = [...policy.accountEmailMustMatch.map((w) => `*${w}*`), ...(policy.accountEmails.length ? ['or an address listed in .ledger-team'] : [])].join(', ');
		if (!signedIn || !login) {
			accountOk = false;
			add('company account verified', false, 'not signed in', `Sign in to GitHub with the account registered with your company email (${wanted}), then run /ledger setup again.`);
		} else {
			const em = run('gh', ['api', 'user/emails', '--jq', '[.[] | select(.verified) | .email] | join(",")'], { timeoutMs: 30000 });
			if (!em.ok && /scope/i.test(`${em.stderr}\n${em.stdout}`)) {
				accountOk = false;
				add('company account verified', false, `@${login}: the GitHub sign-in cannot show its verified emails yet`, 'In Terminal: gh auth refresh -h github.com -s user:email  (approve in the browser, then say done)');
				yourSteps.push('gh auth refresh -h github.com -s user:email');
			} else if (!em.ok) {
				accountOk = false;
				add('company account verified', false, (em.stderr || em.stdout || 'gh api user/emails failed').slice(0, 200), 'Check the GitHub sign-in (gh auth status) and run /ledger setup again.');
			} else {
				const emails = em.stdout.split(',').map((e) => e.trim()).filter(Boolean);
				const found = emails.find((e) => emailAllowed(policy, e));
				accountOk = Boolean(found);
				add(
					'company account verified',
					accountOk,
					found ? `@${login} · ${found}` : `@${login} has no verified email at ${wanted} (verified: ${emails.join(', ') || 'none'})`,
					`A ledger may only live under a GitHub account registered with a company email (${wanted}). In Terminal: gh auth logout, then gh auth login with that account, then /ledger setup again. Nothing was created.`,
				);
				setLocalState(root, { account: accountOk ? { login, email: found, verifiedAt: new Date().toISOString() } : null });
				if (accountOk) actions.push(`verified @${login} as a company account (${found})`);
			}
		}
	}

	// --- remotes and the personal repo ----------------------------------------------------------
	const state = gitState(root);
	add('inside a git repo', state.isRepo, state.branch || '', 'This folder is not a git repository; run `init` here to make it a ledger, or open Claude Code in your ledger folder.');
	const template = templateRemote(root);
	const repoName = opts.repoName || REPO_NAME;
	const target = opts.target || (login ? `https://github.com/${login}/${repoName}.git` : null);
	let repoOutcome = 'unchanged';
	if (!accountOk) repoOutcome = 'account-not-verified';

	if (state.isRepo && target && accountOk) {
		if (state.branch !== 'main') {
			git(root, ['branch', '-M', 'main']);
			actions.push(`renamed branch ${state.branch} → main`);
		}
		if (!state.remote) {
			git(root, ['remote', 'add', 'origin', target]);
			actions.push(`added origin → ${target}`);
		} else if (normalize(state.remote) !== normalize(target)) {
			git(root, ['remote', 'set-url', 'origin', target]);
			actions.push(
				isTemplateRemote(root, state.remote)
					? `origin pointed at the shared template (${state.remote}); re-pointed to your personal repo ${target}`
					: `origin re-pointed from ${state.remote} to ${target}`,
			);
		}
		if (template && !git(root, ['remote', 'get-url', 'template']).ok) {
			git(root, ['remote', 'add', 'template', template]);
			actions.push(`added remote "template" → ${template} (read-only source of skill updates)`);
		}
		// The template is pull-only: give its remote a push URL that cannot work, so even a hand-typed `git push template` fails.
		if (template && git(root, ['remote', 'get-url', 'template']).ok && git(root, ['remote', 'get-url', '--push', 'template']).stdout !== 'DISABLED') {
			git(root, ['remote', 'set-url', '--push', 'template', 'DISABLED']);
			actions.push('locked the template remote to pull only (its push URL is disabled)');
		}

		// Does the personal repo exist, and is it a ledger?
		git(root, ['add', '-A']);
		if (!git(root, ['diff', '--cached', '--quiet']).ok) {
			const staged = git(root, ['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean).length;
			git(root, ['commit', '-q', '-m', 'ledger: setup on a new machine']);
			actions.push(`committed ${staged} uncommitted file(s)`);
		}
		const probe = run('git', ['ls-remote', '--heads', target, 'main'], { cwd: root, timeoutMs: 60000 });
		const repoExists = probe.ok || opts.target;
		const remoteHasMain = probe.ok && probe.stdout.trim() !== '';
		if (!repoExists) {
			if (gh.ok && signedIn) {
				const c = run('gh', ['repo', 'create', `${login}/${repoName}`, '--private', '--description', 'My decision ledger (private). Runs, hand-offs and memory for the /ledger skill.'], { timeoutMs: 120000 });
				if (c.ok) {
					actions.push(`created private repo ${login}/${repoName} on GitHub`);
					const p = git(root, ['push', '-q', '-u', 'origin', 'main'], { timeoutMs: 180000 });
					actions.push(p.ok ? `pushed this folder to ${login}/${repoName}` : `push failed: ${p.stderr}`);
					repoOutcome = p.ok ? 'created' : 'push-failed';
				} else {
					repoOutcome = 'create-failed';
					add('personal repo', false, c.stderr || c.stdout, `In Terminal: gh repo create ${login}/${repoName} --private`);
				}
			} else {
				repoOutcome = 'needs-sign-in';
			}
		} else if (!remoteHasMain) {
			const p = git(root, ['push', '-q', '-u', 'origin', 'main'], { timeoutMs: 180000 });
			actions.push(p.ok ? `pushed this folder to the empty repo ${target}` : `push failed: ${p.stderr}`);
			repoOutcome = p.ok ? 'pushed-to-empty' : 'push-failed';
		} else {
			// Reconcile: replay anything local on top of the personal repo, then push.
			git(root, ['fetch', '-q', 'origin'], { timeoutMs: 120000 });
			const localOnly = Number(git(root, ['rev-list', '--count', 'origin/main..HEAD']).stdout || 0);
			const remoteOnly = Number(git(root, ['rev-list', '--count', 'HEAD..origin/main']).stdout || 0);
			if (remoteOnly > 0) {
				const rb = git(root, ['rebase', '-q', 'origin/main'], { timeoutMs: 120000 });
				if (!rb.ok) {
					const r = regenerateAndContinue(root, 'rebase');
					actions.push(r.note);
					if (!r.ok) repoOutcome = 'conflict';
				}
				if (repoOutcome !== 'conflict') actions.push(`took ${remoteOnly} commit(s) from ${login}/${repoName}` + (localOnly ? ` and replayed ${localOnly} local commit(s) on top` : ''));
			}
			if (repoOutcome !== 'conflict') {
				git(root, ['branch', '-q', '--set-upstream-to=origin/main', 'main']);
				if (localOnly > 0 || remoteOnly === 0) {
					const p = git(root, ['push', '-q', '-u', 'origin', 'main'], { timeoutMs: 180000 });
					if (localOnly > 0) actions.push(p.ok ? `pushed ${localOnly} local commit(s) to ${login}/${repoName}` : `push failed: ${p.stderr}`);
					if (!p.ok) repoOutcome = 'push-failed';
				}
				if (repoOutcome === 'unchanged') repoOutcome = remoteOnly || localOnly ? 'synced' : 'in-sync';
				// After a restart the pull has already happened: report the first run's outcome.
				if (repoOutcome === 'in-sync' && prior && prior.repoOutcome) repoOutcome = prior.repoOutcome;
			}
		}

		// Skill updates from the template, merged in; your runs are untouched.
		if (template && repoOutcome !== 'conflict' && git(root, ['remote', 'get-url', 'template']).ok) {
			const f = git(root, ['fetch', '-q', 'template', 'main'], { timeoutMs: 120000 });
			if (f.ok) {
				const behind = Number(git(root, ['rev-list', '--count', 'HEAD..template/main']).stdout || 0);
				if (behind > 0) {
					const m = git(root, ['merge', '-q', '--no-edit', '--allow-unrelated-histories', 'template/main'], { timeoutMs: 120000 });
					if (!m.ok) {
						const r = regenerateAndContinue(root, 'merge');
						actions.push(r.ok ? `took ${behind} skill update(s) from the template (${r.note})` : `template update skipped: ${r.note}`);
					} else actions.push(`took ${behind} skill update(s) from the template`);
					if (m.ok || !/aborted/.test(actions[actions.length - 1])) {
						const p = git(root, ['push', '-q', 'origin', 'main'], { timeoutMs: 180000 });
						if (!p.ok) actions.push(`push after template update failed: ${p.stderr}`);
					}
				}
			}
		}
	}

	// The pull or the template merge replaced the skill's scripts: finish with the new code, once.
	if (!prior && scriptsFingerprint() !== startPrint) {
		actions.push('the pull updated the ledger skill: setup restarted with the new version');
		return { ok: true, restart: { actions, repoOutcome } };
	}
	const finalRemote = gitState(root).remote;
	add(
		'origin is YOUR private repo (never the template, never an org)',
		Boolean(finalRemote && target) && !isTemplateRemote(root, finalRemote) && normalize(finalRemote) === normalize(target),
		finalRemote || 'no origin',
		'Sign in to GitHub and run /ledger setup again; it creates or links your personal repo.',
	);
	add('personal repo reachable and in sync', ['created', 'pushed-to-empty', 'synced', 'in-sync'].includes(repoOutcome), repoOutcome, 'See the actions list; fix the reported push/conflict and run /ledger setup again.');

	// --- Codex ---------------------------------------------------------------------------------
	let codex = run('codex', ['--version'], { timeoutMs: 30000 });
	if (codex.notInstalled && run('npm', ['--version']).ok) {
		const i = run('npm', ['install', '-g', '@openai/codex'], { timeoutMs: 600000 });
		if (i.ok) {
			actions.push('installed Codex CLI (npm install -g @openai/codex)');
			codex = run('codex', ['--version'], { timeoutMs: 30000 });
		}
	}
	add('Codex CLI installed', codex.ok, codex.stdout, 'In Terminal: npm install -g @openai/codex  (add sudo if npm says EACCES)');
	let codexIn = false;
	if (codex.ok) {
		const l = run('codex', ['login', 'status'], { timeoutMs: 30000 });
		codexIn = l.ok && !/not logged/i.test(`${l.stdout}\n${l.stderr}`);
	}
	add('Codex signed in', codexIn, '', 'In Terminal: codex login  (ChatGPT account, browser)');
	if (codex.ok && !codexIn) yourSteps.push('codex login');

	// --- text extractors for /ledger archive (optional: PDF/Word/Excel still work, Claude reads them itself; zips wait) --
	const missing = () => Object.entries(extractors()).filter(([, ok]) => !ok).map(([k]) => k);
	if (missing().length && fs.existsSync(path.join(scriptsDir(), 'package.json')) && run('npm', ['--version']).ok) {
		const before = missing();
		const i = run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], { cwd: scriptsDir(), timeoutMs: 300000 });
		if (i.ok && missing().length < before.length) actions.push(`installed the archive's text extractors (${before.filter((k) => !missing().includes(k)).join(', ')}) with npm install in the skill's scripts folder`);
	}
	add('archive extractors: pdf, docx, xlsx, zip (optional)', missing().length === 0, missing().length ? `missing: ${missing().join(', ')}` : 'all installed', `In Terminal: cd "${scriptsDir()}" && npm install`, true);

	// --- folders + indexes ---------------------------------------------------------------------
	for (const d of ROOT_FOLDERS) {
		fs.mkdirSync(path.join(root, d), { recursive: true });
		const keep = path.join(root, d, '.gitkeep');
		if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
	}
	const idx = writeIndexes(root);

	const ready = checks.filter((c) => !c.optional).every((c) => c.ok);
	return { ok: true, root, login, repo: login ? `${login}/${repoName}` : null, repoOutcome, template, policy, account: localState(root).account || null, checks, actions, yourSteps, indexes: idx, ready };
}
