# Gradient Map Layer — notes for Claude

A Blockbench plugin that colourises a value map through a saved gradient ramp as a
layer that keeps following its source. `README.md` explains what it does for a user.
`RELEASING.md` is the authority on cutting a release, including the two pieces of
release wiring that are not finished yet. Read that before releasing anything; this
file is orientation.

**This plugin also ships inside `EGT-EmbodyTools`**, which splices four standalone
plugins into one file. This repo is the source of truth and the bundle holds a copy,
so a behaviour change here usually belongs in both places. `RELEASING.md` has the
procedure. It was the other way round until 2026-09-22: the tool had no repo, so the
bundle's `build/src` copy was the original. Old notes may still say so.

## Shape of the repo

| Path | What it is |
|---|---|
| `gradient_map_layer.js` | The plugin. One file, an IIFE ending in `Plugin.register`. This is what people install. |
| `module/gradient_map_layer.js` | **Generated.** The same code with the register block swapped for a loader interface, fetched at runtime by the EmbodyTools loader. `npm run build:module`. |
| `scripts/build_module.mjs` | The generator. `--check` fails if the committed module is not what the plugin builds, and the suite runs it, so the two cannot drift. |
| `package.json` | `version` mirrors `PLUGIN_VERSION`; the release script writes both. |
| `changelog.json` | **The only place release notes are written.** |
| `CHANGELOG.md` | Generated. Never hand-edit it; run `npm run changelog`. |
| `test/run_tests.js` | The suite. `npm test`. |
| `test/mock_blockbench.js` | A stand-in for the parts of Blockbench the plugin touches, copied from `EGT-EmbodyTools/test`. |
| `scripts/` | `release.mjs`, `changelog.mjs`, `discord_notify.mjs`. Generic across the four repos; keep them identical rather than improving one in place. |

## Things about this plugin worth knowing before changing it

**The version line is parsed by two things.** `scripts/release.mjs` and
`.github/workflows/release.yml` both match `^const PLUGIN_VERSION = '1.2.3';$`
anchored. It used to carry a trailing comment, which meant neither could find it.
Keep the line bare.

**Filename, plugin id and repo name are one thing.** Blockbench derives a
file-loaded plugin's id from its filename, and refuses to load it if the register
call disagrees. `gradient_map_layer.js` / `gradient_map_layer` are fixed. Renaming
either is user-visible: people must delete the old file or Blockbench runs both
copies and they fight. The repo is `EGT-GradientMaps`, which deliberately does not
have to match.

**It has no Blockbench settings.** Alone among the four, everything it remembers is
in localStorage under `gradient_map_layer.*`: the library, the groups, the options,
and which source layer each generated layer came from. That is deliberate, so this
copy and the one inside EmbodyTools share gradients and uninstalling either leaves
them alone. Do not "tidy" that into Settings, and do not clear it on unload.

**Generated layers are keyed by layer uuid.** That is the one hard dependency
between this plugin and Delta Layers: Delta restores a texture's layers under their
original uuids, which is what lets gradient links survive a save and reload. It also
means the link only survives on the same machine, since the memory is local. There is
a proposal to move that data into Delta's sidecar under a `plugin_data` namespace;
see the project doc.

**Unloading is the thing that breaks.** It adds two Actions to four different menus,
a stylesheet, and five Blockbench event listeners. `Action.delete()` does **not**
remove an entry from a menu's `structure` array, and `Texture.prototype.menu` and
`TextureLayer.prototype.menu` are shared singletons that only ever grow, so a leak
there survives a reload and leaves a dead entry that opens nothing. The suite is
built around exactly this: load, unload, load again, and check nothing doubled.

**The dialog needs Vue and is not covered.** It is only built on click, so the plugin
loads fine without it and the suite can run. The colour maths is not covered either.
Both are worth having and neither exists yet; do not read a green run as more than
"it loads and unloads cleanly".

## Testing

`npm test` runs `test/run_tests.js`, which needs the `canvas` devDependency, so
`npm install` first on a fresh clone. The mock loads the plugin the way Blockbench
does, with `new Function('requireNativeModule', 'require', code)`, so the file under
test is the file that ships.
