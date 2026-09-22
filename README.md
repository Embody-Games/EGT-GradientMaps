# Gradient Map Layer

A Blockbench plugin that colourises a value or luminance map through a saved gradient ramp, as a layer that keeps following the layer it came from.

Written by Quinten Bench.

The idea is that the greyscale stays the thing you paint and the colour is a view of it, the way an adjustment layer works in an image editor. Paint on the value layer and the coloured layer under your cursor updates as you go, in the same undo step as the stroke.

## Install

1. Download `gradient_map_layer.js`.
2. In Blockbench: **File > Plugins > Load Plugin from File**, and pick it.

Keep the filename as-is. Blockbench takes a side-loaded plugin's id from its filename, so renaming the file registers it as a different plugin and you end up running two copies that fight.

Requires Blockbench 4.8.0 or newer. Works in both the web and desktop builds.

## What it does

**Gradient maps as layers.** Pick a value map and a gradient, and the result arrives as a new layer above it rather than painted over your work. The original greyscale is untouched and stays editable.

**The layer keeps following its source.** Paint on the greyscale and the coloured layer re-renders live, in the same undo step. Select a generated layer and reopen the dialog and it loads back the gradient and settings it was made with, so it can be changed in place instead of redone.

**Live preview on the model.** The result is shown on the model while the dialog is open, and cancelling puts the texture back exactly as it was.

**A gradient library you build up.** Gradients are 256 by 16 pixel ramps. Import and export them as PNG, import Photoshop `.grd` packs whole, and sort them into groups that collapse and hide.

**Guard against painting on the result.** Painting on a generated layer is blocked until you confirm a warning, so a coloured layer does not get scribbled on by accident and then silently overwritten on the next re-render.

## Where to find it

"Gradient Map Layer..." appears in the **Tools** menu, the **Filter** menu, a texture's right-click menu and a layer's right-click menu. **Repeat Gradient Map** applies the last one again with the same settings.

## Where it keeps things

Everything it remembers lives in your browser or app local storage under `gradient_map_layer.*`: the library, the groups, the dialog options, and which source layer each generated layer came from.

Two consequences worth knowing. This copy and the copy inside [EmbodyTools](https://github.com/Embody-Games/EGT-EmbodyTools) share the same storage, so you can switch between them without losing your gradients, and uninstalling either one leaves the library alone. And because the memory is local, a model opened on another machine brings back the generated layer as a plain layer: the pixels are there, the link to its source is not. Export the gradients you care about if they need to travel.

## Also in EmbodyTools

This plugin ships on its own here, and also inside EmbodyTools alongside Delta Layers, Anchored Stretch and UnLeaky Layers. Run one or the other, not both.

## Licence

MIT. See `LICENSE`.
