/*
 * A deliberately small but faithful stand-in for the parts of Blockbench the plugin
 * touches, so the save/load round-trip can be exercised for real in Node: real files on
 * disk, real PNG encode/decode, real compositing.
 *
 * Every behaviour here was copied from Blockbench's own source (js/texturing/layers.js,
 * js/texturing/textures.js, js/io/codec.js) rather than guessed.
 */
const fs = require('fs');
const crypto = require('crypto');
const PathModule = require('path');
const { createCanvas, Image } = require('canvas');

const g = globalThis;

// --- DOM-ish -----------------------------------------------------------------
g.document = {
	createElement(tag) {
		if (tag !== 'canvas') throw new Error('only canvas is mocked, got ' + tag);
		return createCanvas(16, 16);
	},
	querySelector: () => null,
};
g.Image = Image;

// --- util --------------------------------------------------------------------
g.isApp = true;
g.PathModule = PathModule;
Math.clamp = (number, min, max) => Math.max(min, Math.min(max, number));
// Blockbench extends Array with this and plugin code uses it as if it were standard.
Array.prototype.remove = function (item) {
	const index = this.indexOf(item);
	if (index >= 0) this.splice(index, 1);
	return this;
};

g.pathToName = function (path, extension) {
	const parts = path.split('/').join('\\').split('\\');
	const last = parts[parts.length - 1];
	return extension === true ? last : last.replace(/\.\w+$/, '');
};
g.guid = function () {
	const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
	return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
};
g.isUUID = (s) => s.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);

// --- TextureLayer ------------------------------------------------------------
const LAYER_PROPERTIES = {
	name: { default: 'layer' },
	offset: { default: [0, 0], vector: true },
	scale: { default: [1, 1], vector: true },
	opacity: { default: 100 },
	visible: { default: true },
	blend_mode: {
		default: 'default',
		enum_values: ['default', 'set_opacity', 'color', 'multiply', 'add', 'darken',
			'lighten', 'screen', 'overlay', 'difference', 'alpha_mask'],
	},
};

class TextureLayer {
	constructor(data, texture, uuid) {
		this.uuid = (uuid && g.isUUID(uuid)) ? uuid : g.guid();
		this.texture = texture;
		this.type = 'layer';          // 5.2: TextureLayerItem discriminator
		this.parent_uuid = undefined; // 5.2: nesting, flat array + parent pointer
		this.canvas = g.document.createElement('canvas');
		this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
		for (const key in LAYER_PROPERTIES) {
			const property = LAYER_PROPERTIES[key];
			this[key] = property.vector ? property.default.slice() : property.default;
		}
		if (data) this.extend(data);
	}
	get width() { return this.canvas.width; }
	get height() { return this.canvas.height; }
	get scaled_width() { return this.canvas.width * this.scale[0]; }
	get scaled_height() { return this.canvas.height * this.scale[1]; }
	extend(data) {
		for (const key in LAYER_PROPERTIES) {
			if (data[key] === undefined) continue;
			this[key] = LAYER_PROPERTIES[key].vector ? data[key].slice() : data[key];
		}
		return this;
	}
	setSize(width, height) {
		this.canvas.width = width;
		this.canvas.height = height;
		return this;
	}
	select() { this.texture.selected_layer = this; }
	getSaveCopy() {
		const copy = {};
		for (const key in LAYER_PROPERTIES) {
			copy[key] = LAYER_PROPERTIES[key].vector ? this[key].slice() : this[key];
		}
		copy.width = this.width;
		copy.height = this.height;
		copy.data_url = this.canvas.toDataURL('image/png', 1);
		return copy;
	}
}
TextureLayer.properties = LAYER_PROPERTIES;
g.TextureLayer = TextureLayer;

