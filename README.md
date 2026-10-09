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

## VPN pool (`duck_vpn` / `/duck-vpn`)

Duck.ai bans by IP (`ERR_BN_LIMIT`, persistent). The plugin can route **only the
relay's browser** through VPN exits while the rest of the machine stays direct —
no system VPN changes, the happ app is never touched.

How: an own Xray-core sidecar (one local SOCKS inbound per exit, each pinned to
its own server) + `DUCKAI_PROXIES` pool in the relay. A ban on one exit
auto-rotates to the next **inside the same `gen` call** — nobody clicks anything.

Two setup modes (`/duck-vpn` guides through both):

1. **Subscription (easiest).** Paste your happ subscription URL once. The plugin
   fetches it as a happ client with a stable per-machine HWID, so re-fetches
   don't burn new device slots.
2. **Clipboard (device slots full).** The plugin watches the clipboard while you
   press Share on a few servers in happ — links are picked up automatically, no
   new device is registered on the panel, the pool builds itself.

```jsonc
// .opencode/duck-art.json
{
  "vpn": {
    "poolSize": 4, // exits in the pool (1..8)
    "basePort": 11808, // first local SOCKS port (happ's own 10808/10809 are skipped)
    "xrayPath": "C:/tools/xray.exe", // default: happ-desktop's bundled core, else PATH
    "collectTimeoutSec": 180
  }
}
```

The xray binary is reused from the happ-desktop install when present; otherwise
put [Xray-core](https://github.com/XTLS/Xray-core/releases) on `PATH` or point
`vpn.xrayPath` at it. Nothing else is downloaded.

Secrets (subscription URL, share links) live in the per-user data dir
(`%LOCALAPPDATA%/opencode/duck-vpn` on Windows,
`~/.local/share/opencode/duck-vpn` elsewhere) — never in the repo, never in
`duck-art.json`. Supported links: `vless://` (tcp/ws/grpc, tls/reality),
`vmess://`, `trojan://`, `ss://`. JSON-config subscriptions (one ready-made
xray config per server, the way happ panels serve them) are read directly —
entries xray cannot dial (hysteria, …) are skipped with a reason.

Other actions: `duck_vpn` → `status` (pool/sidecar/relay at a glance), `test`
(probe every exit against duck.ai), `switch-exit` (prefer one), `refresh`
(re-fetch the subscription), `off` (back to direct).

## Caveats

- Duck.ai rate-limits (`ERR_BN_LIMIT`) and can serve a CAPTCHA (`ERR_CHALLENGE`);
  retrying after a pause usually clears it.
- Roughly 25–45 seconds per batch.
- Driving duck.ai through a relay may violate their ToS — a free dev tool, not a
  production pipeline.

## License

MIT
