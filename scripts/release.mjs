#!/usr/bin/env node
/*
 * Cuts a new version of the plugin.
 *
 *   node scripts/release.mjs minor --title "Layer groups" \
 *     --added "Layer groups from Blockbench 5.2 survive a save and reload." \
 *     --fixed "A texture holding a group no longer stops saving its layers."
 *
 * In order: run the test suites, bump PLUGIN_VERSION in the plugin file (the one place
 * the version lives) and in package.json, add the changelog.json entry, commit, tag
 * vX.Y.Z, push. Tests run before anything is written, so a failed suite leaves the
 * working tree exactly as it was.
 *
 * Positional: major | minor | patch | an explicit x.y.z
 * Flags:
 *   --title "..."        short release name, required, shows up as the release title
 *   --added   "..."      one changelog line, repeatable
 *   --changed "..."      same
 *   --fixed   "..."      same
 *   --removed "..."      same
 *   --safeguards "..."   same
 *   --notes <file.json>  categories from a file instead of the flags, either
 *                        [{"title":"Added","list":["..."]}] or {"Added":["..."]}
 *   --date YYYY-MM-DD    defaults to today
 *   --remote <name>      defaults to origin
 *   --no-test            skip the suites (do not)
 *   --no-push            commit and tag locally, push by hand later
 *   --dry-run            print what would happen, touch nothing
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'gradient_map_layer.js';
const VERSION_LINE = /^(const PLUGIN_VERSION = ')(\d+\.\d+\.\d+)(';)$/m;
const CATEGORY_ORDER = ['Added', 'Changed', 'Fixed', 'Removed', 'Safeguards'];
const SUITES = ['run_tests.js'];

function die(message) {
	console.error(`release: ${message}`);
	process.exit(1);
}

function git(args, { capture = false } = {}) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	});
}

function parseArgs(argv) {
	const opts = { categories: new Map(), push: true, test: true, dry: false, remote: 'origin' };
	let bump = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined) die(`${arg} needs a value`);
			return v;
		};
		if (arg === '--title') opts.title = value();
		else if (arg === '--date') opts.date = value();
		else if (arg === '--notes') opts.notes = value();
		else if (arg === '--remote') opts.remote = value();
		else if (arg === '--dry-run') opts.dry = true;
		else if (arg === '--no-push') opts.push = false;
		else if (arg === '--no-test') opts.test = false;
		else if (/^--(added|changed|fixed|removed|safeguards)$/.test(arg)) {
			const key = arg.slice(2);
			const name = key[0].toUpperCase() + key.slice(1);
			if (!opts.categories.has(name)) opts.categories.set(name, []);
			opts.categories.get(name).push(value());
		} else if (arg.startsWith('-')) die(`unknown flag ${arg}`);
		else if (bump) die('give exactly one of major, minor, patch or an explicit x.y.z');
		else bump = arg;
	}
	if (!bump) die('say what to bump: major, minor, patch or an explicit x.y.z');
	opts.bump = bump;
	return opts;
}

function nextVersion(current, bump) {
	if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
	const [major, minor, patch] = current.split('.').map(Number);
	if (bump === 'major') return `${major + 1}.0.0`;
	if (bump === 'minor') return `${major}.${minor + 1}.0`;
	if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
	return die(`${bump} is not major, minor, patch or an x.y.z version`);
}

const compareVersions = (a, b) => {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
	return 0;
};

const opts = parseArgs(process.argv.slice(2));

// --- work out the versions -------------------------------------------------
const pluginPath = join(root, PLUGIN);
const source = readFileSync(pluginPath, 'utf8');
const found = source.match(VERSION_LINE);
if (!found) die(`could not find the "const PLUGIN_VERSION = '...';" line in ${PLUGIN}`);

const current = found[2];
const version = nextVersion(current, opts.bump);
if (compareVersions(version, current) <= 0) die(`${version} is not newer than ${current}`);

const changelogPath = join(root, 'changelog.json');
const changelog = JSON.parse(readFileSync(changelogPath, 'utf8'));
if (changelog[version]) die(`changelog.json already has an entry for ${version}`);

// --- the changelog entry --------------------------------------------------
if (!opts.title) die('--title "short summary" is required, it becomes the release title');

let categories;
if (opts.notes) {
	const raw = JSON.parse(readFileSync(opts.notes, 'utf8'));
	categories = Array.isArray(raw)
		? raw
		: Object.entries(raw).map(([title, list]) => ({ title, list }));
} else {
	categories = [...opts.categories.entries()]
		.sort((a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]))
		.map(([title, list]) => ({ title, list }));
}
if (!categories.length) {
	die('a release needs changelog lines: --added / --changed / --fixed / --removed / --safeguards, or --notes <file.json>');
}
for (const category of categories) {
	if (!category.title || !Array.isArray(category.list) || !category.list.length) {
		die(`changelog category ${JSON.stringify(category.title)} has no lines`);
	}
}

const entry = {
	title: opts.title,
	author: 'Embody Games',
	date: opts.date || new Date().toISOString().slice(0, 10),
	categories,
};

const subject = `v${version}: ${opts.title}`;
const body = categories
	.map((c) => `${c.title}\n${c.list.map((line) => `- ${line}`).join('\n')}`)
	.join('\n\n');

// --- preflight ------------------------------------------------------------
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).trim();
if (branch === 'HEAD') die('detached HEAD, check out a branch first');

if (opts.test) {
	const suites = SUITES.filter((s) => existsSync(join(root, 'test', s)));
	if (!suites.length) {
		console.warn('release: no test suites found under test/, releasing without them');
	} else {
		for (const suite of suites) {
			console.log(`release: node test/${suite}`);
			try {
				execFileSync(process.execPath, [join('test', suite)], { cwd: root, stdio: 'inherit' });
			} catch {
				die(`test/${suite} failed, nothing was written`);
			}
		}
	}
}

if (opts.dry) {
	console.log(`\n--- dry run, nothing written ---\n${current} -> ${version} on branch ${branch}\n`);
	console.log(`${subject}\n\n${body}\n`);
	console.log(`would commit ${PLUGIN}, changelog.json, package.json${existsSync(join(root, 'package-lock.json')) ? ', package-lock.json' : ''}`);
	console.log(`would tag v${version}${opts.push ? ` and push to ${opts.remote}/${branch}` : ' (no push)'}`);
	process.exit(0);
}

// --- write ----------------------------------------------------------------
writeFileSync(pluginPath, source.replace(VERSION_LINE, `$1${version}$3`));

const ordered = {};
for (const key of Object.keys({ ...changelog, [version]: entry }).sort(compareVersions)) {
	ordered[key] = key === version ? entry : changelog[key];
}
writeFileSync(changelogPath, `${JSON.stringify(ordered, null, 2)}\n`);

const packagePath = join(root, 'package.json');
if (existsSync(packagePath)) {
	const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
	pkg.version = version;
	writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

// npm writes the version into the lockfile in two places. Without this the lockfile
// drifts behind package.json, which it had done since 1.3.0.
const lockPath = join(root, 'package-lock.json');
if (existsSync(lockPath)) {
	const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
	lock.version = version;
	if (lock.packages?.['']) lock.packages[''].version = version;
	writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

// --- commit, tag, push ----------------------------------------------------
git(['add', '-A']);
git(['commit', '-m', subject, '-m', body]);
git(['tag', '-a', `v${version}`, '-m', subject, '-m', body]);

// The device bridge has no stored git credential, so a token scoped to this repo can sit
// at .git/egt-push-token. Anything under .git is untracked, so it is never committed. Git
// redacts the credentials when it echoes the URL back.
function push(branch) {
	const tokenPath = join(root, '.git', 'egt-push-token');
	const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
	const url = git(['remote', 'get-url', opts.remote], { capture: true }).trim();
	const useToken = token && url.startsWith('https://github.com/');
	const target = useToken
		? url.replace('https://github.com/', `https://x-access-token:${token}@github.com/`)
		: opts.remote;

	git(['push', '--follow-tags', target, branch]);
	// Pushing to a URL rather than a remote name leaves refs/remotes/<remote> behind, which
	// makes the clone look unpushed in GitHub Desktop.
	if (useToken) git(['fetch', opts.remote]);
}

if (opts.push) {
	push(branch);
	console.log(`\nrelease: pushed v${version} to ${opts.remote}/${branch}. The release workflow publishes the notes.`);
} else {
	console.log(`\nrelease: committed and tagged v${version} locally. Push with:\n  git push --follow-tags ${opts.remote} ${branch}`);
}