// --- Texture -----------------------------------------------------------------
class Texture {
	constructor(data = {}) {
		this.uuid = g.guid();
		this.name = data.name || 'texture';
		this.path = data.path || '';
		this.width = 0;
		this.height = 0;
		this.saved = true;
		this.internal = false;
		this.layers = [];
		this.layers_enabled = false;
		this.selected_layer = null;
		this.flags = new Set();
		this.canvas = g.document.createElement('canvas');
		this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
		this.img = new Image();
	}
	/** Mirrors Texture.fromPath + the img.onload path in textures.js. */
	fromPath(path) {
		this.path = path;
		this.name = g.pathToName(path, true);
		const image = new Image();
		image.onload = () => {
			this.width = image.naturalWidth;
			this.height = image.naturalHeight;
			this.canvas.width = this.width;
			this.canvas.height = this.height;
			this.ctx.drawImage(image, 0, 0);
		};
		image.src = 'data:image/png;base64,' + fs.readFileSync(path, { encoding: 'base64' });
		this.img = image;
		return this;
	}
	add() {
		if (!g.Project.textures.includes(this)) g.Project.textures.push(this);
		g.Blockbench.dispatchEvent('add_texture', { texture: this });
		return this;
	}
	/** Simplified stand-in for the real bottom-to-top composite. */
	updateLayerChanges(update_data_url) {
		if (!this.layers_enabled || this.width === 0) return this;
		this.canvas.width = this.width;
		this.canvas.height = this.height;
		this.ctx.clearRect(0, 0, this.width, this.height);
		for (const layer of this.layers) {
			if (!layer.canvas) continue; // a layer group has no pixels of its own
			if (layer.visible === false || layer.opacity === 0) continue;
			this.ctx.globalAlpha = layer.opacity / 100;
			this.ctx.drawImage(layer.canvas, layer.offset[0], layer.offset[1],
				layer.scaled_width, layer.scaled_height);
		}
		this.ctx.globalAlpha = 1;
		if (update_data_url) {
			this.internal = true;
			this.source = this.canvas.toDataURL('image/png', 1);
		}
		return this;
	}
	/** Mirrors Texture.save() for the "path already exists" branch. */
	save() {
		const data_url = this.canvas.toDataURL('image/png');
		fs.writeFileSync(this.path, data_url.split(',')[1], { encoding: 'base64' });
		this.saved = true;
		return this;
	}
	activateLayers() {
		this.layers_enabled = true;
	}
}
Object.defineProperty(Texture, 'all', { get: () => (g.Project ? g.Project.textures : []) });
Texture.selected = null;
Texture.prototype.menu = {
	structure: [],
	addAction(action) { this.structure.push(action); },
};
// Blockbench's own Texture has this and the paint tools go through it. The layer
// suites never needed it; the paint module does.
Texture.prototype.getActiveLayer = function () {
	return this.selected_layer;
};

g.Texture = Texture;

/*
 * Blockbench 5.2 additions, ported from the v5.2.0-beta.1 source. Not on globalThis by
 * default: the tests switch them on and off to stand in for 5.2 and 5.1.
 */
class TextureLayerGroup {
	constructor(data = {}, texture, uuid) {
		this.uuid = (uuid && g.isUUID(uuid)) ? uuid : g.guid();
		this.texture = texture;
		this.type = 'layer_group';
		this.parent_uuid = undefined;
		this.name = data.name || 'layer';
		this.folded = data.folded === true;
		this.visible = data.visible !== false;
	}
	get children() {
		return this.texture.layers.filter((layer) => layer.parent_uuid == this.uuid);
	}
	select() { this.texture.selected_layer = this; }
}

const TextureLayerItem = {
	/** Verbatim port of TextureLayerItem.solveLayerOrder from layers.ts. */
	solveLayerOrder(list) {
		const sorted_list = [];
		const layer_by_parent = { '': [] };
		list.slice().reverse().forEach((layer) => {
			const key = layer.parent_uuid ?? '';
			layer_by_parent[key] = layer_by_parent[key] || [];
			layer_by_parent[key].push(layer);
		});
		const addRecursive = (layer) => {
			sorted_list.unshift(layer);
			if (!layer_by_parent[layer.uuid]) return;
			for (const child of layer_by_parent[layer.uuid]) addRecursive(child);
		};
		for (const layer of layer_by_parent['']) addRecursive(layer);
		return sorted_list;
	},
};

/** Pretend we are running Blockbench 5.2. */
function enableLayerGroups() {
	g.TextureLayerGroup = TextureLayerGroup;
	g.TextureLayerItem = TextureLayerItem;
}
/** Pretend we are running Blockbench 5.1, where groups do not exist. */
function disableLayerGroups() {
	delete g.TextureLayerGroup;
	delete g.TextureLayerItem;
}

// --- project / format / codecs ----------------------------------------------
g.Project = { textures: [], export_codec: null, export_path: null, saved: true, name: 'Knight' };
g.Format = { id: 'hytale_character', codec: null };
g.Codecs = {};

class Codec {
	constructor(id, data) {
		this.id = id;
		g.Codecs[id] = this;
		this.name = data.name || id;
		Object.assign(this, data);
	}
}
g.Codec = Codec;

