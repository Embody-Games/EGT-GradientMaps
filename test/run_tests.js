/*
 * Gradient Map Layer, standalone.
 *
 * What this covers is what actually breaks a Blockbench plugin: loading and unloading.
 * This one styles a dialog, hangs entries off four different menus, and follows edits
 * through Blockbench's own events instead of by wrapping functions, so it has more to
 * give back than most. Menus are the hard part - an Action added to a menu is NOT
 * removed by Action.delete(), because the menu keeps its own reference in `structure`,
 * and Texture.prototype.menu and TextureLayer.prototype.menu are shared singletons
 * whose structure only ever grows. A leak there survives a reload and leaves a dead
 * entry that opens nothing.
 *
 * What it does not cover: the colour maths, and the dialog, which needs Vue. The dialog
 * is only built on click, so the plugin loads without it.
 *
 * The mock is EGT-EmbodyTools/test/mock_blockbench.js, copied. It loads a plugin the way
 * Blockbench does, with new Function('requireNativeModule', 'require', code), so the file
 * under test is the file that ships.
 */
const { loadPlugin, resetProject, settle, TextureLayer, Texture, PathModule, fs } = require('./mock_blockbench');
const { createCanvas, CanvasRenderingContext2D } = require('canvas');
const { spawnSync } = require('child_process');

const ROOT = PathModule.resolve(__dirname, '..');
const PLUGIN_FILE = 'gradient_map_layer.js';
const PLUGIN_PATH = PathModule.join(ROOT, PLUGIN_FILE);

let passes = 0;
let failures = 0;
function check(label, condition, detail) {
	if (condition) { passes++; console.log('  ok   ' + label); }
	else { failures++; console.log('  FAIL ' + label + (detail !== undefined ? ('  -> ' + JSON.stringify(detail)) : '')); }
}
const section = (name) => console.log('\n' + name);

globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;

// Painter is the seam the plugin paints generated layers through; it is Blockbench's,
// not this plugin's, so the harness has to supply it.
globalThis.Painter = {
	current: {},
	lock_alpha: false,
	erase_mode: false,
	edit(texture, callback) {
		const layer = texture.getActiveLayer();
		callback(layer.canvas, { layer, ctx: layer.ctx });
		texture.updateLayerChanges(true);
	},
	startPaintTool() {},
	stopPaintTool() {},
};
globalThis.Toolbox = { selected: { id: 'brush_tool' } };

const EVENTS = ['finish_edit', 'init_edit', 'edit_texture', 'undo', 'redo'];
const MENUS = () => [
	['Tools', MenuBar.menus.tools],
	['Filter', MenuBar.menus.filter],
	['texture', Texture.prototype.menu],
	['layer', TextureLayer.prototype.menu],
];

/** Every menu entry belonging to this plugin, across all four menus. */
function entries() {
	const found = [];
	for (const [name, menu] of MENUS()) {
		for (const entry of menu.structure) {
			const id = entry && entry.id;
			if (id === 'gradient_map_layer' || id === 'gradient_map_layer_repeat') found.push(name + ':' + id);
		}
	}
	return found.sort();
}

function listenerCounts() {
	const counts = {};
	for (const name of EVENTS) counts[name] = Blockbench.listenerCount(name);
	return counts;
}

const EXPECTED_ENTRIES = [
	'Filter:gradient_map_layer',
	'Tools:gradient_map_layer',
	'Tools:gradient_map_layer_repeat',
	'layer:gradient_map_layer',
	'texture:gradient_map_layer',
].sort();

const registry = loadPlugin(PLUGIN_PATH);
const plugin = registry.gradient_map_layer;

