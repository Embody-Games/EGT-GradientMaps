#!/usr/bin/env node
/*
 * Posts one changelog.json entry to a Discord forum thread via webhook.
 *
 * Reads config from the environment so the same file drops into every repo:
 *   DISCORD_WEBHOOK_URL   (secret)   the addons forum webhook
 *   DISCORD_THREAD_ID     (workflow) the plugin's forum post
 *   PLUGIN_NAME           (workflow) display name, e.g. "Delta Layers"
 *   PLUGIN_ICON_URL       (workflow) optional, raw URL to the icon png
 *   PLUGIN_COLOR          (workflow) optional, hex without the #
 *   GITHUB_REPOSITORY     (runner)   owner/repo, for the release link
 *   CHANGELOG_PATH        (optional) defaults to changelog.json
 *
 *   node scripts/discord_notify.mjs 1.5.1            post it
 *   node scripts/discord_notify.mjs 1.5.1 --dry-run  print the payload, post nothing
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = args.find((a) => !a.startsWith('-'));
if (!version) {
	console.error('usage: discord_notify.mjs <version> [--dry-run]');
	process.exit(2);
}

// Discord's hard caps. Going over any one of them is a 400, not a truncation.
const LIMIT = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25, total: 6000 };

const changelogPath = process.env.CHANGELOG_PATH || 'changelog.json';
const changelog = JSON.parse(readFileSync(changelogPath, 'utf8'));
const entry = changelog[version];
if (!entry) {
	console.error(`${changelogPath} has no entry for ${version}`);
	process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY || '';
const releaseUrl = repo ? `https://github.com/${repo}/releases/tag/v${version}` : undefined;
const pluginName = process.env.PLUGIN_NAME || repo.split('/')[1] || 'Plugin';

const clamp = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

/*
 * Pack whole bullets into a field until the next one would blow the 1024 cap, then
 * say how many were left behind. Cutting mid-sentence reads like a bug; cutting at a
 * bullet boundary reads like a summary.
 */
function packCategory(list) {
	const lines = [];
	let used = 0;
	for (let i = 0; i < list.length; i++) {
		const line = `- ${list[i]}`;
		const more = list.length - i;
		// Reserve room for the "and N more" line if anything would be left over.
		const tail = more > 1 ? `\n_…and ${more} more in the full release_`.length : 0;
		if (used + line.length + 1 + tail > LIMIT.fieldValue) {
			lines.push(`_…and ${more} more in the full release_`);
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	return clamp(lines.join('\n'), LIMIT.fieldValue);
}

const title = entry.title && entry.title !== version ? `${pluginName} v${version}: ${entry.title}` : `${pluginName} v${version}`;

// The date goes in as plain text. An embed `timestamp` is rendered in each viewer's
// own timezone, which turned a same-day release into "Yesterday at 2:00 PM".
const author = entry.author || 'Embody Games';

// The raw-on-main link, the same one the plugins are handed out with, so contractors
// only ever see one URL per plugin. It always serves current main rather than the
// version this post describes; PLUGIN_INSTALL_URL overrides it if that ever matters.
const pluginFile = process.env.PLUGIN_FILE || '';
const installUrl =
	process.env.PLUGIN_INSTALL_URL ||
	(repo && pluginFile ? `https://raw.githubusercontent.com/${repo}/main/${pluginFile}` : '');

const embed = {
	title: clamp(title, LIMIT.title),
	url: releaseUrl,
	color: parseInt(process.env.PLUGIN_COLOR || '5865F2', 16),
	fields: [],
	footer: { text: entry.date ? `${author} \u2022 ${entry.date}` : author },
};

// Shown as a bare URL, not a markdown link, because it gets pasted into
// Blockbench's Install from URL box rather than clicked.
const installField = installUrl
	? { name: 'Install', value: `${installUrl}\nBlockbench > Plugins > Install from URL`, inline: false }
	: null;

// Budget: every character in the embed counts toward 6000, title and footer included.
let budget = LIMIT.total - embed.title.length - (embed.footer.text?.length || 0);
if (installField) budget -= installField.name.length + installField.value.length;
let dropped = 0;

for (const category of entry.categories || []) {
	if (embed.fields.length >= LIMIT.fields) { dropped++; continue; }
	const name = clamp(category.title, LIMIT.fieldName);
	const value = packCategory(category.list || []);
	if (name.length + value.length > budget) { dropped++; continue; }
	budget -= name.length + value.length;
	embed.fields.push({ name, value, inline: false });
}

if (installField) embed.fields.push(installField);

if (dropped && releaseUrl) {
	embed.description = `_${dropped} more section${dropped > 1 ? 's' : ''} in the [full release](${releaseUrl})._`;
}

const payload = {
	username: pluginName,
	avatar_url: process.env.PLUGIN_ICON_URL || undefined,
	embeds: [embed],
};

const size = JSON.stringify(payload.embeds).length;
if (dryRun) {
	console.log(JSON.stringify(payload, null, 2));
	console.error(`\n-- ${embed.fields.length} field(s), ${dropped} dropped, embed JSON ${size} bytes`);
	for (const f of embed.fields) console.error(`   ${f.name}: ${f.value.length}/${LIMIT.fieldValue}`);
	process.exit(0);
}

const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!webhook) { console.error('DISCORD_WEBHOOK_URL is not set'); process.exit(1); }
const threadId = process.env.DISCORD_THREAD_ID;
const url = `${webhook}?wait=true${threadId ? `&thread_id=${threadId}` : ''}`;

const res = await fetch(url, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(payload),
});
if (!res.ok) {
	console.error(`discord returned ${res.status}: ${await res.text()}`);
	process.exit(1);
}
console.log(`posted ${pluginName} v${version}${threadId ? ` to thread ${threadId}` : ''}`);
