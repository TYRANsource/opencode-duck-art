# opencode-duck-art

OpenCode plugin that adds a **`gen` tool** and a **`/gen` command**: generate artwork through
[Duck.ai](https://duck.ai) (free, no API key) and write it straight into your project's asset
folder instead of dropping a loose image in the chat.

```
/gen concept a ruined castle on a cliff at sunrise, storm clouds
```

The model picks the preset, calls `gen` once, and the PNG lands in the folder that preset is
configured for.

---

## Why it exists

Duck.ai has no public image API. The picture is produced by the model's native `GenerateImage`
tool inside a normal chat turn, arrives as base64 in the SSE stream, and the request needs
anti-bot tokens minted by the live page JS — so a plain `curl` to `duck.ai` cannot work.

This plugin calls a local [DuckAI2API](https://github.com/wuyouseo/DuckAI2API) relay, which drives
a real browser to obtain those tokens and exposes an OpenAI-compatible endpoint. The `duck_setup`
tool installs the relay if it is not there yet, and starts it whenever it is not answering.

---

## Install

Pick one:

```sh
# from a Git host (recommended for sharing)
opencode plugin add github:YOUR_USER/opencode-duck-art

# from npm
opencode plugin add opencode-duck-art

# local checkout -> use the shim described under "Local checkout" below
```

Then put your settings in **`.opencode/duck-art.json`** (see [Settings](#settings)).

> **Why a settings file and not `options` in `opencode.json`?** Declaring a package through
> `plugins: [{ package, options }]` is resolved when the OpenCode *server starts*. A config edit
> reloads the discovered plugins under `.opencode/` but does not pull in a newly declared package,
> so `ctx.options` is empty until you restart OpenCode (v2.0.25, verified). Keep your settings in
> `.opencode/duck-art.json` instead: `gen` and `duck_setup` re-read that file **on every call**, so
> saving an edit is enough — no reload, no restart. `ctx.options` is still read and still wins over
> the file if you prefer the blessed form and don't mind a restart to add it.

⚠️ If you add the package to `plugins` in config, **do not** also keep a copy under
`.opencode/plugins/`, or `gen` and `/gen` get registered twice.

### Local checkout (what this repo's own dogfood uses)

`opencode plugin add` on v2.0.25 rejects local paths (`must be an npm registry package or Git
package specifier`), and config-declared packages only load at startup. So the working local setup
is a one-line shim that auto-discovery picks up:

```
.opencode/
├── duck-art.json          # your settings
└── plugins/
    └── duck-art/
        └── index.ts       # export { default } from "<path-to-checkout>/src/index.ts"
```

Auto-discovered `.ts` plugins hot-reload on save, which is what you want while developing. The
shim is machine-specific, so a repo you share with others should either use a git submodule at
`.opencode/plugins/duck-art` or have each person run
`opencode plugin add github:YOUR_USER/opencode-duck-art`.

---

## Settings

`.opencode/duck-art.json`, next to your plugins directory. Plain JSON, merged *under* any explicit
`ctx.options`:

```jsonc
{
  "defaultPreset": "concept",
  "outputDir": "assets/generated",
  "root": "C:/path/to/your/project",   // defaults to the plugin's location directory
  "presets": { "/* see below */": {} }
}
```

Everything in the [Options](#options) table is accepted here.

---

## Prerequisites: the relay

The plugin is only the client. Duck.ai has no public API, so something local has to drive a real
browser to mint the anti-bot tokens — that means a Python environment and a Chromium build
(~314 MB). The relay is [DuckAI2API](https://github.com/wuyouseo/DuckAI2API).

**You do not have to install it by hand.** Run the `duck_setup` tool once — ask the model for it, or
let it run automatically when `gen` reports the relay is missing:

```
duck_setup
```

It performs, in order:

| Step | What it does |
| --- | --- |
| 1 | Probes `git` and `python`, and names the missing one instead of failing with `ENOENT` |
| 2 | Clones DuckAI2API into `relayDir` (shallow, `--depth 1`) |
| 3 | Creates `.venv` |
| 4 | `pip install -r requirements.txt` (fastapi, uvicorn, pydantic, python-dotenv, playwright) |
| 5 | `playwright install chromium` if no browser is found |
| 6 | Writes `.env` **only if absent** — an existing proxy pool or API key is never clobbered |
| 7 | Starts the relay and waits until `GET /v1/models` answers |

Every step is skipped when already satisfied, so a second run takes a couple of seconds. Pass
`force: true` to redo a half-broken install (recreates the venv and reinstalls everything).

Requirements: `git` and Python 3.11+ on `PATH`. Default install location is
`%LOCALAPPDATA%/opencode/duck-relay` (or `~/.local/share/opencode/duck-relay` on Linux/macOS),
unless you set `relayDir`.

### Manual install

```sh
git clone https://github.com/wuyouseo/DuckAI2API
cd DuckAI2API
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\playwright install chromium
```

If you have no system Chrome, point the relay at Playwright's Chromium (the plugin detects it
automatically, scanning `ms-playwright/chromium-*` so it survives Playwright upgrades):

```
DUCKAI_CHROME_PATH=%LOCALAPPDATA%\ms-playwright\chromium-<rev>\chrome-win\chrome.exe
```

The plugin polls `GET /health` **and** `GET /v1/models` before trusting the port, because other
local services can answer `/health` with `{"status":"ok"}` too.

---

## Options

All options are optional.

| Option | Default | Purpose |
| --- | --- | --- |
| `relayDir` | per-user `opencode/duck-relay` | DuckAI2API checkout |
| `relayPort` | `8181` | Relay port |
| `relayUrl` | `http://127.0.0.1:<relayPort>` | Full base URL, overrides `relayPort` |
| `autoStart` | `true` | Spawn the relay when it is not answering |
| `chromePath` | Playwright Chromium | Browser for the relay |
| `model` | `gpt-6-luna` | Duck.ai model id |
| `root` | plugin location dir | Base for relative preset/`out` paths |
| `outputDir` | temp folder | Fallback folder when no preset/`out` says |
| `presets` | `{}` | Your presets, merged over the built-ins |
| `replacePresets` | `false` | Drop the built-in presets entirely |
| `defaultPreset` | `landscape` | Preset used when the caller names none |
| `show` | `true` | Attach the image to the conversation |
| `command` | `true` | Register `/gen` |

Environment variables `DUCKAI_RELAY_DIR`, `DUCKAI_RELAY_PORT`, `DUCKAI_RELAY_URL`,
`DUCKAI_AUTO_START`, `DUCKAI_CHROME_PATH`, `DUCKAI_IMAGE_MODEL` and `DUCKAI_IMAGE_DIR` work as
fallbacks; explicit options win.

> **Live vs. load-time.** The settings file is re-read on every `gen` / `duck_setup` call, so
> `presets`, `replacePresets`, `defaultPreset`, `outputDir`, `root`, `show`, `relayDir` and `model`
> take effect on save — including when you *delete* a key, because the fallbacks go to the
> built-in defaults rather than to a snapshot taken at load time.
> `relayPort`, `relayUrl`, `autoStart` and `chromePath` are fixed when the plugin loads: the port
> and the browser belong to the relay process. The preset list shown in the `gen` description is
> built at load time too, so touch the plugin file (or run `opencode service restart`) after
> adding or renaming presets — the tool will happily use a preset that is not listed yet.

---

## Presets

Built-ins are generic so the plugin works out of the box: `square` (1024×1024), `landscape`
(1536×1024), `portrait` (1024×1536), `icon` (1024×1024, 2 variants).

A preset is a size, a folder and a style recipe:

`.opencode/duck-art.json`:

```jsonc
{
  "defaultPreset": "concept",
  "presets": {
    "concept": {
      "size": "1536x1024",
      "n": 4,
      "dir": "assets/concepts"
    },
    "banner": {
      "size": "1536x1024",
      "n": 2,
      "dir": "store/banner",
      "style": "Wide store banner: the subject on the right, the left half kept calm and open for a logo. No text, no letters, no watermark, no UI."
    },
    "emote": {
      "size": "1024x1024",
      "n": 4,
      "dir": "assets/emotes",
      "style": "Flat vector sticker on a solid background, bold silhouette, thick outlines. No text, no letters, no watermark."
    }
  }
}
```

`style` is appended to the caller's prompt, so the caller writes *what* to draw and the preset
decides *how it should look and where it goes*.

---

## Tools

### `gen`

One call, one batch.

| Field | Type | Notes |
| --- | --- | --- |
| `prompt` | string, required | Plain-English visual description |
| `preset` | string | Defaults to `defaultPreset` |
| `n` | integer 1-4 | Defaults to the preset's `n` |
| `size` | string | Overrides the preset size |
| `out` | string | Folder **or** filename; relative paths resolve from `root` |
| `model` | string | Overrides the configured model |
| `show` | boolean | Attach the image to the conversation (default `true`) |

The extension is chosen from the actual bytes, not from `out`, so a PNG is never written with a
`.jpg` name.

### Writing into a game project

Relative `dir`/`out` paths resolve from the plugin's location directory (for an auto-discovered
plugin, the project root), or from `root` if you set it. Point `root` at your Unity/Godot/Unreal
checkout and everything else follows:

```jsonc
{ "root": "C:/path/to/your/project", "outputDir": "assets/generated" }
```

Unity generates the `.meta` for a new PNG on its next focus, so no extra step is needed.

### `duck_setup`

Installs and starts the relay described in [Prerequisites](#prerequisites-the-relay).

| Field | Type | Notes |
| --- | --- | --- |
| `force` | boolean | Redo every step even if it looks satisfied |

Idempotent and safe to call whenever `gen` cannot reach the relay. Returns a list of what it
actually did, or `Relay already installed and healthy` when there was nothing to do. Long steps
(venv, pip, Chromium) report progress as they run and honour cancellation.

---

## Roadmap

- Post-processing passes (crop to store sizes, chroma-key the preset background).
- Per-preset filename templates.

Contributions welcome — see [Contributing](#contributing).

---

## Caveats

- Duck.ai rate-limits with `ERR_BN_LIMIT` and can serve a visual CAPTCHA (`ERR_CHALLENGE`).
  Retrying after a pause usually clears it.
- A generation takes roughly 25-45 seconds per batch.
- Driving duck.ai through a relay is against their Terms of Service and can get an IP or
  fingerprint banned. This is a free dev tool, not a production pipeline.

---

## Contributing

The wrapper is meant to be forked and improved.

1. Fork and clone: `git clone https://github.com/YOUR_USER/opencode-duck-art`
2. Point your project at your checkout with the one-line shim (see
   [Local checkout](#local-checkout-what-this-repos-own-dogfood-uses)), or register the package in
   config and restart OpenCode if you would rather use `ctx.options`.
3. Edit `src/index.ts`. Auto-discovered plugins hot-reload on save, so changes show up on the next
   tool call. If you registered the package through config instead, run `opencode service restart`.
4. Keep project-specific recipes in `.opencode/duck-art.json`, not in `src/`. Presets belong to the
   project; the engine belongs to the package.
5. Open a PR.

Ideas worth having: image post-processing, a `variants` strategy that retries only failed slots,
health diagnostics that explain *why* the relay is down.

## License

MIT