// --- events / UI -------------------------------------------------------------
const event_listeners = {};
g.Blockbench = {
	version: '5.0.5',
	messages: [],
	message_box_answer: null,
	message_box_calls: [],
	on(name, callback) {
		if (!event_listeners[name]) event_listeners[name] = [];
		event_listeners[name].push(callback);
		return {
			delete: () => {
				const index = event_listeners[name].indexOf(callback);
				if (index !== -1) event_listeners[name].splice(index, 1);
			},
		};
	},
	dispatchEvent(name, data) {
		for (const callback of (event_listeners[name] || []).slice()) callback(data);
	},
	showQuickMessage(message) { g.Blockbench.messages.push(message); },
	showMessageBox(options, callback) {
		g.Blockbench.message_box_calls.push(options);
		if (callback) callback(g.Blockbench.message_box_answer);
	},
	getIconNode: () => ({}),
};

g.settings = {};
class Setting {
	constructor(id, data) {
		this.id = id;
		g.settings[id] = this;
		this.value = data.value;
		Object.assign(this, data);
	}
	delete() { delete g.settings[this.id]; }
}
g.Setting = Setting;

g.BarItems = {};
/*
 * Core's BarItem remembers the toolbars it was added to and takes itself back out
 * in delete(), which is what a plugin relies on to unhook cleanly. A stand-in that
 * only forgets the id would pass an unload that leaves a dead button on a toolbar.
 */
class Action {
	constructor(id, data) {
		this.id = id;
		this.toolbars = [];
		g.BarItems[id] = this;
		Object.assign(this, data);
	}
	delete() {
		this.toolbars.slice().forEach((bar) => bar.remove(this));
		delete g.BarItems[this.id];
	}
}
g.Action = Action;

class Tool extends Action {
	select() { if (g.Toolbox) g.Toolbox.selected = this; return this; }
}
g.Tool = Tool;

class Toolbar {
	constructor(id) { this.id = id; this.children = []; }
	add(item, position) {
		if (position === undefined) position = this.children.length;
		this.children.splice(position, 0, item);
		if (item.toolbars) item.toolbars.push(this);
		return this;
	}
	remove(item) {
		const i = this.children.indexOf(item);
		if (i !== -1) this.children.splice(i, 1);
		const j = item.toolbars ? item.toolbars.indexOf(this) : -1;
		if (j !== -1) item.toolbars.splice(j, 1);
		return this;
	}
}
g.Toolbar = Toolbar;
g.Toolbars = {
	element_stretch: new Toolbar('element_stretch'),
	tools: new Toolbar('tools'),
};
// The stock tool order, so "insert after the stretch tool" has something to find.
g.Toolbars.tools.children.push('move_tool', 'resize_tool', 'rotate_tool', 'vertex_snap_tool', 'stretch_tool', 'knife_tool');
// Only needed so a tool being deleted has somewhere to send the selection.
new Tool('resize_tool', { name: 'Resize' });

g.Panels = { layers: { inside_vue: { layers: [] } } };
g.BARS = { updateConditions() {} };
g.updateInterfacePanels = function () {};

g.plugin_registry = {};
g.BBPlugin = {
	register(id, data) { g.plugin_registry[id] = data; },
};
// Blockbench exposes the same thing under both names, and which one a plugin reaches
// for is down to when it was written: the bundle uses BBPlugin, this plugin uses
// Plugin. The alias is what the real app does, not a convenience for the harness.
g.Plugin = g.BBPlugin;

// --- native modules ---------------------------------------------------------
/*
 * Blockbench does not hand plugins plain node fs. It hands them createScopedFS(), whose
 * methods have FIXED arity (js/util/scoped_fs.ts) - so `watch(path, options, listener)`
 * will not accept the two-argument form that plain Node allows. Mirror that exactly,
 * otherwise the harness happily passes code that breaks in the real app.
 */
const scoped_fs = {
	accessSync: (path, mode) => fs.accessSync(path, mode),
	copyFileSync: (src, dest, mode) => fs.copyFileSync(src, dest, mode),
	readFileSync: (path, options) => fs.readFileSync(path, options),
	writeFileSync: (path, content, options) => fs.writeFileSync(path, content, options),
	appendFileSync: (path, content, options) => fs.appendFileSync(path, content, options),
	existsSync: (path) => fs.existsSync(path),
	mkdirSync: (path, options) => fs.mkdirSync(path, options),
	readdirSync: (path, options) => fs.readdirSync(path, options),
	renameSync: (from, to) => fs.renameSync(from, to),
	rmSync: (path, options) => fs.rmSync(path, options),
	rmdirSync: (path, options) => fs.rmdirSync(path, options),
	unlinkSync: (path) => fs.unlinkSync(path),
	statSync: (path, options) => fs.statSync(path, options),
	watchFile: (path, options, listener) => fs.watchFile(path, options, listener),
	unwatchFile: (path, listener) => fs.unwatchFile(path, listener),
	watch: (path, options, listener) => fs.watch(path, options, listener),
};