(async function run() {
	// =====================================================================
	section('1. the plugin registers under the id Blockbench expects');
	// Blockbench derives a file-loaded plugin's id from its filename and refuses to
	// load it if the register call disagrees, so these three have to stay in step.
	check('registered as gradient_map_layer', !!plugin, Object.keys(registry));
	check('and that matches the filename', PLUGIN_FILE === 'gradient_map_layer.js');
	const pkg = JSON.parse(fs.readFileSync(PathModule.join(ROOT, 'package.json'), 'utf8'));
	check('the version matches package.json', plugin.version === pkg.version,
		{ plugin: plugin.version, pkg: pkg.version });
	const changelog = JSON.parse(fs.readFileSync(PathModule.join(ROOT, 'changelog.json'), 'utf8'));
	check('and the changelog has an entry for it', !!changelog[plugin.version],
		Object.keys(changelog));

	// =====================================================================
	section('2. it loads');
	resetProject();
	const listeners_before = listenerCounts();
	const css_before = Blockbench.css_handles.length;
	plugin.onload();

	check('the apply Action exists', !!BarItems.gradient_map_layer,
		Object.keys(BarItems).filter((k) => k.startsWith('gradient')));
	check('and Repeat Gradient Map', !!BarItems.gradient_map_layer_repeat);
	check('its dialog stylesheet was added', Blockbench.css_handles.length === css_before + 1);
	check('it is in all four menus', entries().join(',') === EXPECTED_ENTRIES.join(','), entries());
	for (const name of EVENTS) {
		check(`it is listening for ${name}`, Blockbench.listenerCount(name) > listeners_before[name],
			{ before: listeners_before[name], now: Blockbench.listenerCount(name) });
	}

	// =====================================================================
	section('3. and gives all of it back');
	const css_handle = Blockbench.css_handles[Blockbench.css_handles.length - 1];
	localStorage.setItem('gradient_map_layer.library', '[{"id":"g1"}]');
	plugin.onunload();

	check('both Actions are gone from BarItems',
		!BarItems.gradient_map_layer && !BarItems.gradient_map_layer_repeat);
	check('no menu entry is left anywhere', entries().length === 0, entries());
	check('the stylesheet was taken back', css_handle.deleted === true);
	for (const name of EVENTS) {
		check(`${name} has no listener left`, Blockbench.listenerCount(name) === listeners_before[name],
			{ expected: listeners_before[name], got: Blockbench.listenerCount(name) });
	}
	// Deliberate: the library is the user's, and is shared with the copy inside
	// EmbodyTools. Uninstalling one must not throw away the other's gradients.
	check('the gradient library in localStorage is left alone',
		localStorage.getItem('gradient_map_layer.library') === '[{"id":"g1"}]');

	// =====================================================================
	section('4. loading again does not double anything');
	// The menus are shared singletons, so this is where a leak shows: a second load
	// after a leaky unload leaves two of every entry, and Blockbench's plugin manager
	// does exactly this when you toggle a plugin off and on.
	plugin.onload();
	const after_second = entries();
	plugin.onunload();
	check('one entry per menu after the second load',
		after_second.join(',') === EXPECTED_ENTRIES.join(','), after_second);
	check('and nothing left after the second unload', entries().length === 0, entries());
	check('no leftover listeners either',
		JSON.stringify(listenerCounts()) === JSON.stringify(listeners_before), listenerCounts());

	// =====================================================================
	section('5. a load that fails part way leaves nothing behind');
	// addCSS is the first thing onload does. If it throws, Blockbench reports the
	// plugin as failed, and what matters is that nothing half-registered is left
	// sitting in the menus for the user to click.
	const real_addCSS = Blockbench.addCSS;
	Blockbench.addCSS = () => { throw new Error('boom'); };
	let threw = false;
	try { plugin.onload(); } catch (error) { threw = true; }
	Blockbench.addCSS = real_addCSS;

	check('the failure surfaces rather than loading half a plugin', threw);
	check('no Action was registered', !BarItems.gradient_map_layer && !BarItems.gradient_map_layer_repeat,
		Object.keys(BarItems).filter((k) => k.startsWith('gradient')));
	check('and no menu entry was left behind', entries().length === 0, entries());
	check('and no listener', JSON.stringify(listenerCounts()) === JSON.stringify(listeners_before),
		listenerCounts());

	// =====================================================================
	section('6. generated layers are remembered by layer uuid');
	// The plugin keys a generated layer's memory by the layer's uuid rather than its
	// name or index, which is what lets Delta Layers restore a texture and have the
	// gradient links still resolve. Nothing in either plugin says so out loud.
	resetProject();
	plugin.onload();
	const texture = new Texture({ name: 'Skin' });
	texture.layers_enabled = true;
	const source_layer = new TextureLayer({ name: 'Value' }, texture);
	source_layer.setSize(16, 16);
	texture.layers.push(source_layer);
	const generated = new TextureLayer({ name: 'Value (gradient)' }, texture);
	generated.setSize(16, 16);
	texture.layers.push(generated);

	const memory_key = 'gradient_map_layer.layers';
	localStorage.setItem(memory_key, JSON.stringify({
		[generated.uuid]: { source: source_layer.uuid, gradient: 'g1' },
	}));

	check('the generated layer has a uuid to be keyed by',
		typeof generated.uuid === 'string' && generated.uuid.length > 0, generated.uuid);
	const remembered = JSON.parse(localStorage.getItem(memory_key));
	check('and its memory is keyed by exactly that uuid',
		Object.keys(remembered)[0] === generated.uuid, Object.keys(remembered));
	check('which names the layer it was generated from',
		remembered[generated.uuid].source === source_layer.uuid);
	check('two layers cannot share memory', source_layer.uuid !== generated.uuid);
	plugin.onunload();

	// =====================================================================
	section('7. the EmbodyTools module form is in step and loads the same way');
	// module/gradient_map_layer.js is what contractors actually run: the loader
	// fetches it at runtime and evaluates it with new Function('ctx', source). It is
	// generated from the plugin, so the first thing to know is whether the committed
	// copy still matches, and the second is whether it still loads.
	const build = spawnSync(process.execPath, [PathModule.join(ROOT, 'scripts', 'build_module.mjs'), '--check'],
		{ cwd: ROOT, encoding: 'utf8' });
	check('the committed module matches the plugin', build.status === 0,
		(build.stdout || '') + (build.stderr || ''));

	const module_source = fs.readFileSync(PathModule.join(ROOT, 'module', 'gradient_map_layer.js'), 'utf8');
	// Anchored at a line start, because the generated header explains in prose what it
	// replaced and a bare substring match trips over its own comment.
	check('it does not register itself as a plugin', !/^Plugin\.register\(/m.test(module_source));

	// A stand-in for the loader's ctx. Only cleanup is used by this module, because it
	// has no settings, but recording the calls is how the teardown gets driven below.
	const undo = [];
	const stub_ctx = {
		pluginId: 'embodytools_next',
		cleanup(label, fn) { undo.push(typeof label === 'function' ? label : fn); },
	};

	resetProject();
	const gm = new Function('ctx', module_source)(stub_ctx);
	check('it returns a module object', !!gm && typeof gm === 'object');
	check('under the same id', gm && gm.id === 'gradient_map_layer', gm && gm.id);
	check('carrying the plugin version', gm && gm.version === plugin.version,
		{ module: gm && gm.version, plugin: plugin.version });
	check('and it is not blocked in this harness', gm.blocked() === null, gm.blocked());

	const before_module = listenerCounts();
	gm.load(stub_ctx);
	check('loading it registers the Actions', !!BarItems.gradient_map_layer && !!BarItems.gradient_map_layer_repeat);
	check('and the menu entries', entries().join(',') === EXPECTED_ENTRIES.join(','), entries());
	check('and it handed the loader something to undo with', undo.length === 1, undo.length);

	for (const fn of undo.slice().reverse()) fn();
	check('replaying that undo removes the Actions',
		!BarItems.gradient_map_layer && !BarItems.gradient_map_layer_repeat);
	check('and every menu entry', entries().length === 0, entries());
	check('and every listener', JSON.stringify(listenerCounts()) === JSON.stringify(before_module),
		listenerCounts());

	await settle(10);
	console.log('\n' + passes + ' passed, ' + failures + ' failed');
	process.exit(failures ? 1 : 0);
})().catch((error) => {
	console.error('\nharness blew up:', error);
	process.exit(1);
});
