/*
 * Generates module/gradient_map_layer.js from the plugin.
 *
 *   node scripts/build_module.mjs            write it
 *   node scripts/build_module.mjs --check    build in memory and fail if it differs
 *
 * The EmbodyTools loader fetches modules at runtime and evaluates them with
 * new Function('ctx', source), so a module is a function body that ends in
 * `return {...}` rather than a file that calls Plugin.register. That is the only
 * difference, and it is mechanical: drop the IIFE wrapper, and swap the register
 * call for a loader interface that reuses the plugin's own onload and onunload.
 *
 * Doing it by hand is how a module quietly falls a version behind the plugin it is
 * supposed to be, so it is a script and `npm test` checks the committed file matches.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'gradient_map_layer.js');
const OUT = join(root, 'module', 'gradient_map_layer.js');
const check_only = process.argv.includes('--check');

const die = (message) => { console.error('build_module: ' + message); process.exit(1); };

const text = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const lines = text.split('\n');

if (lines[0] !== '(function () {') die('the plugin no longer opens with the IIFE');

// The register block runs to the first `});` sitting at column 0 after it.
const open = lines.findIndex((l) => l === 'Plugin.register(PLUGIN_ID, {');
if (open === -1) die('could not find the Plugin.register call');
let close = -1;
for (let i = open + 1; i < lines.length; i++) {
	if (lines[i] === '});') { close = i; break; }
}
if (close === -1) die('could not find the end of the Plugin.register call');

// The trailing `})();` that shuts the IIFE. Everything after the register block
// should be that and blank lines; anything else means the file grew a tail this
// script does not know about, and guessing would silently drop it.
const tail = lines.slice(close + 1).filter((l) => l.trim() !== '');
if (tail.length !== 1 || tail[0] !== '})();') {
	die('unexpected content after the register block: ' + JSON.stringify(tail));
}

const body = lines.slice(1, open);
const register = lines.slice(open, close + 1);

// Keep the whole register object, just stop it registering. Its onload and onunload
// are then reused verbatim by the interface below, so the two forms cannot drift.
register[0] = 'const plugin_definition = {';
register[register.length - 1] = '};';

const INTERFACE = `
// ===========================================================================
// ===== EMBODYTOOLS MODULE INTERFACE ========================================
// ===========================================================================
/*
 * Everything above is gradient_map_layer.js verbatim, minus its IIFE wrapper, with
 * Plugin.register(...) turned into a plain object. The loader evaluates this file
 * with new Function('ctx', source), which supplies the function scope, so every
 * const and helper above keeps the name it had and cannot collide with anything else.
 *
 * load and unload are the plugin's own onload and onunload, called rather than
 * copied, so this form can never fall behind the plugin.
 *
 * This tool registers no Blockbench settings, so there is nothing for ctx to create.
 * Everything it remembers is in localStorage under gradient_map_layer.*, which is
 * deliberately left alone on unload: the library is the user's, and is shared with
 * the copy inside EmbodyTools.
 */
return {
	id: PLUGIN_ID,
	title: plugin_definition.title,
	version: PLUGIN_VERSION,
	description: plugin_definition.description,
	tags: plugin_definition.tags,
	variant: plugin_definition.variant,
	min_version: plugin_definition.min_version,

	blocked: function () {
		// Two menu Actions, a stylesheet and five Blockbench event hooks. The dialog
		// needs Vue, but it is only built on click, so a build without it is a broken
		// dialog rather than a module that cannot load: not a reason to sit out.
		if (typeof Blockbench === 'undefined' || typeof Blockbench.addCSS !== 'function') {
			return 'no Blockbench.addCSS for the dialog styles';
		}
		if (typeof Blockbench.on !== 'function' || typeof Blockbench.removeListener !== 'function') {
			return 'no Blockbench event hooks to follow edits with';
		}
		if (typeof Action === 'undefined') return 'no Action class to hang the menu entries on';
		return null;
	},

	load: function (ctx) {
		plugin_definition.onload();
		// Registered after the load so a throw leaves nothing to undo, and through ctx
		// so it also runs when the loader tears down a module whose load failed later.
		ctx.cleanup('gradient map layer', function () {
			try {
				plugin_definition.onunload();
			} catch (error) {
				console.error('[gradient_map_layer] could not unhook cleanly', error);
			}
		});
	},
};
`;

const built = body.join('\n').replace(/\n+$/, '')
	+ '\n\n' + register.join('\n') + '\n' + INTERFACE;

if (check_only) {
	if (!existsSync(OUT)) die('module/gradient_map_layer.js does not exist. Run npm run build:module.');
	const on_disk = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
	if (on_disk !== built) {
		die('module/gradient_map_layer.js is not what the plugin builds. Run npm run build:module.');
	}
	console.log('build_module: module matches the plugin');
	process.exit(0);
}

writeFileSync(OUT, built, 'utf8');
console.log(`build_module: wrote module/gradient_map_layer.js (${built.split('\n').length - 1} lines, ${built.length} bytes)`);
