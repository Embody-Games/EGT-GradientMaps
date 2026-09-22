(function () {

/* =========================================================================
 * Gradient Map Layer
 * Applies a saved 256x16 gradient map over a value / luminance map.
 * ========================================================================= */

// Must match the filename: gradient_map_layer.js
const PLUGIN_ID = 'gradient_map_layer';
// Single source of truth for the version, read by the register block below and by
// scripts/release.mjs, which matches this line whole. Keep it bare.
const PLUGIN_VERSION = '1.4.0';

// The namespace this plugin stores things under: the property it hangs its own data off a
// layer, and the prefix for its localStorage keys. Deliberately not named after the plugin
// id - inside the EmbodyTools bundle that name belongs to the bundle, and a module reaching
// for it would quietly start writing its data under "embodytools" instead.
const DATA_KEY = 'gradient_map_layer';
const LIB_KEY = 'gradient_map_layer.library';
const GROUP_KEY = 'gradient_map_layer.groups';
const OPT_KEY = 'gradient_map_layer.options';
const GW = 256;   // gradient map width
const GH = 16;    // gradient map height

let action_apply, action_repeat, css_style, open_dialog;
let dialog_active = false;  // true only while the dialog is on screen
let syncing = false;   // re-entrancy guard for the auto sync pass
let applying = false;  // set while our own undo-tracked edit runs
let last_run = null;

/* ============================== small utils ============================== */

function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

/** Number inputs can go empty / NaN while typing. */
function num(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function uid() {
	if (typeof guid === 'function') return guid();
	return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function hexToRGB(hex) {
	hex = String(hex || '#000000').replace('#', '').trim();
	if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
	if (hex.length !== 6 || !/^[0-9a-f]{6}$/i.test(hex)) return [0, 0, 0];
	const n = parseInt(hex, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
	return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
	let bin = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}

function base64ToBytes(b64) {
	let bin;
	try {
		bin = atob(String(b64 || ''));
	} catch (err) {
		return new Uint8ClampedArray(0);
	}
	const out = new Uint8ClampedArray(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * Blockbench's own text prompt. window.prompt is not a usable fallback here
 * (Electron refuses it), so if the prompt is unavailable we go ahead with the
 * suggested name and let the user rename afterwards.
 */
function askForText(title, label, value, callback) {
	try {
		if (typeof Blockbench !== 'undefined' && typeof Blockbench.textPrompt === 'function') {
			Blockbench.textPrompt(title, value, function (result) {
				const text = String(result === undefined || result === null ? '' : result).trim();
				if (text) callback(text);
			}, { placeholder: label });
			return;
		}
	} catch (err) { /* fall through */ }
	try {
		if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
			const result = window.prompt(label, value);
			if (result && result.trim()) callback(result.trim());
			return;
		}
	} catch (err) { /* fall through */ }
	if (value) callback(String(value).trim());
}

function newCanvas(w, h) {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

function ctxOf(canvas) {
	return canvas.getContext('2d', { willReadFrequently: true });
}

/* ============================== colour math ============================== */

const SRGB_TO_LINEAR = (function () {
	const t = new Float32Array(256);
	for (let i = 0; i < 256; i++) {
		const c = i / 255;
		t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	}
	return t;
})();

function linearToSrgbByte(c) {
	c = clamp(c, 0, 1);
	const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
	return clamp(Math.round(v * 255), 0, 255);
}

function srgbToOklab(r, g, b) {
	const lr = SRGB_TO_LINEAR[clamp(Math.round(r), 0, 255)];
	const lg = SRGB_TO_LINEAR[clamp(Math.round(g), 0, 255)];
	const lb = SRGB_TO_LINEAR[clamp(Math.round(b), 0, 255)];
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return [
		0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
	];
}

function oklabToSrgb(L, a, b) {
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
	const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
	return [
		linearToSrgbByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		linearToSrgbByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		linearToSrgbByte(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
	];
}

/* ============================ gradient model ============================ */
/*
 * gradient = {
 *   id, name, builtin, type: 'stops' | 'raw',
 *   interpolation: 'linear' | 'smooth' | 'step',
 *   space: 'srgb' | 'oklab',
 *   stops: [{p: 0..1, c: '#rrggbb', a: 0..255}],
 *   lut: base64 of 256*4 bytes      (type 'raw' only)
 * }
 */

const INTERPOLATIONS = [
	{ id: 'linear', name: 'Linear' },
	{ id: 'smooth', name: 'Smooth' },
	{ id: 'step', name: 'Hard steps' }
];

const COLOR_SPACES = [
	{ id: 'srgb', name: 'sRGB' },
	{ id: 'oklab', name: 'OKLab (perceptual)' }
];

function lutFromStops(stops, interpolation, space) {
	const lut = new Uint8ClampedArray(GW * 4);
	const list = (stops || []).slice().sort((a, b) => a.p - b.p);
	if (!list.length) return lut;

	const cache = list.map(s => {
		const rgb = hexToRGB(s.c);
		return { p: clamp(s.p, 0, 1), rgb: rgb, lab: space === 'oklab' ? srgbToOklab(rgb[0], rgb[1], rgb[2]) : null, a: clamp(s.a === undefined ? 255 : s.a, 0, 255) };
	});

	for (let x = 0; x < GW; x++) {
		const t = x / (GW - 1);
		let lo = cache[0], hi = cache[cache.length - 1];
		for (let i = 0; i < cache.length; i++) if (cache[i].p <= t) lo = cache[i];
		for (let i = cache.length - 1; i >= 0; i--) if (cache[i].p >= t) hi = cache[i];

		let f = hi.p > lo.p ? (t - lo.p) / (hi.p - lo.p) : 0;
		if (interpolation === 'step') f = 0;
		else if (interpolation === 'smooth') f = f * f * (3 - 2 * f);

		let r, g, b;
		if (f <= 0) { r = lo.rgb[0]; g = lo.rgb[1]; b = lo.rgb[2]; }
		else if (f >= 1) { r = hi.rgb[0]; g = hi.rgb[1]; b = hi.rgb[2]; }
		else if (space === 'oklab') {
			const c = oklabToSrgb(
				lo.lab[0] + (hi.lab[0] - lo.lab[0]) * f,
				lo.lab[1] + (hi.lab[1] - lo.lab[1]) * f,
				lo.lab[2] + (hi.lab[2] - lo.lab[2]) * f
			);
			r = c[0]; g = c[1]; b = c[2];
		} else {
			r = lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * f;
			g = lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * f;
			b = lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * f;
		}

		const i4 = x * 4;
		lut[i4] = r;
		lut[i4 + 1] = g;
		lut[i4 + 2] = b;
		lut[i4 + 3] = lo.a + (hi.a - lo.a) * f;
	}
	return lut;
}

function getLUT(gradient) {
	if (!gradient) return lutFromStops([{ p: 0, c: '#000000', a: 255 }, { p: 1, c: '#ffffff', a: 255 }], 'linear', 'srgb');
	if (gradient.type === 'raw' && gradient.lut) {
		const bytes = base64ToBytes(gradient.lut);
		if (bytes.length === GW * 4) return bytes;
	}
	return lutFromStops(gradient.stops, gradient.interpolation || 'linear', gradient.space || 'srgb');
}

/** Render a LUT as a 256x16 image (the on-disk gradient map format). */
function lutToCanvas(lut) {
	const canvas = newCanvas(GW, GH);
	const ctx = ctxOf(canvas);
	const img = ctx.createImageData(GW, GH);
	for (let y = 0; y < GH; y++) {
		for (let x = 0; x < GW; x++) {
			const s = x * 4, d = (y * GW + x) * 4;
			img.data[d] = lut[s];
			img.data[d + 1] = lut[s + 1];
			img.data[d + 2] = lut[s + 2];
			img.data[d + 3] = lut[s + 3];
		}
	}
	ctx.putImageData(img, 0, 0);
	return canvas;
}

/** Collapse any image into a 256 entry LUT (alpha weighted column average). */
function lutFromImage(image) {
	const canvas = newCanvas(GW, GH);
	const ctx = ctxOf(canvas);
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(image, 0, 0, GW, GH);
	const data = ctx.getImageData(0, 0, GW, GH).data;
	const lut = new Uint8ClampedArray(GW * 4);
	for (let x = 0; x < GW; x++) {
		let r = 0, g = 0, b = 0, a = 0;
		for (let y = 0; y < GH; y++) {
			const i = (y * GW + x) * 4;
			const av = data[i + 3];
			r += data[i] * av; g += data[i + 1] * av; b += data[i + 2] * av;
			a += av;
		}
		const i4 = x * 4;
		if (a > 0) {
			lut[i4] = r / a; lut[i4 + 1] = g / a; lut[i4 + 2] = b / a;
		}
		lut[i4 + 3] = a / GH;
	}
	return lut;
}

/* ===================== Photoshop .grd gradient files ===================== */
/*
 * A .grd is "8BGR" + a version, followed by a Photoshop action descriptor.
 * Each gradient holds a list of colour stops and a separate list of opacity
 * stops, both with locations in 0..4096 and a midpoint per segment.
 */

function GRDReader(buffer) {
	this.view = new DataView(buffer);
	this.pos = 0;
}
GRDReader.prototype = {
	get left() { return this.view.byteLength - this.pos; },
	u8() { return this.view.getUint8(this.pos++); },
	u16() { const v = this.view.getUint16(this.pos); this.pos += 2; return v; },
	u32() { const v = this.view.getUint32(this.pos); this.pos += 4; return v; },
	i32() { const v = this.view.getInt32(this.pos); this.pos += 4; return v; },
	f64() { const v = this.view.getFloat64(this.pos); this.pos += 8; return v; },
	skip(n) { this.pos += n; },
	ascii(n) {
		let s = '';
		for (let i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint8(this.pos + i));
		this.pos += n;
		return s;
	},
	/** Photoshop key: a length, or 0 meaning a four character code follows. */
	key() {
		const len = this.u32();
		return this.ascii(len === 0 ? 4 : len);
	},
	/** UTF-16BE, length in characters and including the trailing null. */
	text() {
		const len = this.u32();
		let s = '';
		for (let i = 0; i < len; i++) {
			const c = this.u16();
			if (c) s += String.fromCharCode(c);
		}
		return s;
	},
	descriptor() {
		const name = this.text();
		const class_id = this.key();
		const count = this.u32();
		const items = {};
		for (let i = 0; i < count; i++) {
			const key = this.key();
			items[key] = this.value(this.ascii(4));
		}
		return { name: name, class_id: class_id, items: items };
	},
	value(type) {
		switch (type) {
			case 'Objc': case 'GlbO': return this.descriptor();
			case 'VlLs': {
				const count = this.u32();
				const list = [];
				for (let i = 0; i < count; i++) list.push(this.value(this.ascii(4)));
				return list;
			}
			case 'doub': return this.f64();
			case 'UntF': return { unit: this.ascii(4), value: this.f64() };
			case 'TEXT': return this.text();
			case 'enum': return { enum_type: this.key(), value: this.key() };
			case 'long': return this.i32();
			case 'bool': return !!this.u8();
			case 'comp': this.skip(8); return null;
			case 'type': case 'GlbC': return { name: this.text(), class_id: this.key() };
			case 'tdta': case 'alis': { const len = this.u32(); this.skip(len); return null; }
			default: throw new Error('Unsupported .grd value type "' + type + '"');
		}
	}
};

function hsvToRGB(h, s, v) {
	h = ((h % 360) + 360) % 360 / 60;
	s = clamp(s, 0, 1);
	v = clamp(v, 0, 1) * 255;
	const i = Math.floor(h), f = h - i;
	const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
	switch (i % 6) {
		case 0: return [v, t, p];
		case 1: return [q, v, p];
		case 2: return [p, v, t];
		case 3: return [p, q, v];
		case 4: return [t, p, v];
		default: return [v, p, q];
	}
}

function labToRGB(L, a, b) {
	const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
	const f = t => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
	const x = f(fx) * 0.95047, y = f(fy), z = f(fz) * 1.08883;
	return [
		linearToSrgbByte(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
		linearToSrgbByte(-0.9692660 * x + 1.8760108 * y + 0.0415560 * z),
		linearToSrgbByte(0.0556434 * x - 0.2040259 * y + 1.0572252 * z)
	];
}

function grdColor(descriptor) {
	if (!descriptor || !descriptor.items) return [128, 128, 128];
	const it = descriptor.items;
	const n = key => {
		const v = it[key];
		return typeof v === 'object' && v ? Number(v.value) || 0 : Number(v) || 0;
	};
	switch (descriptor.class_id) {
		case 'RGBC': return [n('Rd  '), n('Grn '), n('Bl  ')];
		case 'HSBC': return hsvToRGB(n('H   '), n('Strt') / 100, n('Brgh') / 100);
		case 'CMYC': {
			const c = n('Cyn ') / 100, m = n('Mgnt') / 100, y = n('Ylw ') / 100, k = n('Blck') / 100;
			return [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)];
		}
		case 'GRYC': { const g = 255 * (1 - clamp(n('Gry '), 0, 100) / 100); return [g, g, g]; }
		case 'LbCl': return labToRGB(n('Lmnc'), n('A   '), n('B   '));
		default: return [128, 128, 128];
	}
}

/** Piecewise interpolation with Photoshop's per-segment midpoint. */
function evalGRDStops(stops, t, lerp) {
	if (!stops.length) return null;
	if (t <= stops[0].p) return stops[0].v;
	const last = stops[stops.length - 1];
	if (t >= last.p) return last.v;

	let i = 0;
	for (let k = 0; k < stops.length - 1; k++) if (stops[k].p <= t) i = k;
	const a = stops[i], b = stops[i + 1];
	const span = b.p - a.p;
	let f = span > 0 ? (t - a.p) / span : 0;
	const mid = clamp(a.mid === undefined ? 0.5 : a.mid, 0.01, 0.99);
	f = f <= mid ? 0.5 * (f / mid) : 0.5 + 0.5 * ((f - mid) / (1 - mid));
	return lerp(a.v, b.v, f);
}

function grdStopList(list, read_value) {
	return (list || []).map(entry => ({
		p: clamp((Number(entry.items && entry.items['Lctn']) || 0) / 4096, 0, 1),
		mid: clamp((entry.items && entry.items['Mdpn'] !== undefined ? Number(entry.items['Mdpn']) : 50) / 100, 0.01, 0.99),
		v: read_value(entry)
	})).sort((a, b) => a.p - b.p);
}

/** Parse a .grd file into gradients with an exact 256 entry LUT each. */
function parseGRD(buffer) {
	const reader = new GRDReader(buffer);
	if (reader.ascii(4) !== '8BGR') throw new Error('Not a Photoshop gradient file');
	const version = reader.u16();
	if (version !== 5) throw new Error('Only version 5 .grd files are supported (this one is version ' + version + ')');
	reader.u32(); // descriptor version, always 16

	const root = reader.descriptor();
	const list = root.items['GrdL'];
	if (!Array.isArray(list)) throw new Error('No gradient list in this file');

	const gradients = [];
	let skipped = 0;

	list.forEach(entry => {
		const grad = entry && entry.items && entry.items['Grad'];
		if (!grad || !grad.items) { skipped++; return; }
		const form = grad.items['GrdF'];
		if (form && form.value === 'ClNs') { skipped++; return; }   // noise gradients

		const colors = grdStopList(grad.items['Clrs'], e => grdColor(e.items && e.items['Clr ']));
		if (!colors.length) { skipped++; return; }
		const alphas = grdStopList(grad.items['Trns'], e => {
			const o = e.items && e.items['Opct'];
			const pct = typeof o === 'object' && o ? Number(o.value) : Number(o);
			return Number.isFinite(pct) ? clamp(pct, 0, 100) * 2.55 : 255;
		});

		const lerp_rgb = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
		const lerp_num = (a, b, f) => a + (b - a) * f;

		const lut = new Uint8ClampedArray(GW * 4);
		for (let x = 0; x < GW; x++) {
			const t = x / (GW - 1);
			const rgb = evalGRDStops(colors, t, lerp_rgb) || [0, 0, 0];
			const alpha = alphas.length ? evalGRDStops(alphas, t, lerp_num) : 255;
			const i = x * 4;
			lut[i] = rgb[0]; lut[i + 1] = rgb[1]; lut[i + 2] = rgb[2]; lut[i + 3] = alpha;
		}

		gradients.push({
			name: (grad.items['Nm  '] || entry.items['Nm  '] || 'Gradient').toString().trim() || 'Gradient',
			lut: lut
		});
	});

	return { gradients: gradients, skipped: skipped };
}

function toArrayBuffer(content) {
	if (!content) return null;
	if (content instanceof ArrayBuffer) return content;
	if (ArrayBuffer.isView(content)) {
		return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
	}
	if (typeof content === 'string') {
		// binary string fallback
		const bytes = new Uint8Array(content.length);
		for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 255;
		return bytes.buffer;
	}
	return null;
}

/** Fit an editable stop list to an arbitrary LUT (greedy max-error split). */
function stopsFromLUT(lut, max_stops, tolerance) {
	max_stops = max_stops || 24;
	tolerance = tolerance === undefined ? 5 : tolerance;
	const idx = [0, GW - 1];
	while (idx.length < max_stops) {
		let worst = -1, worst_x = -1;
		for (let k = 0; k < idx.length - 1; k++) {
			const a = idx[k], b = idx[k + 1];
			for (let x = a + 1; x < b; x++) {
				const f = (x - a) / (b - a);
				let err = 0;
				for (let c = 0; c < 4; c++) {
					const approx = lut[a * 4 + c] + (lut[b * 4 + c] - lut[a * 4 + c]) * f;
					err = Math.max(err, Math.abs(approx - lut[x * 4 + c]));
				}
				if (err > worst) { worst = err; worst_x = x; }
			}
		}
		if (worst < tolerance || worst_x < 0) break;
		idx.push(worst_x);
		idx.sort((a, b) => a - b);
	}
	return idx.map(x => ({
		p: Math.round((x / (GW - 1)) * 1000) / 1000,
		c: rgbToHex(lut[x * 4], lut[x * 4 + 1], lut[x * 4 + 2]),
		a: lut[x * 4 + 3]
	}));
}

/* ============================== presets ============================== */

function preset(name, colors, interpolation, space) {
	// Hard step ramps get one equal band per colour, blended ramps span 0..1.
	const step = interpolation === 'step';
	const divisor = step ? colors.length : Math.max(1, colors.length - 1);
	return {
		id: 'builtin_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
		name: name,
		builtin: true,
		type: 'stops',
		interpolation: interpolation || 'linear',
		space: space || 'srgb',
		stops: colors.map((c, i) => ({ p: Math.round((i / divisor) * 1000) / 1000, c: c, a: 255 }))
	};
}

const BUILTINS = [
	preset('Grayscale', ['#000000', '#ffffff']),
	preset('Soft Shade', ['#241a2e', '#5a4a6a', '#a294ad', '#e8e2ee', '#ffffff'], 'linear', 'oklab'),
	preset('Fire', ['#05010a', '#4a0a17', '#b52d10', '#f07a12', '#ffd35c', '#fffbe0']),
	preset('Ice', ['#04101f', '#16466e', '#3f8ec4', '#a8dcf5', '#ffffff']),
	preset('Toxic', ['#0a1400', '#234d0a', '#5da31a', '#a8e02b', '#eaff9b']),
	preset('Sunset', ['#1a0630', '#6b1957', '#c53a5b', '#f4763f', '#ffce6b'], 'linear', 'oklab'),
	preset('Copper', ['#150a05', '#5a2d13', '#a85f2b', '#dfa15c', '#ffe3b0']),
	preset('Cool Metal', ['#0b0e14', '#2c3444', '#5d6b80', '#9fb0c4', '#e8f1ff']),
	preset('Desert Stone', ['#221a12', '#55432c', '#8b7350', '#bfa47a', '#eddcbc']),
	preset('Purple Haze', ['#10021f', '#3b1064', '#7a2fb0', '#c07be8', '#f4dcff'], 'linear', 'oklab'),
	preset('Viridis', ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'], 'linear', 'oklab'),
	preset('Foliage', ['#0d1a0c', '#20401b', '#3c6b28', '#6ba03a', '#a8c85a', '#dff0a8']),
	preset('Skin Tone', ['#2b1310', '#6b2f22', '#a85c43', '#d8906d', '#f2c3a1', '#ffeadb'], 'linear', 'oklab'),
	preset('Game Boy', ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'], 'step'),
	preset('Retro 4 Tone', ['#1b1226', '#6e2b4b', '#d1633f', '#f7e3a1'], 'step'),
	preset('Blueprint', ['#04121f', '#0b3a63', '#1b6ea8', '#63b3e0', '#ffffff'])
];

/* ============================== library ============================== */

function loadLibrary() {
	let list = [];
	try {
		const raw = localStorage.getItem(LIB_KEY);
		if (raw) list = JSON.parse(raw);
	} catch (err) { console.warn('[Gradient Map Layer] Could not read library', err); }
	if (!Array.isArray(list)) list = [];
	return list.filter(g => g && typeof g === 'object').map(sanitizeGradient);
}

function saveLibrary(list) {
	try {
		localStorage.setItem(LIB_KEY, JSON.stringify(list));
	} catch (err) {
		console.error('[Gradient Map Layer] Could not save library', err);
		Blockbench.showQuickMessage('Could not save the gradient library', 2500);
	}
}

/* ------------------------------ groups ------------------------------ */
/*
 * Gradients carry a group id. Alongside the user's own groups there are three
 * fixed sections (the presets, anything ungrouped, and gradients recovered
 * from a layer) whose collapsed / hidden flags live in the same record.
 */

const PRESETS_SECTION = '__presets__';
const UNGROUPED_SECTION = '__ungrouped__';
const ORPHAN_SECTION = '__orphans__';
const FIXED_SECTIONS = [PRESETS_SECTION, UNGROUPED_SECTION, ORPHAN_SECTION];

function emptyGroupRecord() {
	const fixed = {};
	FIXED_SECTIONS.forEach(id => { fixed[id] = { collapsed: false, hidden: false }; });
	return { groups: [], fixed: fixed };
}

function loadGroups() {
	const record = emptyGroupRecord();
	try {
		const raw = localStorage.getItem(GROUP_KEY);
		const data = raw ? JSON.parse(raw) : null;
		const list = Array.isArray(data) ? data : (data && data.groups);
		if (Array.isArray(list)) {
			record.groups = list
				.filter(g => g && typeof g === 'object' && g.id)
				.map(g => ({
					id: String(g.id),
					name: String(g.name || 'Group').slice(0, 60),
					collapsed: !!g.collapsed,
					hidden: !!g.hidden
				}));
		}
		if (data && data.fixed && typeof data.fixed === 'object') {
			FIXED_SECTIONS.forEach(id => {
				const f = data.fixed[id];
				if (f && typeof f === 'object') {
					record.fixed[id] = { collapsed: !!f.collapsed, hidden: !!f.hidden };
				}
			});
		}
	} catch (err) { console.warn('[Gradient Map Layer] Could not read groups', err); }
	return record;
}

function saveGroups(record) {
	try {
		localStorage.setItem(GROUP_KEY, JSON.stringify({
			groups: record.groups.map(g => ({ id: g.id, name: g.name, collapsed: !!g.collapsed, hidden: !!g.hidden })),
			fixed: record.fixed
		}));
	} catch (err) {
		console.error('[Gradient Map Layer] Could not save groups', err);
	}
}

function sanitizeGradient(g) {
	const out = {
		id: g.id || uid(),
		name: String(g.name || 'Gradient').slice(0, 60),
		builtin: false,
		group: g.group === null || g.group === undefined ? null : String(g.group),
		type: g.type === 'raw' ? 'raw' : 'stops',
		interpolation: ['linear', 'smooth', 'step'].includes(g.interpolation) ? g.interpolation : 'linear',
		space: g.space === 'oklab' ? 'oklab' : 'srgb'
	};
	if (out.type === 'raw') {
		out.lut = String(g.lut || '');
		if (base64ToBytes(out.lut).length !== GW * 4) {
			out.type = 'stops';
			delete out.lut;
		}
	}
	if (out.type === 'stops') {
		const stops = Array.isArray(g.stops) ? g.stops : [];
		out.stops = stops.map(s => ({
			p: clamp(Number(s.p) || 0, 0, 1),
			c: /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(s.c)) ? (String(s.c)[0] === '#' ? String(s.c) : '#' + s.c) : '#000000',
			a: clamp(s.a === undefined ? 255 : Math.round(Number(s.a) || 0), 0, 255)
		}));
		if (out.stops.length < 2) out.stops = [{ p: 0, c: '#000000', a: 255 }, { p: 1, c: '#ffffff', a: 255 }];
	}
	return out;
}

function cloneGradient(g, name) {
	const copy = JSON.parse(JSON.stringify(g));
	copy.id = uid();
	copy.builtin = false;
	if (name) copy.name = name;
	return copy;
}

const preview_cache = new Map();
function previewURL(gradient) {
	const key = gradient.id + ':' + (gradient._rev || 0);
	if (preview_cache.has(key)) return preview_cache.get(key);
	const url = lutToCanvas(getLUT(gradient)).toDataURL('image/png');
	if (preview_cache.size > 200) preview_cache.clear();
	preview_cache.set(key, url);
	return url;
}

function bumpPreview(gradient) {
	gradient._rev = (gradient._rev || 0) + 1;
}

/* ========================= image processing ========================= */

const BAYER8 = [
	0, 32, 8, 40, 2, 34, 10, 42,
	48, 16, 56, 24, 50, 18, 58, 26,
	12, 44, 4, 36, 14, 46, 6, 38,
	60, 28, 52, 20, 62, 30, 54, 22,
	3, 35, 11, 43, 1, 33, 9, 41,
	51, 19, 59, 27, 49, 17, 57, 25,
	15, 47, 7, 39, 13, 45, 5, 37,
	63, 31, 55, 23, 61, 29, 53, 21
].map(v => v / 64 - 0.5);

const VALUE_MODES = [
	{ id: 'luminance', name: 'Luminance (Rec. 709)' },
	{ id: 'luma', name: 'Luma (Rec. 601)' },
	{ id: 'linear', name: 'Linear light luminance' },
	{ id: 'average', name: 'Average RGB' },
	{ id: 'lightness', name: 'Lightness (HSL)' },
	{ id: 'max', name: 'Max channel (HSV value)' },
	{ id: 'min', name: 'Min channel' },
	{ id: 'red', name: 'Red channel' },
	{ id: 'green', name: 'Green channel' },
	{ id: 'blue', name: 'Blue channel' },
	{ id: 'alpha', name: 'Alpha channel' }
];

function valueFunction(mode) {
	switch (mode) {
		case 'luma': return (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
		case 'linear': return (r, g, b) => 0.2126 * SRGB_TO_LINEAR[r] + 0.7152 * SRGB_TO_LINEAR[g] + 0.0722 * SRGB_TO_LINEAR[b];
		case 'average': return (r, g, b) => (r + g + b) / 765;
		case 'lightness': return (r, g, b) => (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
		case 'max': return (r, g, b) => Math.max(r, g, b) / 255;
		case 'min': return (r, g, b) => Math.min(r, g, b) / 255;
		case 'red': return (r) => r / 255;
		case 'green': return (r, g) => g / 255;
		case 'blue': return (r, g, b) => b / 255;
		case 'alpha': return (r, g, b, a) => a / 255;
		default: return (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	}
}

/**
 * Map an ImageData through a gradient LUT.
 * mask: optional (x, y) => truthy, in source-local pixel coordinates.
 * Returns a new ImageData.
 */
function mapImageData(source, lut, o, mask, origin) {
	const w = source.width, h = source.height;
	const src = source.data;
	// Where this tile sits in the full image, so a partial re-render keeps the
	// dither pattern and the selection mask aligned with a full one.
	const ox = origin ? (origin[0] | 0) : 0;
	const oy = origin ? (origin[1] | 0) : 0;
	const out = new ImageData(w, h);
	const dst = out.data;

	const getValue = valueFunction(o.value_mode);
	const black = clamp(num(o.black, 0), 0, 255) / 255;
	const white = clamp(num(o.white, 255), 0, 255) / 255;
	const span = Math.abs(white - black) < 1e-6 ? 1e-6 : (white - black);
	const mid = clamp(num(o.midpoint, 0.5), 0.01, 0.99);
	const gamma = Math.log(0.5) / Math.log(mid);
	const use_gamma = Math.abs(gamma - 1) > 0.001;
	const steps_raw = num(o.steps, 0);
	const steps = steps_raw > 1 ? Math.round(steps_raw) : 0;
	const dither = clamp(num(o.dither, 0), 0, 100) / 100 * 0.08;
	const strength = clamp(num(o.strength, 100), 0, 100) / 100;
	// A generated layer leaves unselected pixels empty; an in-place edit keeps them.
	const keep_unmasked = o.output !== 'new_layer' && o.output !== 'update_layer';

	for (let y = 0; y < h; y++) {
		const bayer_row = ((y + oy) & 7) * 8;
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const a = src[i + 3];

			if (a === 0 || (mask && !mask(x + ox, y + oy))) {
				if (keep_unmasked) {
					dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = a;
				}
				continue;
			}

			const r = src[i], g = src[i + 1], b = src[i + 2];
			let v = getValue(r, g, b, a);
			if (dither) v += BAYER8[bayer_row + ((x + ox) & 7)] * dither;
			v = (v - black) / span;
			v = v < 0 ? 0 : (v > 1 ? 1 : v);
			if (use_gamma) v = Math.pow(v, gamma);
			if (o.invert) v = 1 - v;
			if (steps) v = Math.round(v * (steps - 1)) / (steps - 1);

			const li = (v < 0 ? 0 : (v > 1 ? 255 : Math.round(v * 255))) * 4;
			let nr = lut[li], ng = lut[li + 1], nb = lut[li + 2];
			let na = o.use_gradient_alpha ? a * (lut[li + 3] / 255) : a;

			if (strength < 1) {
				nr = r + (nr - r) * strength;
				ng = g + (ng - g) * strength;
				nb = b + (nb - b) * strength;
				na = a + (na - a) * strength;
			}

			dst[i] = nr; dst[i + 1] = ng; dst[i + 2] = nb; dst[i + 3] = na;
		}
	}
	return out;
}

/* ====================== Blockbench texture helpers ====================== */

function allTextures() {
	return (typeof Texture !== 'undefined' && Texture.all) ? Texture.all : [];
}

function currentTexture() {
	try {
		if (typeof Texture.getDefault === 'function') {
			const t = Texture.getDefault();
			if (t) return t;
		}
	} catch (err) { /* ignore */ }
	return Texture.selected || allTextures()[0] || null;
}

function activeLayer(texture) {
	if (!texture || !texture.layers_enabled) return null;
	try {
		if (typeof texture.getActiveLayer === 'function') {
			const l = texture.getActiveLayer();
			if (l) return l;
		}
	} catch (err) { /* ignore */ }
	if (texture.selected_layer) return texture.selected_layer;
	if (texture.layers && texture.layers.length) return texture.layers.find(l => l.selected) || texture.layers[texture.layers.length - 1];
	return null;
}

function hasCustomSelection(texture) {
	try {
		return !!(texture && texture.selection && texture.selection.is_custom);
	} catch (err) { return false; }
}

/** Build a mask in source-local coordinates, or null. */
function buildMask(texture, layer) {
	if (!hasCustomSelection(texture)) return null;
	try {
		const selection = texture.selection;
		const ox = layer && layer.offset ? (layer.offset[0] | 0) : 0;
		const oy = layer && layer.offset ? (layer.offset[1] | 0) : 0;
		// Selections are stored in texture space, layers are painted in their own.
		const test = typeof selection.allow === 'function'
			? (x, y) => !!selection.allow(x + ox, y + oy)
			: (typeof selection.get === 'function' ? (x, y) => !!selection.get(x + ox, y + oy) : null);
		if (!test) return null;
		test(0, 0);
		return test;
	} catch (err) {
		console.warn('[Gradient Map Layer] Selection could not be read, mapping everything.', err);
		return null;
	}
}

function sourceFromLayer(layer) {
	if (!layer || !layer.canvas || !layer.canvas.width || !layer.canvas.height) return null;
	return {
		layer: layer,
		canvas: layer.canvas,
		ctx: layer.ctx || ctxOf(layer.canvas),
		width: layer.canvas.width,
		height: layer.canvas.height,
		offset: [layer.offset ? layer.offset[0] : 0, layer.offset ? layer.offset[1] : 0]
	};
}

function flattenedSource(texture) {
	let canvas = texture.canvas;
	if (!canvas || !canvas.width || !canvas.height) {
		const w = texture.width || (texture.img && texture.img.naturalWidth) || 16;
		const h = texture.height || (texture.img && texture.img.naturalHeight) || 16;
		canvas = newCanvas(w, h);
		const ctx = ctxOf(canvas);
		if (texture.img) {
			try { ctx.drawImage(texture.img, 0, 0); } catch (err) { /* ignore */ }
		}
	}
	return {
		layer: null,
		canvas: canvas,
		ctx: ctxOf(canvas),
		width: canvas.width,
		height: canvas.height,
		offset: [0, 0]
	};
}

/** Source pixels for the given options. */
function getSource(texture, source_mode) {
	if (!texture) return null;
	if (source_mode === 'layer') {
		const source = sourceFromLayer(activeLayer(texture));
		if (source) return source;
	}
	return flattenedSource(texture);
}

/**
 * Flatten everything except one layer, so re-rendering a gradient map layer
 * never reads its own output back in.
 */
function compositeWithout(texture, skip_layer) {
	const was_visible = skip_layer.visible;
	let copy = null;
	try {
		skip_layer.visible = false;
		if (typeof texture.updateLayerChanges === 'function') texture.updateLayerChanges(true);
		const src = texture.canvas;
		if (src && src.width && src.height) {
			copy = newCanvas(src.width, src.height);
			ctxOf(copy).drawImage(src, 0, 0);
		}
	} catch (err) {
		console.warn('[Gradient Map Layer] Could not flatten below the layer', err);
		copy = null;
	} finally {
		skip_layer.visible = was_visible;
		try {
			if (typeof texture.updateLayerChanges === 'function') texture.updateLayerChanges(true);
		} catch (err) { /* ignore */ }
	}
	if (!copy) return null;
	return { layer: null, canvas: copy, ctx: ctxOf(copy), width: copy.width, height: copy.height, offset: [0, 0] };
}

/** The layer a gradient map layer was generated from. */
function findSourceLayer(texture, target, meta) {
	if (!texture || !Array.isArray(texture.layers)) return null;
	if (meta && meta.source_layer) {
		const stored = texture.layers.find(l => l.uuid === meta.source_layer);
		if (stored && stored !== target) return stored;
	}
	const index = texture.layers.indexOf(target);
	const below = index > 0 ? texture.layers[index - 1] : null;
	return below && below !== target ? below : null;
}

/**
 * Resolve the pixels to map, honouring "update this layer" so that re-editing
 * reads the original source instead of the already mapped result.
 */
function resolveSource(texture, options) {
	if (!texture) return null;
	if (options.output === 'update_layer' && texture.layers_enabled && Array.isArray(texture.layers)) {
		const target = texture.layers.find(l => l.uuid === options.target_layer);
		if (target) {
			if (options.source === 'layer') {
				const source = sourceFromLayer(findSourceLayer(texture, target, recallLayerSettings(target)));
				if (source) return source;
			}
			const flattened = compositeWithout(texture, target);
			if (flattened) return flattened;
		}
	}
	return getSource(texture, texture.layers_enabled ? options.source : 'texture');
}

/* --------- remembering how a gradient map layer was generated --------- */

const REGISTRY_KEY = 'gradient_map_layer.layers';
const REGISTRY_LIMIT = 300;

function loadRegistry() {
	try {
		const raw = localStorage.getItem(REGISTRY_KEY);
		const data = raw ? JSON.parse(raw) : null;
		return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
	} catch (err) { return {}; }
}

function rememberLayerSettings(layer, data) {
	if (!layer) return;
	layer[DATA_KEY] = data;
	if (!layer.uuid) return;
	try {
		const registry = loadRegistry();
		registry[layer.uuid] = Object.assign({ saved_at: Date.now() }, data);
		const keys = Object.keys(registry);
		if (keys.length > REGISTRY_LIMIT) {
			keys.sort((a, b) => (registry[a].saved_at || 0) - (registry[b].saved_at || 0))
				.slice(0, keys.length - REGISTRY_LIMIT)
				.forEach(key => delete registry[key]);
		}
		localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
	} catch (err) { /* the in-memory copy still works for this session */ }
}

/** Settings a gradient map layer was made with, or null for a normal layer. */
function recallLayerSettings(layer) {
	if (!layer) return null;
	if (layer[DATA_KEY]) return layer[DATA_KEY];
	if (!layer.uuid) return null;
	const data = loadRegistry()[layer.uuid];
	if (!data) return null;
	layer[DATA_KEY] = data;
	return data;
}

function refreshTexture(texture) {
	try {
		// For layered textures this recomposites and pushes the result to the
		// material, which is what makes the model update.
		if (typeof texture.updateChangesAfterEdit === 'function') texture.updateChangesAfterEdit();
		else if (typeof texture.updateLayerChanges === 'function') texture.updateLayerChanges(true);
		else if (typeof texture.updateSource === 'function' && texture.canvas) texture.updateSource(texture.canvas.toDataURL());
	} catch (err) { console.warn('[Gradient Map Layer]', err); }
	try {
		if (typeof Interface !== 'undefined' && Interface.Panels && Interface.Panels.layers && Interface.Panels.layers.inside_vue) {
			Interface.Panels.layers.inside_vue.$forceUpdate();
		}
	} catch (err) { /* ignore */ }
}

/* ============================== apply ============================== */

function applyGradientMap(gradient, options) {
	const texture = options.texture || currentTexture();
	if (!texture) {
		Blockbench.showQuickMessage('No texture to apply the gradient map to', 2000);
		return false;
	}
	if (!gradient) {
		Blockbench.showQuickMessage('Select a gradient map first', 2000);
		return false;
	}

	const lut = getLUT(gradient);
	let output = options.output;

	if (output === 'new_texture') {
		const source = getSource(texture, options.source);
		if (!source || !source.width) {
			Blockbench.showQuickMessage('Nothing to map', 2000);
			return false;
		}
		const src_data = source.ctx.getImageData(0, 0, source.width, source.height);
		const mapped = mapImageData(src_data, lut, Object.assign({}, options, { output: 'replace' }), null);
		const canvas = newCanvas(source.width, source.height);
		ctxOf(canvas).putImageData(mapped, 0, 0);

		let new_texture = null;
		Undo.initEdit({ textures: [] });
		try {
			new_texture = new Texture({ name: texture.name.replace(/\.png$/i, '') + '_' + safeName(gradient.name) })
				.fromDataURL(canvas.toDataURL('image/png'))
				.add(false);
		} catch (err) {
			Undo.cancelEdit();
			reportError(err);
			return false;
		}
		Undo.finishEdit('Create gradient mapped texture', { textures: [new_texture] });
		Blockbench.showQuickMessage('Created texture "' + new_texture.name + '"', 2000);
		last_run = { gradient_id: gradient.id, options: Object.assign({}, options, { texture: null }) };
		return true;
	}

	Undo.initEdit({ textures: [texture], bitmap: true });
	applying = true;
	try {
		// Layers are required for the layer outputs.
		if ((output === 'new_layer' || output === 'update_layer') && !texture.layers_enabled) {
			if (typeof texture.activateLayers === 'function') texture.activateLayers(false);
		}
		if (output === 'new_layer' && (!Array.isArray(texture.layers) || typeof TextureLayer !== 'function')) {
			output = 'replace';
			options = Object.assign({}, options, { output: 'replace' });
			Blockbench.showQuickMessage('This texture cannot hold layers, replacing its pixels instead', 2500);
		}

		let target = null;
		if (output === 'update_layer') {
			target = Array.isArray(texture.layers) ? texture.layers.find(l => l.uuid === options.target_layer) : null;
			if (!target) {
				output = 'new_layer';
				options = Object.assign({}, options, { output: 'new_layer' });
				Blockbench.showQuickMessage('That gradient map layer is gone, adding a new one', 2500);
			}
		}

		const source = resolveSource(texture, options);
		if (!source || !source.width || !source.height) throw new Error('The source image is empty');
		if (output === 'update_layer' && options.source === 'layer' && !source.layer) {
			throw new Error('The layer this was generated from no longer exists');
		}

		const mask = options.limit_to_selection ? buildMask(texture, source.layer) : null;
		const src_data = source.ctx.getImageData(0, 0, source.width, source.height);
		const mapped = mapImageData(src_data, lut, options, mask);

		if (output === 'new_layer' || output === 'update_layer') {
			const layer = target || new TextureLayer({
				name: options.layer_name || ('Gradient Map - ' + gradient.name)
			}, texture);

			writeMappedIntoLayer(layer, source, mapped);
			sync_cache.delete(layer.uuid);

			if (!target) {
				const index = source.layer ? texture.layers.indexOf(source.layer) + 1 : texture.layers.length;
				texture.layers.splice(index < 0 ? texture.layers.length : index, 0, layer);
				try {
					if (typeof layer.select === 'function') layer.select();
					else texture.selected_layer = layer;
				} catch (err) { texture.selected_layer = layer; }
			} else {
				const previous = recallLayerSettings(target) || {};
				const previous_auto = 'Gradient Map - ' + ((previous.gradient && previous.gradient.name) || '');
				const wanted = options.layer_name || ('Gradient Map - ' + gradient.name);
				// Keep following the gradient name unless the layer was renamed by hand.
				layer.name = (wanted === previous_auto && layer.name === previous_auto)
					? 'Gradient Map - ' + gradient.name
					: wanted;
			}

			rememberLayerSettings(layer, {
				gradient_id: gradient.id,
				gradient: JSON.parse(JSON.stringify(gradient)),
				source_layer: source.layer ? source.layer.uuid : (target ? (recallLayerSettings(target) || {}).source_layer || null : null),
				options: Object.assign({}, options, {
						texture: null,
						target_layer: null,
						output: 'new_layer',
						// A layer masked to a selection cannot follow later edits without
						// silently spreading past that selection, so it stops tracking.
						auto_update: mask ? false : options.auto_update !== false
					})
			});
		} else {
			const target_ctx = source.ctx;
			target_ctx.clearRect(0, 0, source.width, source.height);
			target_ctx.putImageData(mapped, 0, 0);
			// Older / unlayered textures may not be backed by texture.canvas.
			if (!source.layer && texture.canvas !== source.canvas && typeof texture.updateSource === 'function') {
				texture.updateSource(source.canvas.toDataURL('image/png'));
			}
		}

		refreshTexture(texture);
	} catch (err) {
		applying = false;
		try { Undo.cancelEdit(); } catch (e2) { /* ignore */ }
		reportError(err);
		return false;
	}
	applying = false;
	Undo.finishEdit('Apply gradient map');

	last_run = { gradient_id: gradient.id, options: Object.assign({}, options, { texture: null }) };
	Blockbench.showQuickMessage('Applied gradient map "' + gradient.name + '"', 1600);
	return true;
}

/** Draw a mapped result into a layer, resizing it to the source if needed. */
function writeMappedIntoLayer(layer, source, mapped) {
	if (layer.canvas.width !== source.width || layer.canvas.height !== source.height) {
		if (typeof layer.setSize === 'function') layer.setSize(source.width, source.height);
		else { layer.canvas.width = source.width; layer.canvas.height = source.height; }
	}
	layer.offset = [source.offset[0], source.offset[1]];
	const ctx = layer.ctx || ctxOf(layer.canvas);
	ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
	ctx.putImageData(mapped, 0, 0);
}

/** The gradient a layer was generated from, falling back to its saved copy. */
function resolveGradient(meta) {
	if (!meta) return null;
	const found = BUILTINS.concat(loadLibrary()).find(g => g.id === meta.gradient_id);
	if (found) return found;
	return meta.gradient ? sanitizeGradient(meta.gradient) : null;
}

/* ========================= keeping layers in sync ========================= */
/*
 * A gradient map layer behaves like an adjustment layer: when the greyscale
 * layer under it is painted on, it re-renders itself from the new pixels.
 */

/*
 * Last source pixels each generated layer was rendered from, so a repeat sync
 * only has to re-map the part of the image that actually changed. That is what
 * keeps this cheap enough to run on every brush dab.
 */
const sync_cache = new Map();
const SYNC_CACHE_LIMIT = 64;

/** Bounding box of the pixels that differ, or null when nothing changed. */
function dirtyRect(before, after, width, height) {
	let a, b;
	try {
		a = new Uint32Array(before.buffer, before.byteOffset, before.length >> 2);
		b = new Uint32Array(after.buffer, after.byteOffset, after.length >> 2);
	} catch (err) {
		return { x: 0, y: 0, w: width, h: height };
	}
	let top = -1, bottom = -1, left = width, right = -1;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		let row_left = -1, row_right = -1;
		for (let x = 0; x < width; x++) {
			if (a[row + x] !== b[row + x]) {
				if (row_left === -1) row_left = x;
				row_right = x;
			}
		}
		if (row_left !== -1) {
			if (top === -1) top = y;
			bottom = y;
			if (row_left < left) left = row_left;
			if (row_right > right) right = row_right;
		}
	}
	if (top === -1) return null;
	return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** Copy a rectangle out of an ImageData. */
function subImage(full, rect) {
	const out = new ImageData(rect.w, rect.h);
	const stride = rect.w * 4;
	for (let y = 0; y < rect.h; y++) {
		const start = ((y + rect.y) * full.width + rect.x) * 4;
		out.data.set(full.data.subarray(start, start + stride), y * stride);
	}
	return out;
}

/**
 * Re-render every generated layer of this texture from its source.
 * opts.refresh: pass false when the caller is about to recomposite anyway.
 */
function syncTextureGradientLayers(texture, opts) {
	opts = opts || {};
	if (syncing || applying || live.active) return false;
	if (!texture || !texture.layers_enabled || !Array.isArray(texture.layers)) return false;

	const skip = opts.skip || null;
	const targets = texture.layers.filter(layer => {
		if (skip && skip[layer.uuid]) {
			// Its pixels were just restored from an undo snapshot, so they win.
			sync_cache.delete(layer.uuid);
			return false;
		}
		const meta = recallLayerSettings(layer);
		return meta && !(meta.options && meta.options.auto_update === false);
	});
	if (!targets.length) return false;

	if (sync_cache.size > SYNC_CACHE_LIMIT) sync_cache.clear();

	let updated = 0;
	syncing = true;
	try {
		targets.forEach(target => {
			const meta = recallLayerSettings(target);
			const gradient = resolveGradient(meta);
			if (!gradient) return;

			const options = Object.assign({}, defaultOptions(), meta.options || {}, {
				output: 'update_layer',
				target_layer: target.uuid,
				texture_id: texture.uuid,
				limit_to_selection: false
			});

			// Only follow the layer it was actually generated from.
			if (options.source === 'layer') {
				const source_layer = meta.source_layer
					? texture.layers.find(l => l.uuid === meta.source_layer)
					: null;
				if (!source_layer || source_layer === target) return;
			}

			const source = resolveSource(texture, options);
			if (!source || !source.width || !source.height || source.layer === target) return;

			const source_key = source.layer ? source.layer.uuid : '__flattened__';
			const full = source.ctx.getImageData(0, 0, source.width, source.height);
			const cached = sync_cache.get(target.uuid);

			// A partial write is only safe when the layer already lines up.
			const aligned = cached
				&& cached.source === source_key
				&& cached.width === source.width && cached.height === source.height
				&& target.canvas.width === source.width && target.canvas.height === source.height
				&& (target.offset ? target.offset[0] : 0) === source.offset[0]
				&& (target.offset ? target.offset[1] : 0) === source.offset[1];

			let rect = null;
			if (aligned) {
				rect = dirtyRect(cached.data, full.data, source.width, source.height);
				if (rect === null) return;   // this layer is already up to date
			}

			const lut = getLUT(gradient);
			if (rect) {
				const mapped = mapImageData(subImage(full, rect), lut, options, null, [rect.x, rect.y]);
				(target.ctx || ctxOf(target.canvas)).putImageData(mapped, rect.x, rect.y);
			} else {
				writeMappedIntoLayer(target, source, mapImageData(full, lut, options, null));
			}

			sync_cache.set(target.uuid, {
				source: source_key,
				width: source.width,
				height: source.height,
				data: new Uint8ClampedArray(full.data)
			});
			updated++;
		});
	} catch (err) {
		console.error('[Gradient Map Layer] Sync failed', err);
	} finally {
		syncing = false;
	}

	if (updated && opts.refresh !== false) refreshTexture(texture);
	return updated > 0;
}

/* ---- following a brush stroke as it happens ---- */

let last_sync_at = 0;
let last_sync_cost = 0;
let trailing_sync = null;

function nowMs() {
	try {
		if (typeof performance !== 'undefined' && performance.now) return performance.now();
	} catch (err) { /* ignore */ }
	return Date.now();
}

/* ============== protecting a generated layer from the brush ============== */
/*
 * A gradient map layer is generated output, so a stray brush stroke on it is
 * almost always a mistake - and while it is following its source, the stroke
 * would be overwritten anyway. Blockbench has no layer lock and its events
 * cannot be cancelled, so the stroke is undone from a snapshot taken when the
 * edit began, and the user is asked to confirm before the layer is unlocked.
 */

const paint_guard = {
	layer: null,
	texture: null,
	snapshot: null,
	prompted: false,
	blocked: false,   // a dab was actually taken back, so this edit is painting
	dialog: null
};

/** True while a generated layer has not been unlocked for hand painting. */
function isPaintProtected(layer) {
	if (!layer) return false;
	const meta = recallLayerSettings(layer);
	return !!(meta && meta.paint_allowed !== true);
}

function beginPaintGuard(layer) {
	if (paint_guard.dialog) return;
	if (!layer || !layer.canvas || !layer.canvas.width) return;
	paint_guard.layer = layer;
	paint_guard.texture = layer.texture || currentTexture();
	paint_guard.snapshot = copyCanvas(layer.canvas);
	paint_guard.prompted = false;
	paint_guard.blocked = false;
}

function endPaintGuard() {
	paint_guard.layer = null;
	paint_guard.texture = null;
	paint_guard.snapshot = null;
	paint_guard.prompted = false;
	paint_guard.blocked = false;
}

/** Put the guarded layer back to how it was before the stroke. */
function revertGuardedPaint() {
	const layer = paint_guard.layer;
	const snapshot = paint_guard.snapshot;
	if (!layer || !snapshot || !layer.canvas) return false;
	if (layer.canvas.width !== snapshot.width || layer.canvas.height !== snapshot.height) return false;
	try {
		const ctx = layer.ctx || ctxOf(layer.canvas);
		ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
		ctx.drawImage(snapshot, 0, 0);
		return true;
	} catch (err) {
		console.warn('[Gradient Map Layer] Could not undo the blocked stroke', err);
		return false;
	}
}

/** Unlock a generated layer for hand painting, for good. */
function allowPaintingOn(layer) {
	const meta = recallLayerSettings(layer);
	if (!meta) return;
	meta.paint_allowed = true;
	if (!meta.options) meta.options = {};
	// Otherwise the next stroke on its source would paint straight over them.
	meta.options.auto_update = false;
	rememberLayerSettings(layer, meta);
	sync_cache.delete(layer.uuid);
}

function askToPaintOnLayer(layer) {
	if (paint_guard.dialog || !layer) return;
	const name = layer.name || 'this layer';
	const dialog = new Dialog({
		id: 'gradient_map_layer_paint_warning',
		title: 'Painting on a gradient map layer',
		width: 520,
		buttons: ['Paint on it anyway', 'Cancel'],
		confirmIndex: 0,
		cancelIndex: 1,
		lines: [
			'<p style="margin: 0 0 8px 0;"><strong>' + escapeHTML(name) + '</strong> is a gradient map layer. ' +
			'Its pixels are generated from the layer it was made from, so painting here is usually a mistake ' +
			'&mdash; and while it follows its source, anything you paint is overwritten the next time that source changes.</p>' +
			'<p style="margin: 0 0 8px 0;">To recolour it, select it and reopen <em>Gradient Map Layer</em> instead. ' +
			'To shade on top, add a normal layer above it.</p>' +
			'<p style="margin: 0 0 4px 0;">If you really want to paint on it, this layer will stop following its ' +
			'source and will not be asked about again.</p>'
		],
		form: {
			understood: {
				type: 'checkbox',
				label: 'I understand this layer is generated and will stop updating',
				value: false
			}
		},
		onConfirm(form) {
			if (!form || !form.understood) {
				Blockbench.showQuickMessage('Tick the box first to paint on this layer', 2500);
				return false;   // keeps the dialog open
			}
			paint_guard.dialog = null;
			allowPaintingOn(layer);
			endPaintGuard();
			Blockbench.showQuickMessage('"' + name + '" can be painted on now', 2500);
		},
		onCancel() {
			paint_guard.dialog = null;
			endPaintGuard();
		}
	});
	paint_guard.dialog = dialog;
	dialog.show();
}

/** Fires when any edit begins, before a brush has drawn anything. */
function onInitEdit(data) {
	if (applying || syncing || live.active) return;
	try {
		const aspects = data && data.aspects;
		if (!aspects || !aspects.bitmap) return;   // painting always records bitmaps
		if (!Array.isArray(aspects.layers) || !aspects.layers.length) return;
		const layer = aspects.layers.find(entry => isPaintProtected(entry));
		if (layer) beginPaintGuard(layer);
	} catch (err) {
		console.warn('[Gradient Map Layer]', err);
	}
}

function escapeHTML(text) {
	return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Stop a generated layer from following its source, because it was painted on. */
function detachLayerFollow(layer) {
	const meta = recallLayerSettings(layer);
	if (!meta || !meta.options || meta.options.auto_update === false) return;
	meta.options.auto_update = false;
	rememberLayerSettings(layer, meta);
	Blockbench.showQuickMessage('"' + layer.name + '" was painted on, so it no longer follows its source', 3500);
}

/**
 * Which generated layers care about an edit to this canvas, and whether the
 * canvas is a generated layer itself.
 */
function classifyEdit(texture, canvas) {
	let relevant = false;
	let painted_target = null;
	texture.layers.forEach(layer => {
		const meta = recallLayerSettings(layer);
		if (!meta) return;
		if (canvas && layer.canvas === canvas) { painted_target = layer; return; }
		if (meta.options && meta.options.auto_update === false) return;
		if (!meta.options || meta.options.source !== 'layer') {
			relevant = true;   // reads the flattened texture, so any edit counts
			return;
		}
		if (meta.source_layer) {
			const source_layer = texture.layers.find(l => l.uuid === meta.source_layer);
			if (source_layer && canvas && source_layer.canvas === canvas) relevant = true;
		}
	});
	return { relevant: relevant, painted_target: painted_target };
}

function clearTrailingSync() {
	if (trailing_sync) { clearTimeout(trailing_sync); trailing_sync = null; }
}

/**
 * Runs on every brush dab. Blockbench recomposites straight after this event,
 * so writing the mapped pixels here shows them in the same frame.
 */
function onEditTexture(data) {
	if (syncing || applying || live.active) return;
	const texture = data && data.texture;
	if (!texture || !texture.layers_enabled || !Array.isArray(texture.layers)) return;

	// A stroke on a protected generated layer: take it back, and ask.
	if (data.canvas && paint_guard.layer && paint_guard.layer.canvas === data.canvas) {
		paint_guard.blocked = true;
		revertGuardedPaint();
		if (!paint_guard.prompted) {
			paint_guard.prompted = true;
			askToPaintOnLayer(paint_guard.layer);
		}
		return;
	}

	let info;
	try {
		info = classifyEdit(texture, data.canvas);
	} catch (err) {
		console.warn('[Gradient Map Layer]', err);
		return;
	}
	// Only reachable once a layer has been unlocked for hand painting.
	if (info.painted_target) detachLayerFollow(info.painted_target);
	if (!info.relevant) return;

	// Stay out of the way of the brush: if the last pass was expensive, wait
	// roughly that long again before the next one and let the timer catch up.
	const now = nowMs();
	if (now - last_sync_at < Math.min(150, last_sync_cost * 2)) {
		if (!trailing_sync) {
			trailing_sync = setTimeout(() => {
				trailing_sync = null;
				const started = nowMs();
				syncTextureGradientLayers(texture);
				last_sync_cost = nowMs() - started;
				last_sync_at = nowMs();
			}, 50);
		}
		return;
	}

	clearTrailingSync();
	const started = nowMs();
	syncTextureGradientLayers(texture, { refresh: false });
	last_sync_cost = nowMs() - started;
	last_sync_at = nowMs();
}

/*
 * Undo and redo.
 *
 * A brush stroke on a layered texture is recorded as
 * {layers: [active layer], bitmap: true} - only the layer being painted. A
 * generated layer is a different layer, so it is in neither snapshot: undo
 * reverts the greyscale underneath while the opaque mapped layer on top keeps
 * its post-stroke pixels, and nothing appears to happen. So after a restore,
 * re-derive every generated layer whose own pixels were not part of it.
 */
function restoredLayerIds(save) {
	if (!save || (!save.layers && !save.textures)) return null;
	const ids = {};
	if (save.layers) {
		for (const uuid in save.layers) ids[uuid] = true;
	}
	if (save.textures) {
		// A whole-texture copy carries a copy of every layer it had.
		for (const uuid in save.textures) {
			const copy = save.textures[uuid];
			if (copy && Array.isArray(copy.layers)) {
				copy.layers.forEach(layer => { if (layer && layer.uuid) ids[layer.uuid] = true; });
			}
		}
	}
	return ids;
}

function afterRestore(data, which) {
	if (syncing || applying || live.active) return;
	try {
		const entry = data && data.entry;
		const restored = restoredLayerIds(entry ? entry[which] : null);
		if (!restored) return;   // nothing bitmap related was restored
		clearTrailingSync();
		allTextures().forEach(texture => {
			if (texture && typeof texture === 'object') {
				syncTextureGradientLayers(texture, { skip: restored });
			}
		});
	} catch (err) {
		console.warn('[Gradient Map Layer] Could not sync after an undo', err);
	}
}

function onUndo(data) { afterRestore(data, 'before'); }
function onRedo(data) { afterRestore(data, 'post'); }

function onFinishEdit(data) {
	// Leave the guarded layer pristine, so the undo entry records no change.
	if (!applying && paint_guard.layer) {
		if (paint_guard.blocked && revertGuardedPaint() && paint_guard.texture) {
			refreshTexture(paint_guard.texture);
		}
		if (!paint_guard.dialog) endPaintGuard();
	}
	if (syncing || applying || live.active) return;
	try {
		const aspects = data && (data.aspects || (data.entry && data.entry.aspects));
		const textures = aspects && Array.isArray(aspects.textures) && aspects.textures.length
			? aspects.textures
			: allTextures();
		textures.forEach(texture => {
			if (texture && typeof texture === 'object') syncTextureGradientLayers(texture);
		});
	} catch (err) {
		console.warn('[Gradient Map Layer] Could not sync after an edit', err);
	}
}

/* ============================ live preview ============================ */
/*
 * The dialog previews straight onto the texture so the model updates as you
 * work. Nothing here touches the undo stack: the pristine pixels are kept
 * aside and put back before the real edit runs, or when the dialog closes.
 */

const live = {
	active: false,
	key: null,
	texture: null,
	source: null,
	target_canvas: null,
	created_layer: null,
	previous_selected: null,
	restore: null,
	saved_flag: undefined,
	timer: null,
	failed: false
};

function copyCanvas(canvas) {
	const copy = newCanvas(canvas.width, canvas.height);
	ctxOf(copy).drawImage(canvas, 0, 0);
	return copy;
}

function previewKey(options) {
	return [options.texture_id, options.output, options.source, options.target_layer].join('|');
}

function beginLivePreview(texture, options, key) {
	const source = resolveSource(texture, options);
	if (!source || !source.width || !source.height) return false;

	live.active = true;
	live.key = key;
	live.texture = texture;
	live.saved_flag = texture.saved;
	live.source = {
		data: source.ctx.getImageData(0, 0, source.width, source.height),
		width: source.width,
		height: source.height,
		offset: source.offset.slice(),
		layer: source.layer
	};

	const layered = texture.layers_enabled && Array.isArray(texture.layers);

	if (options.output === 'update_layer') {
		const target = layered ? texture.layers.find(l => l.uuid === options.target_layer) : null;
		if (!target) { endLivePreview(); return false; }
		live.restore = { layer: target, canvas: copyCanvas(target.canvas), offset: (target.offset || [0, 0]).slice() };
		live.target_canvas = target.canvas;
		live.target_layer = target;

	} else if (options.output === 'new_layer' && layered && typeof TextureLayer === 'function') {
		// A real temporary layer, so a pixel selection reads exactly as it will.
		const layer = new TextureLayer({ name: 'Gradient Map (preview)' }, texture);
		if (typeof layer.setSize === 'function') layer.setSize(source.width, source.height);
		else { layer.canvas.width = source.width; layer.canvas.height = source.height; }
		layer.offset = [source.offset[0], source.offset[1]];

		const index = source.layer ? texture.layers.indexOf(source.layer) + 1 : texture.layers.length;
		live.previous_selected = texture.selected_layer || null;
		texture.layers.splice(index < 0 ? texture.layers.length : index, 0, layer);
		live.created_layer = layer;
		live.target_canvas = layer.canvas;
		live.target_layer = layer;

	} else {
		// Replacing, or a texture with no layers: a mapped layer would cover the
		// same pixels anyway, so preview it in place and put it back afterwards.
		const canvas = source.layer ? source.layer.canvas : (texture.canvas || source.canvas);
		if (!canvas) { endLivePreview(); return false; }
		live.restore = source.layer
			? { layer: source.layer, canvas: copyCanvas(canvas), offset: (source.layer.offset || [0, 0]).slice() }
			: { flat_target: canvas, canvas: copyCanvas(canvas) };
		live.target_canvas = canvas;
		live.target_layer = source.layer || null;
	}
	return true;
}

function renderLivePreview(gradient, options) {
	if (!live.active || !live.target_canvas || !gradient) return;
	const source = live.source;
	const mask = options.limit_to_selection ? buildMask(live.texture, source.layer) : null;
	const mapped = mapImageData(source.data, getLUT(gradient), options, mask);

	if (live.target_layer) {
		writeMappedIntoLayer(live.target_layer, source, mapped);
		live.target_canvas = live.target_layer.canvas;
	} else {
		const ctx = ctxOf(live.target_canvas);
		ctx.clearRect(0, 0, live.target_canvas.width, live.target_canvas.height);
		ctx.putImageData(mapped, 0, 0);
	}

	refreshTexture(live.texture);
	if (live.saved_flag !== undefined) live.texture.saved = live.saved_flag;
}

function endLivePreview() {
	if (live.timer) { clearTimeout(live.timer); live.timer = null; }
	if (!live.active) return;
	const texture = live.texture;
	try {
		if (live.created_layer && texture && Array.isArray(texture.layers)) {
			const index = texture.layers.indexOf(live.created_layer);
			if (index !== -1) texture.layers.splice(index, 1);
			if (texture.selected_layer === live.created_layer) {
				texture.selected_layer = live.previous_selected || null;
				try {
					if (live.previous_selected && typeof live.previous_selected.select === 'function') {
						live.previous_selected.select();
					}
				} catch (err) { /* ignore */ }
			}
		}
		if (live.restore) {
			const target = live.restore.layer || null;
			const canvas = target ? target.canvas : live.restore.flat_target;
			const saved = live.restore.canvas;
			if (canvas && saved) {
				if (canvas.width !== saved.width || canvas.height !== saved.height) {
					if (target && typeof target.setSize === 'function') target.setSize(saved.width, saved.height);
					else { canvas.width = saved.width; canvas.height = saved.height; }
				}
				const live_canvas = target ? target.canvas : canvas;
				const ctx = (target && target.ctx) || ctxOf(live_canvas);
				ctx.clearRect(0, 0, live_canvas.width, live_canvas.height);
				ctx.drawImage(saved, 0, 0);
			}
			if (target && live.restore.offset) target.offset = live.restore.offset;
		}
		if (texture) {
			refreshTexture(texture);
			if (live.saved_flag !== undefined) texture.saved = live.saved_flag;
		}
	} catch (err) {
		console.error('[Gradient Map Layer] Could not restore the preview', err);
		Blockbench.showQuickMessage('Could not undo the gradient map preview cleanly', 3000);
	}

	if (live.target_layer && live.target_layer.uuid) sync_cache.delete(live.target_layer.uuid);
	if (live.source && live.source.layer && live.source.layer.uuid) sync_cache.delete(live.source.layer.uuid);

	live.active = false;
	live.key = null;
	live.texture = null;
	live.source = null;
	live.target_canvas = null;
	live.target_layer = null;
	live.created_layer = null;
	live.previous_selected = null;
	live.restore = null;
	live.saved_flag = undefined;
	live.failed = false;
}

/** Re-run the on-model preview from the current dialog state. */
function runLivePreview() {
	if (!state || !dialog_active) { endLivePreview(); return; }
	const options = state.options;
	const texture = allTextures().find(t => t.uuid === options.texture_id);
	const gradient = currentGradientFromState();

	if (!texture || !gradient || !options.live_preview || options.output === 'new_texture') {
		endLivePreview();
		return;
	}
	const key = previewKey(options);
	try {
		if (live.active && live.key !== key) endLivePreview();
		if (!live.active && !beginLivePreview(texture, options, key)) return;
		renderLivePreview(gradient, options);
	} catch (err) {
		console.error('[Gradient Map Layer] Preview failed', err);
		endLivePreview();
	}
}

function scheduleLivePreview() {
	if (!dialog_active) return;
	if (live.timer) clearTimeout(live.timer);
	live.timer = setTimeout(() => { live.timer = null; runLivePreview(); }, 70);
}

/** The gradient the dialog is currently showing, including an unsaved draft. */
function currentGradientFromState() {
	if (!state) return null;
	if (state.mode === 'editor' && state.editor) {
		return {
			id: '__draft__',
			name: state.editor.name,
			type: 'stops',
			interpolation: state.editor.interpolation,
			space: state.editor.space,
			stops: state.editor.stops
		};
	}
	return state.builtins.concat(state.library, state.orphans).find(g => g.id === state.selected_id) || null;
}

function reportError(err) {
	console.error('[Gradient Map Layer]', err);
	Blockbench.showQuickMessage('Gradient map failed: ' + (err && err.message ? err.message : err), 3000);
}

function safeName(name) {
	return String(name || 'gradient').replace(/[^a-z0-9_\- ]/gi, '').trim().replace(/\s+/g, '_') || 'gradient';
}

/* ============================== options ============================== */

function defaultOptions() {
	return {
		texture_id: null,
		target_layer: null,
		source: 'layer',
		output: 'new_layer',
		value_mode: 'luminance',
		invert: false,
		black: 0,
		white: 255,
		midpoint: 0.5,
		steps: 0,
		dither: 0,
		strength: 100,
		use_gradient_alpha: true,
		limit_to_selection: true,
		auto_update: true,
		live_preview: true,
		layer_name: ''
	};
}

function loadOptions() {
	const o = defaultOptions();
	try {
		const raw = localStorage.getItem(OPT_KEY);
		if (raw) {
			const stored = JSON.parse(raw);
			for (const key in o) {
				if (stored[key] !== undefined && key !== 'texture_id' && key !== 'target_layer') o[key] = stored[key];
			}
		}
	} catch (err) { /* ignore */ }
	return o;
}

function saveOptions(o) {
	try {
		const copy = Object.assign({}, o);
		delete copy.texture;
		delete copy.texture_id;
		delete copy.target_layer;
		// Per layer, and turned off automatically in some cases, so never global.
		delete copy.auto_update;
		// "update this layer" only makes sense for the layer it was opened on.
		if (copy.output === 'update_layer') copy.output = 'new_layer';
		localStorage.setItem(OPT_KEY, JSON.stringify(copy));
	} catch (err) { /* ignore */ }
}

/* ============================== dialog ============================== */

const CSS = `
	#gradient_map_layer_dialog .dialog_content { margin: 0; }
	.gml_root { display: flex; gap: 10px; height: 500px; font-size: 13px; }
	.gml_col_left { display: flex; flex-direction: column; width: 300px; min-width: 300px; }
	.gml_col_right { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; overflow-y: auto; padding-right: 4px; }
	.gml_bar { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; flex-wrap: wrap; }
	.gml_bar input.gml_search { flex: 1 1 60px; min-width: 60px; }
	.gml_btn {
		background-color: var(--color-button); color: var(--color-text); border: none;
		padding: 3px 8px; cursor: pointer; border-radius: 3px; height: 26px; white-space: nowrap;
	}
	.gml_btn:hover { background-color: var(--color-accent); color: var(--color-accent_text); }
	.gml_btn:disabled { opacity: .4; cursor: default; background-color: var(--color-button); color: var(--color-text); }
	.gml_btn.gml_icon_btn { padding: 3px 5px; display: inline-flex; align-items: center; }
	.gml_btn i { font-size: 17px; }
	.gml_list {
		flex: 1 1 auto; overflow-y: auto; background-color: var(--color-back);
		border: 1px solid var(--color-border); padding: 4px; min-height: 0;
	}
	.gml_group {
		display: flex; align-items: center; gap: 3px; cursor: pointer; user-select: none;
		padding: 3px 2px 3px 0; margin-top: 2px;
		border-bottom: 1px solid var(--color-border); color: var(--color-light);
		font-size: 12px; font-weight: 600; letter-spacing: .3px;
		position: sticky; top: -4px; background-color: var(--color-back); z-index: 1;
	}
	.gml_group:hover { color: var(--color-accent); }
	.gml_group.gml_group_off { opacity: .45; }
	.gml_group_name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.gml_group_count { font-size: 10px; font-weight: 400; opacity: .6; }
	.gml_caret { font-size: 17px; opacity: .8; }
	.gml_group_icon { font-size: 15px; opacity: .55; padding: 0 1px; }
	.gml_group_icon:hover { opacity: 1; color: var(--color-accent); }
	.gml_item { padding: 4px; border: 2px solid transparent; cursor: pointer; border-radius: 3px; }
	.gml_item:hover { background-color: var(--color-ui); }
	.gml_item.selected { border-color: var(--color-accent); background-color: var(--color-selected); }
	.gml_item_head { display: flex; align-items: center; gap: 4px; }
	.gml_item_name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.gml_item_tag { font-size: 10px; opacity: .6; text-transform: uppercase; letter-spacing: .5px; }
	.gml_item_tools { display: none; gap: 2px; }
	.gml_item:hover .gml_item_tools, .gml_item.selected .gml_item_tools { display: flex; }
	.gml_item_tools i { font-size: 15px; opacity: .7; cursor: pointer; padding: 1px; }
	.gml_item_tools i:hover { opacity: 1; color: var(--color-accent); }
	.gml_checker {
		background-color: #ffffff;
		background-image:
			linear-gradient(45deg, #c0c0c0 25%, transparent 25%, transparent 75%, #c0c0c0 75%),
			linear-gradient(45deg, #c0c0c0 25%, transparent 25%, transparent 75%, #c0c0c0 75%);
		background-size: 12px 12px;
		background-position: 0 0, 6px 6px;
	}
	.gml_strip { display: block; width: 100%; height: 22px; }
	.gml_strip.gml_tall { height: 44px; }
	.gml_row { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
	.gml_row > label { width: 118px; min-width: 118px; color: var(--color-subtle_text); }
	.gml_row > select, .gml_row > input[type=text] { flex: 1 1 auto; min-width: 0; }
	.gml_row input[type=range] { flex: 1 1 auto; min-width: 40px; }
	.gml_row .gml_num { width: 58px; min-width: 58px; }
	.gml_section {
		margin: 8px 0 4px 0; padding-bottom: 3px; border-bottom: 1px solid var(--color-border);
		color: var(--color-light); font-weight: 600; letter-spacing: .4px;
	}
	.gml_hint { color: var(--color-subtle_text); font-size: 11px; margin: 2px 0 6px 0; }
	.gml_warn { color: var(--color-accent); }
	.gml_editing {
		display: flex; align-items: center; gap: 6px; margin: 0 0 4px 0; padding: 5px 7px;
		background-color: var(--color-selected); border-left: 3px solid var(--color-accent);
		color: var(--color-text); font-size: 12px;
	}
	.gml_editing i { font-size: 16px; color: var(--color-accent); }

	/* editor */
	.gml_editor { display: flex; flex-direction: column; width: 100%; }
	.gml_edit_strip_wrap { margin: 6px 0 0 0; border: 1px solid var(--color-border); }
	.gml_track {
		position: relative; height: 26px; margin: 0 0 8px 0; cursor: copy;
		background-color: var(--color-back); border: 1px solid var(--color-border); border-top: none;
	}
	.gml_stop {
		position: absolute; top: 2px; width: 16px; height: 20px; margin-left: -8px;
		cursor: grab; border: 2px solid var(--color-border); border-radius: 3px; box-sizing: border-box;
		background-color: var(--color-back);
	}
	.gml_stop.sel { border-color: var(--color-accent); z-index: 2; }
	.gml_stop_fill { width: 100%; height: 100%; }
	.gml_stop_list { display: flex; flex-wrap: wrap; gap: 4px; }
	.gml_color_input { width: 40px; height: 26px; padding: 0; border: none; background: none; cursor: pointer; }
	.gml_editor_grid { display: flex; gap: 16px; }
	.gml_editor_grid > div { flex: 1 1 0; min-width: 0; }
`;

function makeState() {
	const options = loadOptions();
	const texture = currentTexture();
	options.texture_id = texture ? texture.uuid : null;
	options.target_layer = null;

	const user_library = loadLibrary();
	// Gradients used by a layer but no longer in the library, kept so a layer can
	// always be re-edited with exactly what it was made from.
	const orphans = [];
	let selected_id = null;
	try { selected_id = localStorage.getItem(DATA_KEY + '.last_gradient'); } catch (err) { /* ignore */ }

	// Re-open the settings of the selected layer if it is a gradient map layer.
	const layer = activeLayer(texture);
	const meta = recallLayerSettings(layer);
	let target_layer_name = '';
	if (meta) {
		Object.assign(options, meta.options || {});
		options.texture_id = texture.uuid;
		options.target_layer = layer.uuid;
		options.output = 'update_layer';
		options.layer_name = layer.name;
		target_layer_name = layer.name;
		selected_id = meta.gradient_id;
		if (meta.gradient && !BUILTINS.concat(user_library).find(g => g.id === meta.gradient_id)) {
			const orphan = sanitizeGradient(meta.gradient);
			orphan.id = meta.gradient_id || orphan.id;
			orphans.push(orphan);
			selected_id = orphan.id;
		}
	}

	const gradients = BUILTINS.concat(user_library, orphans);
	if (!gradients.find(g => g.id === selected_id)) selected_id = gradients[0] ? gradients[0].id : null;

	return {
		mode: 'library',
		search: '',
		library: user_library,
		builtins: BUILTINS,
		orphans: orphans,
		group_record: loadGroups(),
		selected_id: selected_id,
		options: options,
		value_modes: VALUE_MODES,
		interpolations: INTERPOLATIONS,
		color_spaces: COLOR_SPACES,
		editor: null,
		editor_origin: null,
		textures: allTextures().map(t => ({ uuid: t.uuid, name: t.name })),
		has_selection: hasCustomSelection(texture),
		target_layer_name: target_layer_name,
		rev: 0
	};
}

let state = null;

/** Write the editor draft back into the library. Returns the stored gradient. */
function commitEditorGradient(s) {
	const draft = s && s.editor;
	if (!draft) return null;
	const gradient = sanitizeGradient({
		id: s.editor_origin || draft.id,
		name: draft.name,
		type: 'stops',
		interpolation: draft.interpolation,
		space: draft.space,
		stops: draft.stops
	});
	const existing = s.library.find(g => g.id === gradient.id);
	if (existing) {
		Object.assign(existing, gradient);
		bumpPreview(existing);
	} else {
		s.library.push(gradient);
	}
	saveLibrary(s.library);
	s.rev++;
	s.selected_id = gradient.id;
	return gradient;
}

const TEMPLATE = `
<div class="gml_root">

	<div class="gml_col_left" v-if="mode === 'library'">
		<div class="gml_bar">
			<input type="text" class="dark_bordered gml_search" placeholder="Search gradients..." v-model="search">
			<button class="gml_btn gml_icon_btn" title="New gradient" @click="newGradient()"><i class="material-icons">add</i></button>
			<button class="gml_btn gml_icon_btn" title="New group" @click="newGroup()"><i class="material-icons">create_new_folder</i></button>
			<button class="gml_btn gml_icon_btn" title="Import gradient map PNG (256x16)" @click="importPNG()"><i class="material-icons">image</i></button>
			<button class="gml_btn gml_icon_btn" title="Import Photoshop gradients (.grd)" @click="importGRD()"><i class="material-icons">file_upload</i></button>
			<button class="gml_btn gml_icon_btn" title="Library" @click="libraryMenu($event)"><i class="material-icons">more_vert</i></button>
		</div>
		<ul class="gml_list">
			<template v-for="section in sections">
				<li class="gml_group" :key="'group_' + section.key" :class="{gml_group_off: section.hidden}"
					@click="toggleCollapse(section)" @contextmenu.prevent="groupMenu(section, $event)">
					<i class="material-icons gml_caret">{{ section.collapsed && !search ? 'chevron_right' : 'expand_more' }}</i>
					<span class="gml_group_name">{{ section.name }}</span>
					<span class="gml_group_count">{{ search ? section.matches.length + ' / ' + section.total : section.total }}</span>
					<i class="material-icons gml_group_icon" :title="section.hidden ? 'Show this group' : 'Hide this group'"
						@click.stop="toggleHidden(section)">{{ section.hidden ? 'visibility_off' : 'visibility' }}</i>
					<i class="material-icons gml_group_icon" title="Group options" @click.stop="groupMenu(section, $event)">more_vert</i>
				</li>
				<li v-for="g in section.visible" :key="g.id" class="gml_item" :class="{selected: g.id === selected_id}"
					@click="selected_id = g.id" @dblclick="editGradient(g)" @contextmenu.prevent="itemMenu(g, $event)">
					<div class="gml_item_head">
						<span class="gml_item_name">{{ g.name }}</span>
						<span class="gml_item_tag" v-if="g.builtin">preset</span>
						<span class="gml_item_tag" v-else-if="g.type === 'raw'">image</span>
						<span class="gml_item_tools">
							<i class="material-icons" title="Edit" @click.stop="editGradient(g)">edit</i>
							<i class="material-icons" title="Duplicate" @click.stop="duplicateGradient(g)">content_copy</i>
							<i class="material-icons" title="Move to group" v-if="!g.builtin" @click.stop="moveMenu(g, $event)">folder</i>
							<i class="material-icons" title="Delete" v-if="!g.builtin" @click.stop="deleteGradient(g)">delete</i>
						</span>
					</div>
					<div class="gml_checker"><img class="gml_strip" :src="preview(g)"></div>
				</li>
			</template>
			<li v-if="!visible_count" class="gml_hint" style="padding: 8px;">
				{{ search ? 'No gradients match that search.' : 'Everything is collapsed or hidden.' }}
			</li>
		</ul>
	</div>

	<div class="gml_col_right" v-if="mode === 'library'">
		<div class="gml_section">Gradient</div>
		<div class="gml_checker" v-if="selected"><img class="gml_strip gml_tall" :src="preview(selected)"></div>
		<div class="gml_row" style="margin-top: 6px;">
			<label>{{ selected ? selected.name : 'Nothing selected' }}</label>
			<button class="gml_btn" :disabled="!selected" @click="editGradient(selected)">Edit</button>
			<button class="gml_btn" :disabled="!selected" @click="reverseSelected()">Reverse</button>
		</div>

		<p class="gml_hint gml_editing" v-if="options.target_layer">
			<i class="material-icons">edit</i>
			<span v-if="options.output === 'update_layer'">
				Editing "{{ target_layer_name }}" - its gradient and settings are loaded below,
				and applying re-renders that layer in place.
			</span>
			<span v-else>Settings loaded from the layer "{{ target_layer_name }}".</span>
		</p>

		<div class="gml_section">Source</div>
		<div class="gml_row">
			<label>Texture</label>
			<select class="dark_bordered" v-model="options.texture_id" @change="onTextureChange()">
				<option v-for="t in textures" :key="t.uuid" :value="t.uuid">{{ t.name }}</option>
			</select>
		</div>
		<div class="gml_row">
			<label>Read from</label>
			<select class="dark_bordered" v-model="options.source">
				<option value="layer">Active layer</option>
				<option value="texture">Whole texture (flattened)</option>
			</select>
		</div>
		<div class="gml_row">
			<label>Value from</label>
			<select class="dark_bordered" v-model="options.value_mode">
				<option v-for="m in value_modes" :key="m.id" :value="m.id">{{ m.name }}</option>
			</select>
		</div>
		<div class="gml_row" v-if="has_selection">
			<label>Selection only</label>
			<input type="checkbox" v-model="options.limit_to_selection">
			<span class="gml_hint" style="margin: 0;">Map only the selected pixels</span>
		</div>

		<div class="gml_section">Mapping</div>
		<div class="gml_row">
			<label>Black point</label>
			<input type="range" min="0" max="255" step="1" v-model.number="options.black">
			<input type="number" class="dark_bordered gml_num" min="0" max="255" v-model.number="options.black">
		</div>
		<div class="gml_row">
			<label>White point</label>
			<input type="range" min="0" max="255" step="1" v-model.number="options.white">
			<input type="number" class="dark_bordered gml_num" min="0" max="255" v-model.number="options.white">
		</div>
		<div class="gml_row">
			<label>Midpoint</label>
			<input type="range" min="0.05" max="0.95" step="0.01" v-model.number="options.midpoint">
			<input type="number" class="dark_bordered gml_num" min="0.05" max="0.95" step="0.05" v-model.number="options.midpoint">
		</div>
		<div class="gml_row">
			<label>Quantize steps</label>
			<input type="range" min="0" max="32" step="1" v-model.number="options.steps">
			<input type="number" class="dark_bordered gml_num" min="0" max="32" v-model.number="options.steps">
		</div>
		<div class="gml_row">
			<label>Dither</label>
			<input type="range" min="0" max="100" step="1" v-model.number="options.dither">
			<input type="number" class="dark_bordered gml_num" min="0" max="100" v-model.number="options.dither">
		</div>
		<div class="gml_row">
			<label>Strength</label>
			<input type="range" min="0" max="100" step="1" v-model.number="options.strength">
			<input type="number" class="dark_bordered gml_num" min="0" max="100" v-model.number="options.strength">
		</div>
		<div class="gml_row">
			<label>Invert values</label>
			<input type="checkbox" v-model="options.invert">
			<label style="width: auto; margin-left: 12px;">Use gradient alpha</label>
			<input type="checkbox" v-model="options.use_gradient_alpha">
		</div>

		<div class="gml_section">Output</div>
		<div class="gml_row">
			<label>Write to</label>
			<select class="dark_bordered" v-model="options.output">
				<option value="update_layer" v-if="options.target_layer">Update "{{ target_layer_name }}"</option>
				<option value="new_layer">New layer above source</option>
				<option value="replace">Replace source pixels</option>
				<option value="new_texture">New texture</option>
			</select>
		</div>
		<div class="gml_row" v-if="options.output === 'new_layer' || options.output === 'update_layer'">
			<label>Layer name</label>
			<input type="text" class="dark_bordered" :placeholder="'Gradient Map - ' + (selected ? selected.name : '')" v-model="options.layer_name">
		</div>
		<div class="gml_row" v-if="options.output === 'new_layer' || options.output === 'update_layer'">
			<label>Follow the source</label>
			<input type="checkbox" v-model="options.auto_update" :disabled="selection_locked">
			<span class="gml_hint" style="margin: 0;" v-if="selection_locked">Not available for a selection-limited layer</span>
			<span class="gml_hint" style="margin: 0;" v-else>Re-render whenever the source layer is painted on</span>
		</div>
		<p class="gml_hint gml_warn" v-if="options.output === 'new_layer' && !layers_enabled">
			This texture has no layers yet. Applying will convert it to a layered texture.
		</p>

		<div class="gml_section">Preview</div>
		<div class="gml_row">
			<label>Live preview</label>
			<input type="checkbox" v-model="options.live_preview">
			<span class="gml_hint" style="margin: 0;">Show the result on the model while the dialog is open</span>
		</div>
		<p class="gml_hint" v-if="options.output === 'new_texture'">
			A new texture cannot be previewed on the model - the mapped copy is added when you press Apply.
		</p>
		<p class="gml_hint" v-else-if="options.live_preview">
			The model updates as you change these settings. Cancel puts it back exactly as it was.
		</p>
	</div>

	<div class="gml_editor" v-if="mode === 'editor' && editor">
		<div class="gml_row">
			<label>Name</label>
			<input type="text" class="dark_bordered" v-model="editor.name" style="max-width: 320px;">
			<button class="gml_btn" @click="commitEditor(true)">Save</button>
			<button class="gml_btn" @click="cancelEditor()">Back</button>
		</div>

		<div class="gml_edit_strip_wrap gml_checker">
			<img class="gml_strip gml_tall" :src="editor_preview">
		</div>
		<div class="gml_track" ref="track" @pointerdown="trackClick($event)">
			<div v-for="(stop, i) in editor.stops" :key="i" class="gml_stop" :class="{sel: i === editor.selected}"
				:style="{left: (stop.p * 100) + '%'}" :title="'Stop ' + (i + 1) + ' - double click to delete'"
				@pointerdown.stop="beginDrag(i, $event)" @dblclick.stop="deleteStop(i)">
				<div class="gml_stop_fill" :style="{backgroundColor: stop.c, opacity: stop.a / 255}"></div>
			</div>
		</div>
		<p class="gml_hint">Click the bar to add a stop, drag stops to move them, double click a stop to delete it.</p>

		<div class="gml_editor_grid">
			<div>
				<div class="gml_section">Selected stop</div>
				<div class="gml_row" v-if="selectedStop">
					<label>Colour</label>
					<input type="color" class="gml_color_input" :value="selectedStop.c" @input="setStopColor($event.target.value)">
					<input type="text" class="dark_bordered" style="width: 90px;" :value="selectedStop.c" @change="setStopColor($event.target.value)">
					<button class="gml_btn gml_icon_btn" title="Pick from the Blockbench colour" @click="useAppColor()"><i class="material-icons">colorize</i></button>
				</div>
				<div class="gml_row" v-if="selectedStop">
					<label>Position</label>
					<input type="range" min="0" max="1000" step="1" :value="selectedStop.p * 1000" @input="setStopPos($event.target.value / 1000)">
					<input type="number" class="dark_bordered gml_num" min="0" max="100" step="1" :value="Math.round(selectedStop.p * 100)" @input="setStopPos($event.target.value / 100)">
				</div>
				<div class="gml_row" v-if="selectedStop">
					<label>Alpha</label>
					<input type="range" min="0" max="255" step="1" v-model.number="selectedStop.a">
					<input type="number" class="dark_bordered gml_num" min="0" max="255" v-model.number="selectedStop.a">
				</div>
				<div class="gml_row">
					<label>&nbsp;</label>
					<button class="gml_btn" @click="addStop()">Add stop</button>
					<button class="gml_btn" :disabled="editor.stops.length < 3" @click="deleteStop(editor.selected)">Delete stop</button>
				</div>
			</div>
			<div>
				<div class="gml_section">Gradient</div>
				<div class="gml_row">
					<label>Interpolation</label>
					<select class="dark_bordered" v-model="editor.interpolation">
						<option v-for="m in interpolations" :key="m.id" :value="m.id">{{ m.name }}</option>
					</select>
				</div>
				<div class="gml_row">
					<label>Blend space</label>
					<select class="dark_bordered" v-model="editor.space">
						<option v-for="m in color_spaces" :key="m.id" :value="m.id">{{ m.name }}</option>
					</select>
				</div>
				<div class="gml_row">
					<label>&nbsp;</label>
					<button class="gml_btn" @click="reverseEditor()">Reverse</button>
					<button class="gml_btn" @click="distributeEditor()">Distribute</button>
				</div>
				<p class="gml_hint">
					{{ editor.stops.length }} stops. Saved as a 256 x 16 gradient map.
				</p>
			</div>
		</div>
	</div>
</div>
`;

function buildComponent() {
	return {
		data() { return state; },
		computed: {
			all() {
				this.rev;
				return this.builtins.concat(this.library, this.orphans);
			},
			filtered() {
				const q = this.search.toLowerCase().trim();
				if (!q) return this.all;
				return this.all.filter(g => g.name.toLowerCase().includes(q));
			},
			/** The library list, split into collapsible / hideable sections. */
			sections() {
				this.rev;
				const query = this.search.toLowerCase().trim();
				const record = this.group_record;
				const matches = list => (query ? list.filter(g => g.name.toLowerCase().includes(query)) : list);
				const known = {};
				record.groups.forEach(g => { known[g.id] = true; });

				const build = (key, name, gradients, group) => {
					const flags = group || record.fixed[key] || { collapsed: false, hidden: false };
					const found = matches(gradients);
					return {
						key: key,
						name: name,
						group: group || null,
						fixed: !group,
						collapsed: !!flags.collapsed,
						hidden: !!flags.hidden,
						total: gradients.length,
						matches: found,
						// A search opens collapsed sections so results are never hidden by them.
						visible: flags.hidden ? [] : ((flags.collapsed && !query) ? [] : found)
					};
				};

				const list = [];
				list.push(build(PRESETS_SECTION, 'Presets', this.builtins, null));
				record.groups.forEach(group => {
					list.push(build(group.id, group.name, this.library.filter(g => g.group === group.id), group));
				});
				list.push(build(UNGROUPED_SECTION, 'Ungrouped', this.library.filter(g => !g.group || !known[g.group]), null));
				if (this.orphans.length) list.push(build(ORPHAN_SECTION, 'From layers', this.orphans, null));

				// Empty fixed sections are just noise; empty user groups stay so you can fill them.
				return list.filter(section => section.group || section.total > 0);
			},
			visible_count() {
				return this.sections.reduce((n, section) => n + section.visible.length, 0);
			},
			move_targets() {
				this.rev;
				return this.group_record.groups;
			},
			selected() {
				return this.all.find(g => g.id === this.selected_id) || null;
			},
			selectedStop() {
				if (!this.editor) return null;
				return this.editor.stops[this.editor.selected] || null;
			},
			editor_preview() {
				if (!this.editor) return '';
				return lutToCanvas(lutFromStops(this.editor.stops, this.editor.interpolation, this.editor.space)).toDataURL('image/png');
			},
			texture() {
				return allTextures().find(t => t.uuid === this.options.texture_id) || null;
			},
			layers_enabled() {
				const t = this.texture;
				return !!(t && t.layers_enabled);
			},
			selection_locked() {
				// Auto follow would spread a selection-limited layer past its selection.
				return !!(this.has_selection && this.options.limit_to_selection);
			}
		},
		methods: {
			preview(g) { return previewURL(g); },
			onTextureChange() {
				const texture = this.texture;
				this.has_selection = hasCustomSelection(texture);

				// The "update this layer" target belongs to whichever texture is selected.
				const layer = activeLayer(texture);
				const meta = recallLayerSettings(layer);
				if (meta) {
					this.options.target_layer = layer.uuid;
					this.target_layer_name = layer.name;
					if (this.options.output === 'new_layer') this.options.output = 'update_layer';
				} else {
					this.options.target_layer = null;
					this.target_layer_name = '';
					if (this.options.output === 'update_layer') this.options.output = 'new_layer';
				}
				this.schedulePreview();
			},

			/* -------- library -------- */
			persist() {
				saveLibrary(this.library);
				this.rev++;
			},

			/* -------- groups -------- */
			persistGroups() {
				saveGroups(this.group_record);
				this.rev++;
			},
			toggleCollapse(section) {
				const flags = section.group || this.group_record.fixed[section.key];
				if (!flags) return;
				this.$set(flags, 'collapsed', !flags.collapsed);
				this.persistGroups();
			},
			toggleHidden(section) {
				const flags = section.group || this.group_record.fixed[section.key];
				if (!flags) return;
				this.$set(flags, 'hidden', !flags.hidden);
				this.persistGroups();
			},
			showAllGroups() {
				this.group_record.groups.forEach(g => { this.$set(g, 'hidden', false); });
				FIXED_SECTIONS.forEach(id => {
					if (this.group_record.fixed[id]) this.$set(this.group_record.fixed[id], 'hidden', false);
				});
				this.persistGroups();
			},
			soloGroup(section) {
				this.group_record.groups.forEach(g => { this.$set(g, 'hidden', g !== section.group); });
				FIXED_SECTIONS.forEach(id => {
					if (this.group_record.fixed[id]) this.$set(this.group_record.fixed[id], 'hidden', id !== section.key);
				});
				this.persistGroups();
			},
			newGroup(callback) {
				const self = this;
				askForText('New group', 'Group name', 'New Group', function (name) {
					if (!name) return;
					const group = { id: uid(), name: name.slice(0, 60), collapsed: false, hidden: false };
					self.group_record.groups.push(group);
					self.persistGroups();
					if (callback) callback(group);
				});
			},
			renameGroup(section) {
				if (!section.group) return;
				const self = this;
				askForText('Rename group', 'Group name', section.group.name, function (name) {
					if (!name) return;
					self.$set(section.group, 'name', name.slice(0, 60));
					self.persistGroups();
				});
			},
			deleteGroup(section) {
				if (!section.group) return;
				const index = this.group_record.groups.indexOf(section.group);
				if (index === -1) return;
				// The gradients survive, they just fall back to Ungrouped.
				this.library.forEach(g => { if (g.group === section.group.id) g.group = null; });
				this.group_record.groups.splice(index, 1);
				this.persist();
				this.persistGroups();
			},
			moveGroup(section, direction) {
				const groups = this.group_record.groups;
				const index = groups.indexOf(section.group);
				const to = index + direction;
				if (index === -1 || to < 0 || to >= groups.length) return;
				groups.splice(to, 0, groups.splice(index, 1)[0]);
				this.persistGroups();
			},
			assignGroup(gradient, group_id) {
				if (!gradient || gradient.builtin) return;
				const entry = this.library.find(g => g.id === gradient.id);
				if (!entry) {
					// An orphan recovered from a layer joins the library when filed away.
					const copy = sanitizeGradient(gradient);
					copy.id = gradient.id;
					copy.group = group_id;
					this.library.push(copy);
					const orphan_index = this.orphans.indexOf(gradient);
					if (orphan_index !== -1) this.orphans.splice(orphan_index, 1);
				} else {
					this.$set(entry, 'group', group_id);
				}
				this.persist();
			},
			groupMenu(section, event) {
				const self = this;
				const entries = [];
				if (section.group) {
					entries.push({ name: 'Rename...', icon: 'edit', click() { self.renameGroup(section); } });
					entries.push({ name: 'Move up', icon: 'arrow_upward', click() { self.moveGroup(section, -1); } });
					entries.push({ name: 'Move down', icon: 'arrow_downward', click() { self.moveGroup(section, 1); } });
					entries.push('_');
				}
				entries.push({
					name: section.hidden ? 'Show' : 'Hide',
					icon: section.hidden ? 'visibility' : 'visibility_off',
					click() { self.toggleHidden(section); }
				});
				entries.push({
					name: section.collapsed ? 'Expand' : 'Collapse',
					icon: section.collapsed ? 'unfold_more' : 'unfold_less',
					click() { self.toggleCollapse(section); }
				});
				entries.push({ name: 'Show only this', icon: 'filter_center_focus', click() { self.soloGroup(section); } });
				entries.push({ name: 'Show all groups', icon: 'visibility', click() { self.showAllGroups(); } });
				entries.push('_');
				entries.push({ name: 'New group...', icon: 'create_new_folder', click() { self.newGroup(); } });
				if (section.group) {
					entries.push({ name: 'Delete group', icon: 'delete', click() { self.deleteGroup(section); } });
				}
				new Menu(entries).show(event);
			},
			moveMenu(gradient, event) {
				const self = this;
				const entries = [{
					name: 'Ungrouped',
					icon: gradient.group ? 'radio_button_unchecked' : 'radio_button_checked',
					click() { self.assignGroup(gradient, null); }
				}];
				this.group_record.groups.forEach(group => {
					entries.push({
						name: group.name,
						icon: gradient.group === group.id ? 'radio_button_checked' : 'radio_button_unchecked',
						click() { self.assignGroup(gradient, group.id); }
					});
				});
				entries.push('_');
				entries.push({
					name: 'New group...', icon: 'create_new_folder',
					click() { self.newGroup(group => self.assignGroup(gradient, group.id)); }
				});
				new Menu(entries).show(event);
			},
			itemMenu(gradient, event) {
				const self = this;
				const entries = [
					{ name: 'Edit...', icon: 'edit', click() { self.editGradient(gradient); } },
					{ name: 'Duplicate', icon: 'content_copy', click() { self.duplicateGradient(gradient); } },
					{ name: 'Export as PNG...', icon: 'file_download', click() { self.exportPNG(gradient); } }
				];
				if (!gradient.builtin) {
					entries.push('_');
					// Blockbench calls menu handlers as click(context, event).
					entries.push({ name: 'Move to group...', icon: 'folder', click(context, click_event) { self.moveMenu(gradient, click_event || event); } });
					entries.push({ name: 'Delete', icon: 'delete', click() { self.deleteGradient(gradient); } });
				}
				new Menu(entries).show(event);
			},
			newGradient() {
				this.startEditor({
					id: uid(),
					name: 'New Gradient',
					builtin: false,
					type: 'stops',
					interpolation: 'linear',
					space: 'srgb',
					stops: [{ p: 0, c: '#1a1a2e', a: 255 }, { p: 1, c: '#ffe9c4', a: 255 }]
				}, null);
			},
			editGradient(g) {
				if (!g) return;
				if (g.type === 'raw') {
					const stops = stopsFromLUT(getLUT(g));
					const copy = cloneGradient(g);
					copy.type = 'stops';
					copy.stops = stops;
					copy.interpolation = 'linear';
					copy.space = 'srgb';
					delete copy.lut;
					Blockbench.showQuickMessage('Sampled the image into ' + stops.length + ' editable stops', 2200);
					this.startEditor(copy, null);
					return;
				}
				if (g.builtin) {
					const copy = cloneGradient(g, g.name + ' Copy');
					this.startEditor(copy, null);
					return;
				}
				this.startEditor(JSON.parse(JSON.stringify(g)), g.id);
			},
			duplicateGradient(g) {
				if (!g) return;
				const copy = cloneGradient(g, g.name + ' Copy');
				copy.group = g.builtin ? null : (g.group || null);
				const index = this.library.indexOf(g);
				if (index === -1) this.library.push(copy);
				else this.library.splice(index + 1, 0, copy);
				this.persist();
				this.selected_id = copy.id;
			},
			deleteGradient(g) {
				if (!g || g.builtin) return;
				const orphan_index = this.orphans.indexOf(g);
				if (orphan_index !== -1) {
					this.orphans.splice(orphan_index, 1);
					this.rev++;
					if (this.selected_id === g.id) this.selected_id = this.all[0] ? this.all[0].id : null;
					return;
				}
				const index = this.library.indexOf(g);
				if (index === -1) return;
				this.library.splice(index, 1);
				this.persist();
				if (this.selected_id === g.id) this.selected_id = this.all[0] ? this.all[0].id : null;
			},
			reverseSelected() {
				const g = this.selected;
				if (!g) return;
				if (g.builtin || g.type === 'raw') {
					const copy = cloneGradient(g, g.name + ' Reversed');
					if (copy.type === 'raw') {
						const lut = getLUT(g);
						const flipped = new Uint8ClampedArray(GW * 4);
						for (let x = 0; x < GW; x++) {
							const s = (GW - 1 - x) * 4, d = x * 4;
							flipped[d] = lut[s]; flipped[d + 1] = lut[s + 1]; flipped[d + 2] = lut[s + 2]; flipped[d + 3] = lut[s + 3];
						}
						copy.lut = bytesToBase64(flipped);
					} else {
						copy.stops = copy.stops.map(s => ({ p: Math.round((1 - s.p) * 1000) / 1000, c: s.c, a: s.a }));
					}
					this.library.push(copy);
					this.persist();
					this.selected_id = copy.id;
				} else {
					g.stops = g.stops.map(s => ({ p: Math.round((1 - s.p) * 1000) / 1000, c: s.c, a: s.a })).sort((a, b) => a.p - b.p);
					bumpPreview(g);
					this.persist();
				}
				this.schedulePreview();
			},
			libraryMenu(event) {
				const self = this;
				new Menu([
					{
						name: 'Import gradient map PNG...', icon: 'image', click() { self.importPNG(); }
					},
					{
						name: 'Import Photoshop gradients (.grd)...', icon: 'gradient', click() { self.importGRD(); }
					},
					{
						name: 'Import library (.json)...', icon: 'folder_open', click() { self.importLibrary(); }
					},
					{
						name: 'Export library (.json)...', icon: 'save', click() { self.exportLibrary(); }
					},
					'_',
					{
						name: 'Export selected as PNG...', icon: 'file_download', click() { self.exportPNG(self.selected); }
					}
				]).show(event.target);
			},
			importGRD() {
				const self = this;
				Blockbench.import({
					resource_id: 'gradient_map_layer',
					extensions: ['grd'],
					type: 'Photoshop Gradients',
					readtype: 'buffer',
					multiple: true
				}, function (files) {
					let added = 0, skipped = 0, failed = 0;
					files.forEach(file => {
						try {
							const buffer = toArrayBuffer(file.content);
							if (!buffer) throw new Error('Could not read the file');
							const result = parseGRD(buffer);
							skipped += result.skipped;
							// A pack is usually dozens of ramps, so file it under its own group.
							let group_id = null;
							if (result.gradients.length > 1) {
								const group = {
									id: uid(),
									name: String(file.name || 'Photoshop gradients').replace(/\.[a-z0-9]+$/i, '').slice(0, 60),
									collapsed: false,
									hidden: false
								};
								self.group_record.groups.push(group);
								group_id = group.id;
							}
							result.gradients.forEach(entry => {
								const gradient = {
									id: uid(),
									name: entry.name,
									builtin: false,
									group: group_id,
									type: 'raw',
									interpolation: 'linear',
									space: 'srgb',
									lut: bytesToBase64(entry.lut)
								};
								self.library.push(gradient);
								self.selected_id = gradient.id;
								added++;
							});
						} catch (err) {
							failed++;
							console.error('[Gradient Map Layer]', err);
							Blockbench.showQuickMessage(file.name + ': ' + err.message, 3500);
						}
					});
					if (added) {
						self.persist();
						self.persistGroups();
						self.schedulePreview();
					}
					if (added || skipped) {
						Blockbench.showQuickMessage(
							'Imported ' + added + ' gradient' + (added === 1 ? '' : 's') +
							(skipped ? ', skipped ' + skipped + ' noise gradient' + (skipped === 1 ? '' : 's') : ''),
							2600
						);
					} else if (!failed) {
						Blockbench.showQuickMessage('No usable gradients in that file', 2500);
					}
				});
			},
			importPNG() {
				const self = this;
				Blockbench.import({
					resource_id: 'gradient_map_layer',
					extensions: ['png'],
					type: 'Gradient Map',
					readtype: 'image',
					multiple: true
				}, function (files) {
					let added = 0;
					let pending = files.length;
					files.forEach(file => {
						const img = new Image();
						img.onload = function () {
							const lut = lutFromImage(img);
							const gradient = {
								id: uid(),
								name: String(file.name || 'Gradient').replace(/\.[a-z0-9]+$/i, ''),
								builtin: false,
								type: 'raw',
								interpolation: 'linear',
								space: 'srgb',
								lut: bytesToBase64(lut)
							};
							self.library.push(gradient);
							self.selected_id = gradient.id;
							added++;
							pending--;
							if (pending === 0) {
								self.persist();
								self.schedulePreview();
								Blockbench.showQuickMessage('Imported ' + added + ' gradient map(s)', 2000);
							}
						};
						img.onerror = function () {
							pending--;
							if (pending === 0) self.persist();
							Blockbench.showQuickMessage('Could not read ' + file.name, 2000);
						};
						img.src = file.content;
					});
				});
			},
			exportPNG(g) {
				if (!g) return;
				Blockbench.export({
					resource_id: 'gradient_map_layer',
					extensions: ['png'],
					type: 'Gradient Map',
					name: safeName(g.name),
					savetype: 'image',
					content: lutToCanvas(getLUT(g)).toDataURL('image/png')
				});
			},
			exportLibrary() {
				Blockbench.export({
					resource_id: 'gradient_map_layer',
					extensions: ['json'],
					type: 'Gradient Map Library',
					name: 'gradient_maps',
					savetype: 'text',
					content: JSON.stringify({
						format: 'gradient_map_layer',
						version: 2,
						groups: this.group_record.groups,
						gradients: this.library
					}, null, '\t')
				});
			},
			importLibrary() {
				const self = this;
				Blockbench.import({
					resource_id: 'gradient_map_layer',
					extensions: ['json'],
					type: 'Gradient Map Library',
					readtype: 'text'
				}, function (files) {
					let count = 0;
					files.forEach(file => {
						try {
							const data = JSON.parse(file.content);
							const list = Array.isArray(data) ? data : (data.gradients || []);
							// Bring any groups along, remapping their ids so an import never
							// collides with a group that is already here.
							const remap = {};
							const incoming = (data && Array.isArray(data.groups)) ? data.groups : [];
							incoming.forEach(entry => {
								if (!entry || !entry.id) return;
								const group = {
									id: uid(),
									name: String(entry.name || 'Group').slice(0, 60),
									collapsed: !!entry.collapsed,
									hidden: !!entry.hidden
								};
								remap[entry.id] = group.id;
								self.group_record.groups.push(group);
							});
							list.forEach(entry => {
								const g = sanitizeGradient(entry);
								g.id = uid();
								g.group = (g.group && remap[g.group]) ? remap[g.group] : null;
								self.library.push(g);
								count++;
							});
						} catch (err) {
							Blockbench.showQuickMessage('Could not read ' + file.name, 2000);
						}
					});
					if (count) {
						self.persist();
						self.persistGroups();
						Blockbench.showQuickMessage('Imported ' + count + ' gradient(s)', 2000);
					}
				});
			},

			/* -------- editor -------- */
			startEditor(gradient, origin_id) {
				gradient.selected = 0;
				this.editor = gradient;
				this.editor_origin = origin_id;
				this.mode = 'editor';
			},
			cancelEditor() {
				this.editor = null;
				this.editor_origin = null;
				this.mode = 'library';
				this.schedulePreview();
			},
			commitEditor(back) {
				const gradient = commitEditorGradient(this);
				if (!gradient) return null;
				if (back) {
					this.editor = null;
					this.editor_origin = null;
					this.mode = 'library';
					this.schedulePreview();
				}
				return gradient;
			},
			normalizeStops() {
				const current = this.editor.stops[this.editor.selected];
				this.editor.stops.sort((a, b) => a.p - b.p);
				const index = this.editor.stops.indexOf(current);
				this.editor.selected = index === -1 ? 0 : index;
			},
			trackClick(event) {
				if (event.target !== this.$refs.track) return;
				const rect = this.$refs.track.getBoundingClientRect();
				const p = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
				const lut = lutFromStops(this.editor.stops, this.editor.interpolation, this.editor.space);
				const i = Math.round(p * 255) * 4;
				const stop = { p: Math.round(p * 1000) / 1000, c: rgbToHex(lut[i], lut[i + 1], lut[i + 2]), a: lut[i + 3] };
				this.editor.stops.push(stop);
				this.editor.selected = this.editor.stops.indexOf(stop);
				this.normalizeStops();
			},
			addStop() {
				const stops = this.editor.stops;
				const current = stops[this.editor.selected] || stops[0];
				const next = stops[stops.indexOf(current) + 1];
				const p = next ? (current.p + next.p) / 2 : clamp(current.p + 0.1, 0, 1);
				const lut = lutFromStops(stops, this.editor.interpolation, this.editor.space);
				const i = Math.round(p * 255) * 4;
				const stop = { p: Math.round(p * 1000) / 1000, c: rgbToHex(lut[i], lut[i + 1], lut[i + 2]), a: lut[i + 3] };
				stops.push(stop);
				this.editor.selected = stops.indexOf(stop);
				this.normalizeStops();
			},
			deleteStop(index) {
				if (this.editor.stops.length < 3) return;
				this.editor.stops.splice(index, 1);
				this.editor.selected = clamp(index - 1, 0, this.editor.stops.length - 1);
			},
			beginDrag(index, event) {
				this.editor.selected = index;
				const track = this.$refs.track;
				if (!track) return;
				const rect = track.getBoundingClientRect();
				const stops = this.editor.stops;
				const self = this;

				function move(e) {
					const p = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
					stops[index].p = Math.round(p * 1000) / 1000;
				}
				function up() {
					document.removeEventListener('pointermove', move);
					document.removeEventListener('pointerup', up);
					self.normalizeStops();
				}
				document.addEventListener('pointermove', move);
				document.addEventListener('pointerup', up);
			},
			setStopColor(value) {
				const stop = this.selectedStop;
				if (!stop) return;
				const rgb = hexToRGB(value);
				stop.c = rgbToHex(rgb[0], rgb[1], rgb[2]);
			},
			setStopPos(value) {
				const stop = this.selectedStop;
				if (!stop) return;
				stop.p = clamp(Math.round(Number(value) * 1000) / 1000, 0, 1);
				this.normalizeStops();
			},
			useAppColor() {
				const stop = this.selectedStop;
				if (!stop) return;
				try {
					const hex = ColorPanel.get();
					if (hex) stop.c = new tinycolor(hex).toHexString();
				} catch (err) {
					Blockbench.showQuickMessage('No colour panel available', 1500);
				}
			},
			reverseEditor() {
				this.editor.stops = this.editor.stops
					.map(s => ({ p: Math.round((1 - s.p) * 1000) / 1000, c: s.c, a: s.a }))
					.sort((a, b) => a.p - b.p);
				this.editor.selected = clamp(this.editor.stops.length - 1 - this.editor.selected, 0, this.editor.stops.length - 1);
			},
			distributeEditor() {
				const stops = this.editor.stops.slice().sort((a, b) => a.p - b.p);
				// Hard steps read best as equal bands, blends want to span the full range.
				const divisor = this.editor.interpolation === 'step' ? stops.length : Math.max(1, stops.length - 1);
				stops.forEach((s, i) => { s.p = Math.round((i / divisor) * 1000) / 1000; });
				this.editor.stops = stops;
			},

			/* -------- preview -------- */
			schedulePreview() {
				scheduleLivePreview();
			}
		},
		mounted() { this.schedulePreview(); },
		updated() { this.schedulePreview(); },
		template: TEMPLATE
	};
}

function openDialogWindow() {
	if (!allTextures().length) {
		Blockbench.showQuickMessage('This project has no textures', 2000);
		return;
	}
	if (open_dialog) {
		try { open_dialog.delete(); } catch (err) { /* ignore */ }
		open_dialog = null;
	}

	state = makeState();
	dialog_active = true;

	open_dialog = new Dialog({
		id: 'gradient_map_layer_dialog',
		title: 'Gradient Map Layer',
		width: 880,
		buttons: ['Apply', 'Cancel'],
		confirmIndex: 0,
		cancelIndex: 1,
		// The default backdrop dims the viewport, which would misrepresent the
		// colours of the live preview on the model.
		darken: false,
		cancel_on_click_outside: false,
		component: buildComponent(),
		onConfirm() {
			let gradient = null;
			if (state.mode === 'editor') {
				gradient = commitEditorGradient(state);
			} else {
				gradient = (state.builtins.concat(state.library, state.orphans)).find(g => g.id === state.selected_id) || null;
			}
			if (!gradient) {
				Blockbench.showQuickMessage('Select a gradient map first', 2000);
				return false;   // keeps the dialog open
			}
			// Put the pixels back before the real edit, so undo captures the original.
			dialog_active = false;
			endLivePreview();
			try { localStorage.setItem(DATA_KEY + '.last_gradient', gradient.id); } catch (err) { /* ignore */ }

			const options = Object.assign({}, state.options);
			options.texture = allTextures().find(t => t.uuid === options.texture_id) || currentTexture();
			saveOptions(options);
			applyGradientMap(gradient, options);
		},
		onCancel() { dialog_active = false; endLivePreview(); }
	});
	open_dialog.show();
}

/* ============================== repeat ============================== */

function repeatLast() {
	if (!last_run) {
		openDialogWindow();
		return;
	}
	const gradient = BUILTINS.concat(loadLibrary()).find(g => g.id === last_run.gradient_id);
	if (!gradient) {
		Blockbench.showQuickMessage('The last gradient map no longer exists', 2000);
		openDialogWindow();
		return;
	}
	const options = Object.assign({}, last_run.options);
	options.texture = currentTexture();
	applyGradientMap(gradient, options);
}

/* ============================== plugin ============================== */

/**
 * Action.delete() takes a button out of the toolbars, but a menu keeps its own copy in
 * `structure`, so an action added with addAction stays in the menu after the plugin is
 * gone - a dead entry that opens nothing. Texture.prototype.menu and
 * TextureLayer.prototype.menu are shared singletons whose structure only ever grows, so
 * this matters most there.
 *
 * Written as a sweep over every menu this plugin might have touched rather than as a list
 * built during onload: splicing something that is not there is a no-op, so the sweep stays
 * correct if onload ever adds or drops a menu.
 */
function removeFromMenus() {
	const menus = [];
	try {
		if (typeof MenuBar !== 'undefined' && MenuBar.menus) {
			menus.push(MenuBar.menus.tools, MenuBar.menus.filter);
		}
	} catch (err) { /* ignore */ }
	try { if (typeof Texture !== 'undefined') menus.push(Texture.prototype.menu); } catch (err) { /* ignore */ }
	try { if (typeof TextureLayer !== 'undefined') menus.push(TextureLayer.prototype.menu); } catch (err) { /* ignore */ }

	for (const menu of menus) {
		if (!menu || !(menu.structure instanceof Array)) continue;
		for (const action of [action_apply, action_repeat]) {
			if (!action) continue;
			try {
				let index = menu.structure.indexOf(action);
				while (index !== -1) {
					menu.structure.splice(index, 1);
					index = menu.structure.indexOf(action);
				}
			} catch (err) { /* ignore */ }
		}
	}
}

Plugin.register(PLUGIN_ID, {
	title: 'Gradient Map Layer',
	icon: 'gradient',
	author: 'Quinten Bench',
	description: 'Colourise value maps with saved 256x16 gradient maps. The generated layer keeps following the greyscale layer it came from, and can be re-opened and re-edited at any time.',
	about: [
		'Adds "Gradient Map Layer" to the Tools menu, the texture menu and the layer menu.',
		'The result is previewed live on the model while the dialog is open, and cancelling puts the texture back untouched.',
		'A generated layer works like an adjustment layer: it re-renders live while you paint on the greyscale layer under it, in the same undo step as the stroke, and selecting it and reopening the dialog loads its gradient and settings again so it can be changed in place. Painting on the generated layer itself is blocked until you confirm a warning, so it cannot be scribbled on by accident.',
		'Gradient maps are stored as 256 x 16 pixel ramps and can be imported and exported as PNG, or imported straight from Photoshop .grd packs, and organised into groups that can be collapsed or hidden.'
	].join('\n\n'),
	tags: ['Texture', 'Paint', 'Color'],
	version: PLUGIN_VERSION,
	min_version: '4.8.0',
	variant: 'both',

	onload() {
		css_style = Blockbench.addCSS(CSS);

		action_apply = new Action('gradient_map_layer', {
			name: 'Gradient Map Layer...',
			description: 'Apply a saved gradient map over a value map as a new layer',
			icon: 'gradient',
			category: 'textures',
			condition: () => allTextures().length > 0,
			click() { openDialogWindow(); }
		});

		action_repeat = new Action('gradient_map_layer_repeat', {
			name: 'Repeat Gradient Map',
			description: 'Apply the last used gradient map again with the same settings',
			icon: 'repeat',
			category: 'textures',
			condition: () => allTextures().length > 0 && !!last_run,
			click() { repeatLast(); }
		});

		// Keep generated layers following their source layer.
		try { Blockbench.on('finish_edit', onFinishEdit); } catch (err) { /* ignore */ }
		try { Blockbench.on('init_edit', onInitEdit); } catch (err) { /* ignore */ }
		try { Blockbench.on('edit_texture', onEditTexture); } catch (err) { /* ignore */ }
		try { Blockbench.on('undo', onUndo); } catch (err) { /* ignore */ }
		try { Blockbench.on('redo', onRedo); } catch (err) { /* ignore */ }

		try { MenuBar.addAction(action_apply, 'tools'); } catch (err) { /* ignore */ }
		try { MenuBar.addAction(action_repeat, 'tools'); } catch (err) { /* ignore */ }
		try {
			if (typeof MenuBar !== 'undefined' && MenuBar.menus && MenuBar.menus.filter) {
				MenuBar.addAction(action_apply, 'filter');
			}
		} catch (err) { /* ignore */ }
		try { Texture.prototype.menu.addAction(action_apply); } catch (err) { /* ignore */ }
		try {
			if (typeof TextureLayer !== 'undefined' && TextureLayer.prototype.menu) {
				TextureLayer.prototype.menu.addAction(action_apply);
			}
		} catch (err) { /* ignore */ }
	},

	onunload() {
		dialog_active = false;
		endLivePreview();
		try { Blockbench.removeListener('finish_edit', onFinishEdit); } catch (err) { /* ignore */ }
		try { Blockbench.removeListener('init_edit', onInitEdit); } catch (err) { /* ignore */ }
		try { Blockbench.removeListener('edit_texture', onEditTexture); } catch (err) { /* ignore */ }
		try { Blockbench.removeListener('undo', onUndo); } catch (err) { /* ignore */ }
		try { Blockbench.removeListener('redo', onRedo); } catch (err) { /* ignore */ }
		clearTrailingSync();
		sync_cache.clear();
		if (paint_guard.dialog) { try { paint_guard.dialog.delete(); } catch (err) { /* ignore */ } paint_guard.dialog = null; }
		endPaintGuard();
		if (open_dialog) {
			try { open_dialog.delete(); } catch (err) { /* ignore */ }
			open_dialog = null;
		}
		removeFromMenus();
		if (action_apply) action_apply.delete();
		if (action_repeat) action_repeat.delete();
		if (css_style) css_style.delete();
		preview_cache.clear();
	}
});

})();
