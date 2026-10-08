# opencode-duck-art

OpenCode plugin: **`/gen` command** and **`gen` tool** — generate artwork through
[Duck.ai](https://duck.ai) (free, no API key) and save it straight into your project
instead of dropping a loose image in the chat.

```
/gen landscape a ruined castle on a cliff at sunrise
```

The model picks the preset, calls `gen` once, and the image lands in the configured folder.

## Install

```sh
opencode plugin add github:YOUR_USER/opencode-duck-art
```

Then restart OpenCode (config-declared packages load at startup).

## How it works

Duck.ai has no public image API, so the plugin talks to a local relay —
[DuckAI2API](https://github.com/wuyouseo/DuckAI2API) — which drives a real browser
to mint the anti-bot tokens and exposes an OpenAI-compatible endpoint.

**You install nothing by hand.** The first `gen` detects a missing relay and sets it
up itself (clone → venv → pip → Chromium → start). Afterwards it's just
prompt → picture. Set `autoSetup: false` to turn this off; the `duck_setup` tool
runs the same steps manually, and accepts `force: true` to redo a half-broken install.

## Dependencies

- `git` and Python 3.11+ on `PATH` (checked automatically, the missing one is named)
- [DuckAI2API](https://github.com/wuyouseo/DuckAI2API) — cloned automatically into
  `%LOCALAPPDATA%/opencode/duck-relay` (`~/.local/share/opencode/duck-relay` on Linux/macOS),
  or wherever `relayDir` points
- Playwright Chromium (~500 MB with dependencies) — downloaded automatically when
  no browser is found
- npm: `@opencode/plugin` (comes with the package)

## Settings (optional)

`.opencode/duck-art.json` in your project, re-read on every call — no restart needed:

```jsonc
{
  "defaultPreset": "landscape",
  "outputDir": "assets/generated",
  "autoSetup": true, // first gen installs the relay itself
  "presets": {
    "concept": { "size": "1536x1024", "n": 4, "dir": "assets/concepts" }
  }
}
```

Built-ins: `square`, `landscape`, `portrait`, `icon`. A preset's `style` text is appended
to the prompt, so the caller writes *what* to draw and the preset decides *how and where*.
(Duck.ai may return a slightly different size than requested.)

## Caveats

- Duck.ai rate-limits (`ERR_BN_LIMIT`) and can serve a CAPTCHA (`ERR_CHALLENGE`);
  retrying after a pause usually clears it.
- Roughly 25–45 seconds per batch.
- Driving duck.ai through a relay may violate their ToS — a free dev tool, not a
  production pipeline.

## License

MIT
