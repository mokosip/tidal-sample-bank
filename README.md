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
