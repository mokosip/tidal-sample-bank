# samplebank

A local web tool to browse, audition, tag and add TidalCycles/SuperDirt samples: a fast
keyboard list, a sound map (similar sounds sit close together), and drag-and-drop upload
that SuperDirt loads live.

## Run

```sh
cd ~/tidal/samplebank && uv run python -m samplebank
```

Open http://localhost:57150. Previews play through SuperDirt (orbit 12), so start
SuperCollider/SuperDirt first; the page reconnects by itself.

**One-time:** reboot SuperCollider once after installing. `startup.scd` now loads
`~/tidal/samples/*` and defines the `/samplebank/load` OSCdef that loads uploaded banks
without a SuperDirt restart.

## Where things live

- Samples read from Dirt-Samples and `~/tidal/dub/sounds` (read-only).
- Your own samples: `~/tidal/samples/<bank>/` — uploads land here, converted to WAV.
- Your edits (type, tags, star): `~/tidal/samples/samplebank.json`.
- Analysis cache and map layout: `~/tidal/samples/.samplebank-cache.json` (safe to delete).

## Adding samples

Drop files or folders anywhere on the page (or click **+ add**), name the bank, Enter.
Bank names: lowercase letters, digits, `_`. Names of Dirt/dub banks are refused with a
`<name>_mine` suggestion. Non-WAV/AIFF audio is converted with ffmpeg.

## Trim on upload

Keep only the part of a long recording you like. After you name the bank, every file
longer than 4 s gets a trim step ("file 1 of 3: name (40.3 s)"); shorter files are added
whole, but each file in the list has a **trim** button that opens its step anyway.

In a trim step, drag on the waveform to select (the selection loops right away), drag
the edges to adjust, click to play from a point.

| key | |
|---|---|
| `⏎` | keep the selection, next file |
| `space` | loop on / off |
| `←` `→` / `⇧←` `⇧→` | nudge start / end by 10 ms (`alt`: 1 ms) |
| `z` | zoom to selection / whole file |
| `f` | edge fades on / off |
| `esc` | cancel the whole upload |

The readout shows start, end and length in seconds with 3 decimals (millisecond resolution) because nudging goes down to 1 ms.

Buttons: **back**, **keep whole file**, **skip this file**. After the last file the
batch is saved. If the bank name clashes, only the name is asked again; your selections
are kept.

- **Fades:** 5 ms fade-in and fade-out on the cut edges, on by default, so pieces don't
  click in Tidal. The loop plays with the same fades, so the saved file is what you
  heard (a soft dip at the loop seam is expected). "Keep whole file" never fades.
- **Output:** trimmed pieces are saved as `.wav` at the source's sample rate and channels.
- **Headphones:** the loop plays in the browser through the system output, not through
  SuperDirt, so use headphones or check which device macOS plays to.
- Dropped files are staged in a temp folder (`SAMPLEBANK_STAGING_DIR`, default
  `$TMPDIR/samplebank-staging`) until you save or cancel; it is also cleared on server start.

## Keys

| list | map |
|---|---|
| `j` `k` move + play | hover play, click select |
| `space` replay | `space` replay |
| `y` copy `s "bank:n"` | `r` reset view, drag pan, wheel zoom |
| `f` star, `t` tags, `1`…`0` `-` set type | same |
| `/` search, `m` `l` map / list | same |

## Tests

```sh
uv run pytest
node --test 'tests/js/*.test.mjs'
```
