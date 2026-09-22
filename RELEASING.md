# Releasing

The version lives in exactly one place, `const PLUGIN_VERSION` in
`gradient_map_layer.js`. The plugin registration reads it rather than repeating the
number, and `scripts/release.mjs` matches that line whole, so keep it bare: no
trailing comment.

There is no build step, so cutting a release is the build.

## One command

```sh
npm run release -- <major|minor|patch> --title "Short release name" \
  --added "..." --fixed "..." --changed "..."
```

That runs the suite, bumps the version in the plugin and in `package.json`, inserts
the `changelog.json` entry, commits `vX.Y.Z: <title>`, tags `vX.Y.Z` and pushes.
Tests run before anything is written, so a failing suite leaves the working tree
untouched. The tree has to be clean first.

Flags: `--dry-run` to preview the commit and tag, `--no-push` to push by hand,
`--notes <file.json>` for long entries, and `--removed` / `--safeguards` alongside
the other category flags. All the category flags are repeatable.

Pushing the tag is what publishes. `.github/workflows/release.yml` reruns the suite,
refuses if the tag disagrees with `PLUGIN_VERSION`, publishes a GitHub release whose
body is that version's `changelog.json` entry with the plugin and `changelog.json`
attached, then posts that entry to Discord.

Bump by what changed: `patch` for a fix with no new behaviour, `minor` for new
behaviour or a new option, `major` for a change that breaks existing gradients,
existing generated layers, or the shape of what is stored under
`gradient_map_layer.*`. Repo-only changes such as CI, README or scripts get a plain
commit: no version, no tag, no changelog entry. The version belongs to the plugin,
not to the repo.

## Two things not finished yet

**No Discord forum thread.** The other three plugins each post into their own thread
in `#addons`, set as `DISCORD_THREAD_ID` in the `env:` block of `release.yml`. This
one is empty, and `discord_notify.mjs` leaves `thread_id` off the webhook call when
it is, so a release posts to the channel rather than failing. Create the forum post,
put its id in that block, and it lands in the right place.

**No icon.** `PLUGIN_ICON_URL` is what the Discord post uses as its avatar. Add
`gradient_map_layer_icon.png` to the repo root and point the env at its raw URL.

## Changelog voice

`changelog.json` is the only place release notes are written. Blockbench's Changelog
tab, `CHANGELOG.md`, the GitHub release page and the Discord post all render from it,
so they cannot drift. Regenerate `CHANGELOG.md` with `npm run changelog`; never edit
it directly.

Say what the user sees, not what the code did. "A generated layer now reloads its own
gradient when you reopen the dialog" beats "fixed uuid lookup in loadLayerMemory".
Plain words, no em-dashes. Categories, in order: Added, Changed, Fixed, Removed,
Safeguards.

Anything touching what is kept under `gradient_map_layer.*` deserves a line of its
own, because the library is shared with the copy inside EmbodyTools and people will
want to know whether their gradients still load.

## This plugin also ships inside EmbodyTools

`EGT-EmbodyTools` splices the four standalone plugins into one file. **This repo is
the source of truth**; the bundle's `build/src/gradient_map_layer.js` is a copy.
After releasing here, update the bundle: copy the released file into its `build/src`,
fix the `Was: gradient_map_layer <version>` line in `build/frame/00_head.js`, run
`npm run build` there and read the diff.

The bundle's own module interface lives in `build/frame/49_gradient_close.js`. It is
this plugin's `Plugin.register` block reshaped so the bundle can start and stop it on
its own, and the build cannot check it, so when `onload` or `onunload` changes here
that file needs the same change by hand.

`module/gradient_map_layer.js` is a third form: the same code with the register block
replaced by a loader interface, fetched at runtime by the EmbodyTools loader from this
repo's raw URL. It is listed in `EGT-EmbodyTools/loader/registry.json`. Pushing to
`main` here changes what people load on their next Blockbench start, so `main` is
production and there is no staging step.

## Pushing

On David's machine git uses the Windows credential manager, so `npm run release`
pushes without any extra setup.

From a shell that has no stored credential, a fine-grained token scoped to this one
repository can sit at `.git/egt-push-token`, which `release.mjs` reads automatically.
Anything under `.git` is untracked, so it can never be committed. Create it at
github.com/settings/personal-access-tokens with Contents write, and write it with

```sh
printf '%s' 'github_pat_...' > .git/egt-push-token
```

Never write that token into `.git/config`, a tracked file, a project doc or a chat.
`git push -u` writes the URL you pushed to into `.git/config`, token and all, so
avoid `-u` when pushing through one.

## Line endings

Git stores every file here as LF. A clone on Windows with the default
`core.autocrlf=true` checks them out as CRLF, which is fine for this repo but has
bitten `EGT-EmbodyTools`, whose build matched on LF. If you add a script that matches
on line starts or ends, normalise what you read.
