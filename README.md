# opencode-duck-art

OpenCode plugin: **`/gen` command** and **`gen` tool** — artwork through
[Duck.ai](https://duck.ai) (free, no API key), saved straight into your project.

```
/gen landscape a ruined castle on a cliff at sunrise
```

## Install

```sh
opencode plugin add github:YOUR_USER/opencode-duck-art
```

Restart OpenCode (config-declared packages load at startup).

## How it works

Duck.ai has no image API: a local relay
([DuckAI2API](https://github.com/wuyouseo/DuckAI2API)) drives a real browser
for the anti-bot tokens and exposes an OpenAI-compatible endpoint. The first
`gen` installs it itself (clone → venv → pip → Chromium → start); `duck_setup`
does the same on demand (`force: true` redoes a broken install).

Needs `git` and Python 3.11+ on `PATH`. The relay lives in
`%LOCALAPPDATA%/opencode/duck-relay` (`~/.local/share/...` elsewhere).

## VPN pool (`duck_vpn` / `/duck-vpn`)

Duck.ai bans by IP. The plugin routes **only the relay's browser** through VPN
exits (own xray sidecar, happ app and system untouched); a ban auto-rotates to
the next exit inside the same `gen` call.

Setup: paste your happ subscription URL once (`/duck-vpn` guides you). Base64
and JSON (per-server xray configs) subscriptions work; undialable entries
(hysteria, …) are skipped. Secrets stay in the per-user data dir, never in the
repo. Extra actions: `status`, `test`, `switch-exit`, `refresh`, `off`.

The xray binary is reused from happ-desktop when present, else `PATH` or
`vpn.xrayPath` (`DUCK_VPN_XRAY`).

## Settings

`.opencode/duck-art.json`, re-read on every call — no restart needed:

```jsonc
{
  "defaultPreset": "landscape",
  "outputDir": "assets/generated",
  "presets": {
    "concept": { "size": "1536x1024", "n": 4, "dir": "assets/concepts" }
  },
  "vpn": { "poolSize": 4, "basePort": 11808 }
}
```

Presets (`square`, `landscape`, `portrait`, `icon`): `style` is appended to the
prompt. Requested sizes are composition hints — Duck.ai may return nearby ones.

## Caveats

- `ERR_BN_LIMIT` / `ERR_CHALLENGE`: pause and retry (or set up the VPN pool).
- ~25–45 seconds per batch.
- Driving duck.ai through a relay may violate their ToS — a dev tool, not a pipeline.

## License

MIT