g.requireNativeModule = function (name) {
	if (name === 'fs') return scoped_fs;
	if (name === 'crypto') return crypto;
	throw new Error('module not available in the harness: ' + name);
};

// --- helpers for the tests --------------------------------------------------
function loadPlugin(plugin_path) {
	const code = fs.readFileSync(plugin_path, 'utf-8');
	const runner = new Function('requireNativeModule', 'require', code);
	runner(g.requireNativeModule, g.requireNativeModule);
	return g.plugin_registry;
}

function resetProject() {
	g.Project = { textures: [], export_codec: 'blockymodel', export_path: null, saved: true, name: 'Knight' };
	Texture.selected = null;
	g.Blockbench.messages = [];
	g.Blockbench.message_box_calls = [];
}

/** Waits out the async Image decodes the plugin (and the mock) rely on. */
/*
 * --- what Gradient Map Layer needs ------------------------------------------
 *
 * The fourth module is the only one that styles a dialog, hangs entries off the menu bar,
 * and follows edits through Blockbench's own events rather than by wrapping functions. None
 * of that existed here, so it sat out of every run with "no Blockbench.addCSS" and the
 * suites were green without ever loading it.
 *
 * Everything below is shaped to be checkable: a stylesheet that records whether it was
 * deleted, menus that keep their structure array, and a listener registry the suites can
 * read. Unloading cleanly is the whole reason the bundle can hold four tools, so the mock
 * has to be able to tell when it has not.
 */

/** Menus keep their entries in `structure`, and nothing removes them for you. */
function makeMenu(name) {
	return {
		name,
		structure: [],
		addAction(action) { this.structure.push(action); },
	};
}

TextureLayer.prototype.menu = makeMenu('texture_layer');

g.MenuBar = {
	menus: { tools: makeMenu('tools'), filter: makeMenu('filter') },
	addAction(action, path) {
		const menu = g.MenuBar.menus[path];
		if (!menu) throw new Error('no such menu: ' + path);
		menu.addAction(action);
	},
};

g.Modes = { paint: true, edit: false, id: 'paint' };

// Every stylesheet handed out, so a suite can ask whether the plugin took its own back.
g.Blockbench.css_handles = [];
g.Blockbench.addCSS = function (css) {
	const handle = { css, deleted: false, delete() { this.deleted = true; } };
	g.Blockbench.css_handles.push(handle);
	return handle;
};

// GML removes its hooks by (name, function) rather than through the handle Blockbench.on
// returns. Both have to work, and both have to actually drop the listener.
g.Blockbench.removeListener = function (name, callback) {
	const list = event_listeners[name];
	if (!list) return;
	const index = list.indexOf(callback);
	if (index !== -1) list.splice(index, 1);
};

/** How many listeners are on an event right now. For "did it unhook" assertions. */
g.Blockbench.listenerCount = function (name) {
	return (event_listeners[name] || []).length;
};

/*
 * Undo, enough of it to be honest about ordering. GML wraps its writes in
 * initEdit/finishEdit and calls amendEdit while a stroke is being replaced, and a module
 * that pushes an entry without closing it is a real bug, so the stand-in counts both ends
 * rather than pretending to be a working undo stack.
 */
g.Undo = {
	history: [],
	open: null,
	amended: 0,
	initEdit(aspects) {
		g.Undo.open = { aspects, amended: false };
		return g.Undo.open;
	},
	finishEdit(name) {
		g.Undo.history.push({ name, aspects: g.Undo.open && g.Undo.open.aspects });
		g.Undo.open = null;
	},
	cancelEdit() { g.Undo.open = null; },
	amendEdit(form, callback) {
		g.Undo.amended++;
		if (typeof callback === 'function') callback({}, form);
	},
	undo() {},
	redo() {},
};

/*
 * localStorage, because GML keeps its gradient library, its groups, its options and its
 * per-layer memory there rather than in Blockbench settings. Which also means the bundle
 * does not clear it on unload, deliberately, so a standalone copy keeps your gradients -
 * and a suite can check that it did not.
 */
const storage = new Map();
g.localStorage = {
	getItem: (key) => (storage.has(key) ? storage.get(key) : null),
	setItem: (key, value) => { storage.set(key, String(value)); },
	removeItem: (key) => { storage.delete(key); },
	clear: () => storage.clear(),
	get length() { return storage.size; },
	key: (i) => Array.from(storage.keys())[i] ?? null,
};

function settle(ms = 60) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { loadPlugin, resetProject, settle, TextureLayer, TextureLayerGroup,
	enableLayerGroups, disableLayerGroups, Texture, Codec, fs, PathModule, makeMenu };
