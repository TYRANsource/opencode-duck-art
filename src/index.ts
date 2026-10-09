import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, extname, isAbsolute, join, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { type ExitServer } from "./vpn-links.js"
import {
  buildPoolFromExits,
  detectHapp,
  mergeRelayEnv,
  parseLinkPool,
  pidOnPort,
  readPoolProxies,
  readRelayEnvProxies,
  rememberPool,
  removeRelayEnvProxies,
  vpnLog,
  type BuildOptions,
} from "./vpn.js"
import { fetchSubscription } from "./vpn-sub.js"
import { loadSecrets, saveSecrets, vpnDir } from "./vpn-store.js"
import { portBusy, probeExit, stopSidecar, describeExits } from "./vpn-xray.js"

/**
 * opencode-duck-art — `gen` tool + `/gen` command that produce artwork through
 * Duck.ai and write it straight into the project.
 *
 * Duck.ai has no public image API: the picture is produced by the model's native
 * GenerateImage tool inside a normal chat turn and arrives as base64 in the SSE
 * stream. The request also needs anti-bot tokens minted by the live page JS, so a
 * plain curl to duck.ai cannot work. A local relay (DuckAI2API) drives a real
 * browser to obtain those tokens and exposes an OpenAI-compatible endpoint; this
 * plugin calls that relay, writes the bytes to disk and returns the image. When
 * the relay is missing, the first `gen` installs it itself (unless autoSetup is
 * off); `duck_setup` runs the same steps on demand.
 *
 * Everything project-specific lives in plugin options, so the same package works
 * in any repo: point `outputDir` / `presets` at your own art folders and recipes.
 */

/** A preset is a size + folder + style recipe. Presets are configured per project. */
export interface Preset {
  /** Composition hint passed to the relay: "1024x1024", "1536x1024" or "1024x1536". */
  size?: string
  /** How many variants a bare call produces. Clamped to 1..4. */
  n?: number
  /** Output folder, relative to the project root unless absolute. */
  dir?: string
  /** Style/recipe text appended to the user's prompt. */
  style?: string
}

export interface DuckArtOptions {
  /** DuckAI2API checkout. Env: DUCKAI_RELAY_DIR */
  relayDir?: string
  /** Env: DUCKAI_RELAY_PORT */
  relayPort?: number | string
  /** Full relay base URL; overrides relayPort. Env: DUCKAI_RELAY_URL */
  relayUrl?: string
  /** Spawn the relay when it is not answering. Default true. Env: DUCKAI_AUTO_START */
  autoStart?: boolean
  /**
   * Install the relay on the first `gen` call when it is missing. Default true.
   * The install takes a few minutes and downloads ~600 MB once. Env: DUCKAI_AUTO_SETUP
   */
  autoSetup?: boolean
  /** Chromium/Chrome binary for the relay. Env: DUCKAI_CHROME_PATH */
  chromePath?: string
  /** Duck.ai model id. Env: DUCKAI_IMAGE_MODEL */
  model?: string
  /** Root used to resolve relative preset/out paths. Defaults to the plugin location directory. */
  root?: string
  /** Where images go when neither `out` nor the preset says. Defaults to a temp folder. */
  outputDir?: string
  /** Set true to drop the generic built-in presets and keep only yours. */
  replacePresets?: boolean
  /** Your presets. Merged over the built-ins unless `replacePresets` is set. */
  presets?: Record<string, Preset>
  /** Preset used when the caller does not name one. Default "landscape". */
  defaultPreset?: string
  /** Attach the generated image to the conversation. Default true. */
  show?: boolean
  /** Register the /gen command. Default true. */
  command?: boolean
  /** VPN pool for the relay (own xray sidecar, happ-compatible). */
  vpn?: VpnSettings
  /** Register the /duck-vpn command. Default true. */
  vpnCommand?: boolean
  /** Log resolved settings to the OpenCode log on load. Default false. */
  debug?: boolean
}

/** Settings for the `duck_vpn` pool. Env overrides in parentheses. */
export interface VpnSettings {
  /** How many exits to keep in the pool. Default 4, clamped 1..8. (DUCK_VPN_POOL_SIZE) */
  poolSize?: number
  /** First local SOCKS port for the sidecar inbounds. Default 11808. (DUCK_VPN_BASE_PORT) */
  basePort?: number
  /** xray binary. Default: happ-desktop's bundled core on Windows, else PATH. (DUCK_VPN_XRAY) */
  xrayPath?: string
}

/** Generic fallbacks so the plugin is useful before any preset is configured. */
const BUILTIN_PRESETS: Record<string, Preset> = {
  square: { size: "1024x1024", n: 1 },
  landscape: { size: "1536x1024", n: 1 },
  portrait: { size: "1024x1536", n: 1 },
  icon: { size: "1024x1024", n: 2 },
}

/** A generation takes ~25s plus browser warmup; leave generous headroom. */
const GENERATION_TIMEOUT_MS = 240_000
const STARTUP_TIMEOUT_MS = 90_000
const MAX_VARIANTS = 4

let starting: Promise<boolean> | null = null

interface GeneratedImage {
  path: string
  mime: string
  revised?: string
}

/** Absolute paths WITHOUT an extension; the extension comes from the actual bytes. */
interface TargetPlan {
  bases: string[]
  /** Set when the caller's `out` already carried an extension. */
  forcedExt?: string
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "image"
  )
}

function clampCount(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, 1), MAX_VARIANTS)
}

/**
 * Slugify strips every non-latin character, so a Russian prompt collapses to a fragment
 * ("3D-арт" -> "3d") or to nothing at all. Fall back to the preset name when that happens.
 */
function safeSlug(prompt: string, preset: string): string {
  const slug = slugify(prompt)
  return slug.length >= 6 ? slug : preset
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).replace("T", "-")
}

/**
 * Decide where each variant lands.
 * `out` may be a folder or an explicit filename; a filename only makes sense for a
 * single variant, so multiple runs get `-1`, `-2`, ... before the extension.
 */
function planTargets(input: {
  out?: string
  dir?: string
  fallbackDir: string
  root: string
  count: number
  slug: string
  stamp: string
}): TargetPlan {
  const { out, dir, fallbackDir, root, count, slug, stamp } = input
  const absolute = (p: string) => (isAbsolute(p) ? p : resolve(root, p))

  let folder: string
  let forcedExt: string | undefined

  if (out) {
    const extension = extname(out)
    if (extension && /^\.[a-z0-9]{2,5}$/i.test(extension)) {
      forcedExt = extension
      const abs = absolute(out)
      folder = abs.slice(0, abs.length - extension.length)
      const file = abs.slice(abs.length - extension.length)
      const stem = file.slice(0, file.length - extension.length)
      if (count === 1) return { bases: [folder + stem], forcedExt }
      return {
        bases: Array.from({ length: count }, (_, i) => `${folder}-${i + 1}${stem}`),
        forcedExt,
      }
    }
    folder = absolute(out)
  } else {
    folder = dir ? absolute(dir) : fallbackDir
  }

  return {
    bases: Array.from({ length: count }, (_, i) =>
      join(folder, `${slug}-${stamp}${count > 1 ? `-${i + 1}` : ""}`),
    ),
  }
}

/**
 * Project-level settings file.
 *
 * Loading a package through config (`plugins: [{ package, options }]`) is resolved
 * when the OpenCode server starts, so a project that auto-discovers the plugin from
 * `.opencode/plugins/` has no way to hand it presets until a restart. This file is
 * that way. Explicit `ctx.options` still win over it.
 */
async function readProjectOptions(locationDirectory: string | undefined): Promise<DuckArtOptions> {
  if (!locationDirectory) return {}
  try {
    const parsed = JSON.parse(await readFile(join(locationDirectory, ".opencode", "duck-art.json"), "utf8")) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as DuckArtOptions
  } catch {
    // Missing or unparsable settings file simply means "use the defaults".
  }
  return {}
}

const REPO_URL = "https://github.com/wuyouseo/DuckAI2API.git"

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Default relay checkout: a per-user data folder, so nothing is written into a random
 * project directory. Point `relayDir` at an existing checkout to reuse it instead.
 */
function defaultRelayDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share")
  return join(base, "opencode", "duck-relay")
}

/**
 * Locate a Playwright-installed Chromium. The relay needs a real browser to mint
 * duck.ai's anti-bot tokens, and a machine may have no system Chrome or Edge at all.
 *
 * Version-pinned guesses rot every time Playwright updates, so scan the browser store
 * instead and take the newest `chromium-<rev>` build.
 */
const CHROMIUM_EXE: Record<string, string[]> = {
  win32: ["chrome-win/chrome.exe"],
  darwin: ["chrome-mac/Chromium.app/Contents/MacOS/Chromium"],
  linux: ["chrome-linux/chrome", "chrome-linux/chrome-headless-shell"],
}

function detectChromium(): string | null {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : null,
    process.env.APPDATA ? join(process.env.APPDATA, "ms-playwright") : null,
    join(homedir(), ".cache", "ms-playwright"),
  ].filter((p): p is string => Boolean(p))

  const candidates = CHROMIUM_EXE[process.platform] ?? CHROMIUM_EXE.linux
  for (const root of roots) {
    if (!existsSync(root)) continue
    const builds = readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    for (const build of builds) {
      for (const rel of candidates) {
        const exe = join(root, build, rel)
        if (existsSync(exe)) return exe
      }
    }
  }
  return null
}

function venvPython(relayDir: string): string {
  return process.platform === "win32"
    ? join(relayDir, ".venv", "Scripts", "python.exe")
    : join(relayDir, ".venv", "bin", "python")
}

interface StepOptions {
  cwd?: string
  signal?: AbortSignal
  /** @default 300000 */
  timeoutMs?: number
  onLine?: (line: string) => void
}

/**
 * Run one install step. pip and playwright stream thousands of lines, so the captured
 * output is capped and only every 8th line is forwarded as progress — enough to prove
 * the step is alive without flooding the transcript.
 */
function runStep(
  command: string,
  args: string[],
  opts: StepOptions = {},
): Promise<{ code: number; output: string }> {
  return new Promise((settle, reject) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener("abort", abort, { once: true })
    }
    const timer = setTimeout(abort, opts.timeoutMs ?? 300_000)

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        signal: controller.signal,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      clearTimeout(timer)
      reject(error)
      return
    }

    let output = ""
    let seen = 0
    const feed = (chunk: Buffer | string) => {
      const text = String(chunk)
      output = (output + text).slice(-8000)
      if (!opts.onLine) return
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line) continue
        if (++seen % 8 === 0) opts.onLine(line.slice(0, 160))
      }
    }
    child.stdout?.on("data", feed)
    child.stderr?.on("data", feed)

    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      settle({ code: code ?? -1, output })
    })
  })
}

export default Plugin.define({
  id: "duck-art",
  async setup(ctx) {
    /**
     * Settings are re-read on every call, not cached from load time. OpenCode only watches
     * `opencode.json(c)` for config changes: editing `.opencode/duck-art.json` alone does not
     * reload the plugin, so caching presets here would keep them stale until a restart.
     */
    const loadSettings = async (): Promise<DuckArtOptions> => ({
      ...(await readProjectOptions(ctx.location?.directory)),
      ...((ctx.options ?? {}) as DuckArtOptions),
    })

    /**
     * Resolve a value against the settings just read.
     *
     * Fallbacks stop at the *primitive* defaults, never at the load-time consts below. Those
     * consts are snapshots of the same settings, so falling back to one would resurrect a key
     * the user deleted from the file and keep it until the next reload.
     */
    const relayDirOf = (settings: DuckArtOptions): string =>
      settings.relayDir ?? process.env.DUCKAI_RELAY_DIR ?? defaultRelayDir()

    const options = await loadSettings()

    const RELAY_DIR = options.relayDir ?? process.env.DUCKAI_RELAY_DIR ?? defaultRelayDir()
    const RELAY_PORT = String(options.relayPort ?? process.env.DUCKAI_RELAY_PORT ?? "8181")
    const RELAY_URL = (options.relayUrl ?? process.env.DUCKAI_RELAY_URL ?? `http://127.0.0.1:${RELAY_PORT}`).replace(
      /\/+$/,
      "",
    )
    // Primitive defaults, shared by the load-time consts and the per-call resolution above.
    const MODEL_DEFAULT = "gpt-6-luna"
    const IMAGE_DIR_DEFAULT = join(tmpdir(), "opencode-duck-images")

    const AUTO_START = options.autoStart ?? process.env.DUCKAI_AUTO_START !== "0"
    const DEFAULT_MODEL = options.model ?? process.env.DUCKAI_IMAGE_MODEL ?? MODEL_DEFAULT
    // The relay is pointed at Playwright's Chromium when no system browser is available.
    // Re-resolved after duck_setup installs it, which is why this is mutable.
    let CHROME_PATH =
      options.chromePath ??
      process.env.DUCKAI_CHROME_PATH ??
      detectChromium() ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe"

    const ROOT = options.root ?? ctx.location.directory ?? process.cwd()
    const DEFAULT_OUT = options.outputDir ?? process.env.DUCKAI_IMAGE_DIR ?? IMAGE_DIR_DEFAULT

    const mergePresets = (settings: DuckArtOptions): Record<string, Preset> =>
      settings.replacePresets
        ? { ...(settings.presets ?? {}) }
        : { ...BUILTIN_PRESETS, ...(settings.presets ?? {}) }

    const pickDefaultPreset = (
      settings: DuckArtOptions,
      all: Record<string, Preset>,
      names: string[],
    ): string => (settings.defaultPreset && all[settings.defaultPreset] ? settings.defaultPreset : names[0] ?? "landscape")

    // Load-time copies, used to build the tool description (which can only change on reload).
    const presets = mergePresets(options)
    const presetNames = Object.keys(presets).sort()
    const DEFAULT_PRESET = pickDefaultPreset(options, presets, presetNames)

    const describePresets = presetNames.map((name) => {
      const p = presets[name]
      const bits = [p.size, p.n && p.n > 1 ? `${p.n} variants` : null, p.dir].filter(Boolean).join(", ")
      return bits ? `${name} (${bits})` : name
    })

    /** True when the relay answers and really is DuckAI2API (not some other service on the port). */
    async function relayReady(): Promise<boolean> {
      try {
        const health = await fetch(`${RELAY_URL}/health`, { signal: AbortSignal.timeout(3000) })
        if (!health.ok) return false
        const body = (await health.json().catch(() => null)) as { status?: string } | null
        if (!body || body.status !== "ok") return false
        // Other local services (e.g. an MCP server) also answer /health with status "ok",
        // so confirm the OpenAI-style model catalog before trusting the port.
        const models = await fetch(`${RELAY_URL}/v1/models`, { signal: AbortSignal.timeout(8000) })
        if (!models.ok) return false
        const catalog = (await models.json().catch(() => null)) as { object?: string } | null
        return catalog?.object === "list"
      } catch {
        return false
      }
    }

    /** Spawn the relay detached and wait until it serves traffic. */
    function startRelay(dir: string = RELAY_DIR): Promise<boolean> {
      if (starting) return starting
      starting = (async () => {
        // Stored VPN pool (if any): the relay reads DUCKAI_PROXIES at import,
        // so it must arrive through the environment, not just the `.env` file.
        let pool: string[] = []
        try {
          pool = await readPoolProxies()
        } catch {
          pool = []
        }
        try {
          const child = spawn(
            venvPython(dir),
            ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", RELAY_PORT, "--log-level", "warning"],
            {
              cwd: dir,
              detached: true,
              stdio: "ignore",
              env: {
                ...process.env,
                // duckai.py reads CHROME_PATH at import time, which happens before
                // load_dotenv() runs in main.py, so pass it through the environment.
                DUCKAI_CHROME_PATH: CHROME_PATH,
                DUCKAI_MODEL: DEFAULT_MODEL,
                DUCKAI_NEW_CHAT: "1",
                PYTHONIOENCODING: "utf-8",
                ...(pool.length ? { DUCKAI_PROXIES: pool.join(",") } : {}),
              },
            },
          )
          child.on("error", () => undefined)
          child.unref()
        } catch {
          return false
        }

        const deadline = Date.now() + STARTUP_TIMEOUT_MS
        while (Date.now() < deadline) {
          if (await relayReady()) return true
          await new Promise((r) => setTimeout(r, 1500))
        }
        return false
      })().finally(() => {
        starting = null
      })
      return starting
    }

    async function ensureRelay(dir: string = RELAY_DIR): Promise<string | null> {
      if (await relayReady()) return null
      if (!AUTO_START) return `relay not reachable at ${RELAY_URL}`
      if (!(await startRelay(dir))) return `relay failed to start (expected it at ${RELAY_URL}, dir ${dir})`
      return null
    }

    /**
     * Restart the relay so a changed `.env` (e.g. a new DUCKAI_PROXIES pool)
     * takes effect. Only kills the listener when it really is our relay
     * (relayReady verifies the DuckAI2API model catalog first).
     */
    async function restartRelay(dir: string = RELAY_DIR): Promise<boolean> {
      if (await relayReady()) {
        const port = Number(RELAY_PORT)
        if (Number.isInteger(port)) {
          const pid = await pidOnPort(port)
          if (pid !== null && pid > 0) {
            try {
              if (process.platform === "win32") {
                await runStep("taskkill", ["/PID", String(pid), "/F"], { timeoutMs: 15_000 })
              } else {
                process.kill(pid, "SIGTERM")
              }
            } catch {
              // The old instance may already be gone; starting covers it.
            }
            await new Promise((r) => setTimeout(r, 1000))
          }
        }
      }
      return startRelay(dir)
    }

    /** Resolve VPN pool settings against per-call settings (same no-cache rule). */
    const vpnOptsOf = (settings: DuckArtOptions): Required<Omit<VpnSettings, "xrayPath">> & { xrayPath?: string } => {
      const vpn = settings.vpn ?? {}
      const poolSize = Math.min(Math.max(Math.trunc(Number(vpn.poolSize ?? process.env.DUCK_VPN_POOL_SIZE ?? 4)) || 4, 1), 8)
      const basePort =
        Math.trunc(Number(vpn.basePort ?? process.env.DUCK_VPN_BASE_PORT ?? 11808)) || 11808
      return {
        poolSize,
        basePort,
        xrayPath: vpn.xrayPath ?? process.env.DUCK_VPN_XRAY ?? undefined,
      }
    }

    /**
     * One-shot installer: clone the relay, create its venv, install Python deps, fetch
     * Playwright's Chromium, write `.env`, then start and verify it. Every step is skipped
     * when it is already satisfied, so a second run costs a couple of seconds.
     */
    async function bootstrap(
      settings: DuckArtOptions,
      progress: (status: string) => Promise<void>,
      signal: AbortSignal,
      force: boolean,
      retryHint = "duck_setup",
    ): Promise<string[]> {
      const relayDir = relayDirOf(settings)
      const model = settings.model ?? process.env.DUCKAI_IMAGE_MODEL ?? MODEL_DEFAULT
      const done: string[] = []
      const step = (label: string, line?: string) =>
        line ? progress(`${label}: ${line}`) : progress(label)

      // 1. Toolchain. Report exactly what is missing instead of failing later with ENOENT.
      for (const tool of ["git", "python"] as const) {
        let probe: { code: number; output: string }
        try {
          probe = await runStep(tool, ["--version"], { signal, timeoutMs: 30_000 })
        } catch {
          throw new Error(
            `\`${tool}\` is not on PATH. Install ${tool === "git" ? "Git" : "Python 3.11+"} and run ${retryHint} again.`,
          )
        }
        if (probe.code !== 0) {
          throw new Error(
            `\`${tool} --version\` failed (exit ${probe.code}). ` +
              (tool === "python"
                ? `If this is the Microsoft Store stub, install the real Python 3.11+ and run ${retryHint} again.`
                : `Install Git and run ${retryHint} again.`),
          )
        }
      }

      // 2. Relay sources.
      if (!(await pathExists(join(relayDir, "main.py")))) {
        await step(`cloning ${REPO_URL} -> ${relayDir}`)
        const res = await runStep("git", ["clone", "--depth", "1", REPO_URL, relayDir], {
          signal,
          timeoutMs: 300_000,
        })
        if (res.code !== 0) throw new Error(`git clone failed: ${res.output.slice(-600)}`)
        done.push(`cloned ${REPO_URL}`)
      }

      const python = venvPython(relayDir)

      // 3. Virtualenv.
      if (force || !(await pathExists(python))) {
        await step("creating virtualenv (.venv)")
        const res = await runStep("python", ["-m", "venv", ".venv"], {
          cwd: relayDir,
          signal,
          timeoutMs: 300_000,
        })
        if (res.code !== 0) throw new Error(`python -m venv failed: ${res.output.slice(-600)}`)
        done.push("created .venv")
      }

      // 4. Python dependencies.
      const depsPresent = await runStep(
        python,
        ["-c", "import fastapi, uvicorn, dotenv, playwright"],
        { cwd: relayDir, signal, timeoutMs: 60_000 },
      ).then((r) => r.code === 0)

      if (force || !depsPresent) {
        await step("installing python dependencies", "fastapi, uvicorn, pydantic, playwright")
        const res = await runStep(python, ["-m", "pip", "install", "-r", "requirements.txt"], {
          cwd: relayDir,
          signal,
          timeoutMs: 900_000,
          onLine: (line) => void step("pip", line),
        })
        if (res.code !== 0) throw new Error(`pip install failed: ${res.output.slice(-800)}`)
        done.push("installed python dependencies")
      }

      // 5. Browser. The relay drives a real Chromium to mint duck.ai's anti-bot tokens.
      if (!existsSync(CHROME_PATH) || force) {
        await step("installing Playwright Chromium", "about 314 MB, first run only")
        const res = await runStep(python, ["-m", "playwright", "install", "chromium"], {
          cwd: relayDir,
          signal,
          timeoutMs: 900_000,
          onLine: (line) => void step("playwright", line),
        })
        if (res.code !== 0) throw new Error(`playwright install failed: ${res.output.slice(-800)}`)
        CHROME_PATH = detectChromium() ?? CHROME_PATH
        done.push(`installed Chromium (${CHROME_PATH})`)
      }

      // 6. Config. Only written when absent - never clobber someone's proxy pool or API key.
      const envFile = join(relayDir, ".env")
      if (!(await pathExists(envFile))) {
        await writeFile(
          envFile,
          [
            "# written by opencode-duck-art (duck_setup)",
            `DUCKAI_CHROME_PATH=${CHROME_PATH.replace(/\\/g, "/")}`,
            `DUCKAI_MODEL=${model}`,
            "DUCKAI_NEW_CHAT=1",
            `PORT=${RELAY_PORT}`,
            "",
          ].join("\n"),
          "utf8",
        )
        done.push("wrote .env")
      }

      // 7. Start and verify.
      const problem = await ensureRelay(relayDir)
      if (problem) throw new Error(problem)
      done.push(`relay healthy at ${RELAY_URL}`)

      return done
    }

    /** POST the prompt, then write each returned image to its planned path. */
    async function requestImages(
      prompt: string,
      model: string,
      n: number,
      size: string | undefined,
      plan: TargetPlan,
      signal: AbortSignal,
      progress: (status: string) => Promise<void>,
    ): Promise<GeneratedImage[]> {
      const res = await fetch(`${RELAY_URL}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, n, size, response_format: "b64_json" }),
        signal,
      })

      const payload = (await res.json().catch(() => null)) as
        | { data?: Array<{ b64_json?: string; revised_prompt?: string }>; detail?: unknown }
        | null

      if (!res.ok) {
        const detail = payload?.detail ? JSON.stringify(payload.detail) : `HTTP ${res.status}`
        throw new Error(`relay rejected the request: ${detail}`)
      }

      const items = payload?.data ?? []
      if (!items.length) throw new Error("relay returned no image data")

      const out: GeneratedImage[] = []
      for (let i = 0; i < items.length; i++) {
        const b64 = items[i].b64_json
        if (!b64) throw new Error("image entry had no b64_json payload")
        const raw = Buffer.from(b64, "base64")
        const mime = raw[0] === 0xff && raw[1] === 0xd8 ? "image/jpeg" : "image/png"
        const ext = plan.forcedExt ?? (mime === "image/jpeg" ? ".jpg" : ".png")
        const path = `${plan.bases[i] ?? plan.bases[0]}${ext}`
        await mkdir(join(path, ".."), { recursive: true })
        await writeFile(path, raw)
        await progress(`saved ${i + 1}/${items.length} -> ${path}`)
        out.push({ path, mime, revised: items[i].revised_prompt })
      }
      return out
    }

    interface GenInput {
      prompt?: string
      preset?: string
      n?: number
      size?: string
      out?: string
      model?: string
      show?: boolean
    }

    async function run(
      input: GenInput,
      progress: (status: string) => Promise<void>,
      signal: AbortSignal,
    ): Promise<{
      files: GeneratedImage[]
      preset: string
      model: string
      elapsed: number
      showDefault: boolean
    }> {
      const prompt = (input.prompt ?? "").trim()
      if (!prompt) throw new Error("prompt is required")

      // Re-read settings here: OpenCode does not reload the plugin when this project's
      // settings file changes, so caching presets at setup time would make edits inert.
      const settings = await loadSettings()
      const livePresets = mergePresets(settings)
      const liveNames = Object.keys(livePresets).sort()
      const liveDefault = pickDefaultPreset(settings, livePresets, liveNames)
      const relayDir = relayDirOf(settings)

      const presetName = (input.preset ?? "").trim() || liveDefault
      const preset = livePresets[presetName]
      if (!preset) throw new Error(`unknown preset "${presetName}". Available: ${liveNames.join(", ")}`)

      const size = input.size || preset.size
      const n = clampCount(input.n, preset.n ?? 1)
      const model = (input.model ?? "").trim() || (settings.model ?? process.env.DUCKAI_IMAGE_MODEL ?? MODEL_DEFAULT)
      const fullPrompt = preset.style ? `${prompt}\n\nStyle: ${preset.style}` : prompt

      const unavailable = await ensureRelay(relayDir)
      if (unavailable) {
        const autoSetup = settings.autoSetup ?? process.env.DUCKAI_AUTO_SETUP !== "0"
        if (!autoSetup) {
          throw new Error(
            `${unavailable}.\n` +
              `Auto-setup is off. Run the \`duck_setup\` tool to install and start it automatically ` +
              `(clones ${REPO_URL}, creates .venv, installs requirements.txt and Playwright Chromium, then starts the relay).\n` +
              `Or start an existing install by hand:\n` +
              `  cd ${relayDir} && "${venvPython(relayDir)}" -m uvicorn main:app --host 127.0.0.1 --port ${RELAY_PORT}`,
          )
        }
        // First run on a fresh machine: install the relay right here so one `gen`
        // call is enough from prompt to picture. Resumable - a retry continues.
        await progress("relay not found - installing it now (a few minutes, ~600 MB download, first run only)...")
        try {
          await bootstrap(settings, progress, signal, false, "gen")
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`${message}\nFix the cause and call \`gen\` again - setup resumes where it stopped.`)
        }
      }

      // Resolve the destination before the request so the folder exists when bytes arrive.
      const plan = planTargets({
        out: input.out,
        dir: preset.dir,
        fallbackDir: settings.outputDir ?? process.env.DUCKAI_IMAGE_DIR ?? IMAGE_DIR_DEFAULT,
        root: settings.root ?? ctx.location.directory ?? process.cwd(),
        count: n,
        slug: safeSlug(prompt, presetName),
        stamp: timestamp(),
      })
      await mkdir(join(plan.bases[0], ".."), { recursive: true })

      const started = Date.now()
      await progress(`generating ${n} image(s), preset "${presetName}"${size ? ` @ ${size}` : ""}...`)
      const files = await requestImages(fullPrompt, model, n, size, plan, signal, progress)
      return {
        files,
        preset: presetName,
        model,
        elapsed: (Date.now() - started) / 1000,
        showDefault: settings.show ?? true,
      }
    }

    const presetList = describePresets.join("; ")

    if (options.debug) {
      console.log(
        `[duck-art] root=${ROOT} relay=${RELAY_URL} presets=${presetNames.join(",")} ` +
          `default=${DEFAULT_PRESET} out=${DEFAULT_OUT}`,
      )
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "gen",
        description:
          "Generate artwork with Duck.ai (free, no API key) and write it straight into the project. " +
          "Pick a preset for size/folder/style and pass a plain-English visual description as `prompt`. " +
          `Presets: ${presetList}. ` +
          "When the local relay is missing, the first call installs it automatically (a few minutes), " +
          "unless autoSetup is off. Takes roughly 25-45 seconds per batch.",
        input: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "What the image should show. Be concrete about subject, style, lighting and framing.",
            },
            preset: {
              type: "string",
              description:
                `Preset controlling size, output folder and style recipe. Default "${DEFAULT_PRESET}". ` +
                `Available: ${presetNames.join(", ")}.`,
            },
            n: {
              type: "integer",
              description: `How many variants to generate (1-${MAX_VARIANTS}). Defaults to the preset's count.`,
              minimum: 1,
              maximum: MAX_VARIANTS,
            },
            size: {
              type: "string",
              description:
                'Overrides the preset size: "1024x1024", "1536x1024" (landscape) or "1024x1536" (portrait).',
            },
            out: {
              type: "string",
              description:
                "Output folder or explicit filename. Relative paths resolve from the project root and " +
                "override the preset folder.",
            },
            model: { type: "string", description: "Duck.ai model id. Defaults to the configured model." },
            show: { type: "boolean", description: "Attach the generated images to the conversation. Default true." },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const input = raw as GenInput
          const progress = async (status: string) => {
            await context.progress({ status })
          }

          try {
            const result = await run(input, progress, context.signal)
            const show = input.show ?? result.showDefault
            const summary =
              `Generated ${result.files.length} image(s) with Duck.ai "${result.model}" in ` +
              `${result.elapsed.toFixed(1)}s (preset "${result.preset}").\n` +
              result.files.map((f, i) => `${i + 1}. ${f.path}`).join("\n") +
              (result.files[0]?.revised ? `\nModel's rewritten prompt: ${result.files[0].revised}` : "")

            return {
              content: [
                { type: "text", text: summary },
                ...(show
                  ? result.files.map((f) => ({
                      type: "file" as const,
                      uri: pathToFileURL(f.path).href,
                      mime: f.mime,
                      name: basename(f.path),
                    }))
                  : []),
              ],
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (context.signal.aborted) return { content: [{ type: "text", text: "Generation cancelled." }] }
            // The rate-limit remedy only helps when duck.ai itself answered back.
            const upstream = /ERR_[A-Z_]+|CAPTCHA|relay rejected|relay returned|fetch failed|HTTP \d{3}/.test(
              message,
            )
            let vpnHint = ""
            if (upstream) {
              try {
                const pool = await readPoolProxies()
                vpnHint = pool.length
                  ? `\nVPN pool active (${pool.length} exit(s), rotation on ban is automatic). ` +
                    `If every exit is banned, run the \`duck_vpn\` tool (test / refresh).`
                  : `\nNo VPN pool configured. If duck.ai is blocked here or bans this IP, run the ` +
                    `\`duck_vpn\` tool — \`/duck-vpn\` walks through setup (paste the subscription URL once).`
              } catch {
                vpnHint = ""
              }
            }
            return {
              content: [
                {
                  type: "text",
                  text:
                    `ERROR: ${message}\n` +
                    (upstream
                      ? `Duck.ai rate-limits with ERR_BN_LIMIT and can serve a visual CAPTCHA (ERR_CHALLENGE); ` +
                        `retrying after a pause usually clears it.`
                      : "") +
                    vpnHint,
                },
              ],
            }
          }
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "duck_setup",
        description:
          "Install and start the local Duck.ai relay that `gen` depends on (DuckAI2API). " +
          "Idempotent: skips anything already present, so a second run takes a couple of seconds. " +
          "Installs to the configured relayDir, creating the repo, a Python virtualenv, the packages " +
          "in requirements.txt, Playwright's Chromium browser (~314 MB) and a .env, then starts the " +
          "relay and waits until it answers. Needs git and Python 3.11+ on PATH. " +
          "`gen` runs these same steps itself when the relay is missing; call this to pre-install, " +
          "repair a half-broken install (force), or reinstall.",
        input: {
          type: "object",
          properties: {
            force: {
              type: "boolean",
              description:
                "Redo every step even if it looks satisfied: recreate the virtualenv and reinstall " +
                "dependencies and Chromium. Use when an install is half-broken.",
            },
          },
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const input = raw as { force?: boolean }
          const progress = async (status: string) => {
            await context.progress({ status })
          }

          // Re-read so a relayDir edited after load is honoured without a restart.
          const settings = await loadSettings()
          const relayDir = relayDirOf(settings)

          try {
            await progress(`installing relay into ${relayDir}`)
            const done = await bootstrap(settings, progress, context.signal, input.force === true)
            const work = done.filter((line) => !line.startsWith("relay healthy"))
            const text =
              work.length === 0
                ? `Relay already installed and healthy at ${RELAY_URL} (${relayDir}).`
                : `Relay ready at ${RELAY_URL}:\n- ${done.join("\n- ")}\n\nRelay dir: ${relayDir}`
            return { content: [{ type: "text", text }] }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (context.signal.aborted) {
              return { content: [{ type: "text", text: "Setup cancelled." }] }
            }
            return {
              content: [
                {
                  type: "text",
                  text:
                    `ERROR: relay setup failed: ${message}\n` +
                    `Target: ${relayDir}\n` +
                    `Every step is resumable - run duck_setup again after fixing the reported cause.`,
                },
              ],
            }
          }
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "duck_vpn",
        description:
          "Own VPN pool for the Duck.ai relay (happ-compatible, no system VPN changes). " +
          "Actions: status | setup-subscription | build-pool | test | switch-exit | refresh | off. " +
          "Builds a local xray sidecar (one SOCKS inbound per exit, happ app untouched) and points the relay at it, " +
          "so ban/limit on one exit auto-rotates to the next. Secrets stay in the user-data dir, never in the repo.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description:
                "status: show pool/sidecar/relay state. setup-subscription: build from a happ subscription URL " +
                "(pass `url`; without it returns the ask-the-user text). build-pool: rebuild from the stored " +
                "servers. test: probe every exit. switch-exit: prefer exit `index` (1-based). refresh: re-fetch " +
                "the subscription and rebuild. off: stop the sidecar, relay goes direct again.",
            },
            url: { type: "string", description: "happ subscription URL (setup-subscription only)." },
            index: {
              type: "integer",
              description: "1-based exit number (switch-exit only).",
              minimum: 1,
            },
          },
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const input = raw as {
            action?: string
            url?: string
            index?: number
          }
          const progress = async (status: string) => {
            await context.progress({ status })
          }
          const fail = (text: string) => ({ content: [{ type: "text" as const, text }] })
          const action = (input.action ?? "status").trim() || "status"

          try {
            const settings = await loadSettings()
            const vpnOpts = vpnOptsOf(settings)
            const relayDir = relayDirOf(settings)
            const dir = vpnDir()
            const buildOpts: BuildOptions = {
              poolSize: vpnOpts.poolSize,
              basePort: vpnOpts.basePort,
              xrayPath: vpnOpts.xrayPath,
              dir,
              progress,
            }

            /** Build sidecar + wire relay, shared by every setup path. */
            const buildFlow = async (
              exits: ExitServer[],
              skipped: string[],
              mode: "subscription" | "links",
              subUrl: string | undefined,
              linksToStore: string[],
            ): Promise<string> => {
              if (context.signal.aborted) throw new Error("cancelled")
              const built = await buildPoolFromExits(exits, buildOpts)
              const allSkipped = [...skipped, ...built.skipped]
              await rememberPool(mode, linksToStore.slice(0, linksToStore.length), built.exits, built.ports, subUrl, dir)
              await mergeRelayEnv(relayDir, built.proxies)
              await vpnLog(`pool built (${mode}): ${built.exits.length} exits`, dir)
              if (context.signal.aborted) throw new Error("cancelled")
              const restarted = await restartRelay(relayDir)
              const lines = [
                `VPN pool ready: ${built.exits.length} exit(s), relay ${restarted ? "restarted with the pool" : "restart FAILED — rerun the action"}.`,
                ...describeExits(built.exits, built.ports).map(
                  (d, i) => `  ${d} — probe ${built.probeMs[i] === -1 ? "FAILED" : `${built.probeMs[i]}ms`}`,
                ),
              ]
              if (allSkipped.length) {
                lines.push(`Skipped ${allSkipped.length} server(s):`)
                for (const s of allSkipped.slice(0, 5)) lines.push(`  - ${s}`)
              }
              lines.push("Ban/limit on one exit now auto-rotates to the next inside the same `gen` call.")
              return lines.join("\n")
            }

            /** Summarize a fetched subscription (either shape) for progress. */
            const describeSub = (
              sub: { links: string[]; entries: { tag: string }[]; skipped: string[]; isJson: boolean; title: string | null; userinfo: string | null },
            ): string => {
              const count = sub.isJson ? sub.entries.length : sub.links.length
              return (
                `subscription OK: ${count} server(s)` +
                (sub.title ? ` (${sub.title})` : "") +
                (sub.userinfo ? ` [${sub.userinfo}]` : "") +
                (sub.skipped.length ? `, skipped ${sub.skipped.length}` : "")
              )
            }

            if (action === "status") {
              const secrets = await loadSecrets(dir)
              const happ = await detectHapp()
              const envProxies = await readRelayEnvProxies(relayDir)
              const relayUp = await relayReady()
              const alivePorts: number[] = []
              for (const p of secrets.ports) {
                if (await portBusy(p)) alivePorts.push(p)
              }
              const lines = [
                `mode: ${secrets.mode ?? "not configured"}` +
                  (secrets.updatedAt ? ` (updated ${secrets.updatedAt.slice(0, 16).replace("T", " ")})` : ""),
                `sidecar: ${alivePorts.length}/${secrets.ports.length} inbound(s) answering` +
                  (alivePorts.length ? ` (${alivePorts.join(", ")})` : ""),
                `relay ${RELAY_URL}: ${relayUp ? "up" : "down"}, .env pool: ${envProxies.length} exit(s)`,
                `happ app local inbound: ${happ.inbound ? `yes (${happ.ports.join(", ")})` : "no"}`,
              ]
              if (secrets.exits.length && secrets.ports.length) {
                lines.push("exits:")
                for (const d of describeExits(
                  secrets.exits.slice(0, secrets.ports.length).map((e) => ({
                    tag: e.tag,
                    protocol: e.protocol as ExitServer["protocol"],
                    host: e.host,
                    port: e.port,
                    link: "",
                    outbound: e.outbound,
                  })),
                  secrets.ports,
                )) {
                  lines.push(`  ${d}`)
                }
              } else if (secrets.exits.length || secrets.links.length) {
                lines.push("servers stored but pool not built — run build-pool.");
              } else {
                lines.push("no servers stored — run setup-subscription.");
              }
              return fail(lines.join("\n"))
            }

            if (action === "setup-subscription") {
              const url = (input.url ?? "").trim()
              if (!url) {
                return fail(
                  "ASK_USER: need the happ subscription URL (paste once, it is stored in the local user-data dir, never in the repo).",
                )
              }
              const secrets = await loadSecrets(dir)
              await progress("fetching the subscription...")
              const sub = await fetchSubscription(url, secrets.hwid)
              await progress(describeSub(sub))
              if (sub.isJson) {
                if (!sub.entries.length) {
                  return fail(
                    "no usable exits in this subscription." +
                      (sub.skipped.length ? `\n- ${sub.skipped.slice(0, 8).join("\n- ")}` : ""),
                  )
                }
                const exits: ExitServer[] = sub.entries.slice(0, vpnOpts.poolSize).map((e) => ({
                  tag: e.tag,
                  protocol: e.protocol as ExitServer["protocol"],
                  host: e.host,
                  port: e.port,
                  link: "",
                  outbound: e.outbound,
                }))
                return fail(await buildFlow(exits, sub.skipped, "subscription", url, []))
              }
              const { exits, skipped } = parseLinkPool(sub.links, vpnOpts.poolSize)
              if (!exits.length) {
                return fail("no usable exits in this subscription." + (skipped.length ? `\n- ${skipped.slice(0, 8).join("\n- ")}` : ""))
              }
              return fail(await buildFlow(exits, skipped, "subscription", url, sub.links))
            }

            if (action === "build-pool") {
              const secrets = await loadSecrets(dir)
              if (!secrets.exits.length) {
                return fail("no stored servers: run setup-subscription first.")
              }
              const exits: ExitServer[] = secrets.exits.slice(0, vpnOpts.poolSize).map((e) => ({
                tag: e.tag,
                protocol: e.protocol as ExitServer["protocol"],
                host: e.host,
                port: e.port,
                link: "",
                outbound: e.outbound,
              }))
              return fail(await buildFlow(exits, [], secrets.mode ?? "links", secrets.subUrl, secrets.links))
            }

            if (action === "test") {
              const secrets = await loadSecrets(dir)
              if (!secrets.exits.length || !secrets.ports.length) {
                return fail("pool not built — run setup-subscription first.")
              }
              const lines: string[] = []
              const count = Math.min(secrets.exits.length, secrets.ports.length)
              for (let i = 0; i < count; i++) {
                const tag = secrets.exits[i].tag
                const up = await portBusy(secrets.ports[i])
                if (!up) {
                  lines.push(`${i + 1}. ${tag}: inbound down`)
                  continue
                }
                try {
                  const ms = await probeExit(secrets.ports[i])
                  lines.push(`${i + 1}. ${tag}: OK (${ms}ms to duck.ai)`)
                } catch (error) {
                  lines.push(`${i + 1}. ${tag}: FAIL (${error instanceof Error ? error.message : String(error)})`)
                }
              }
              return fail(lines.join("\n"))
            }

            if (action === "switch-exit") {
              const secrets = await loadSecrets(dir)
              const idx = Math.trunc(Number(input.index)) || 0
              if (!secrets.exits.length || idx < 1 || idx > Math.min(secrets.exits.length, secrets.ports.length)) {
                return fail("pass a valid 1-based `index` (see status for the exit list).")
              }
              const order = secrets.exits.map((_, i) => i)
              order.sort((a, b) => (a === idx - 1 ? -1 : b === idx - 1 ? 1 : a - b))
              const exits = order.map((i) => secrets.exits[i])
              const ports = order.map((i) => secrets.ports[i])
              await saveSecrets({ ...secrets, exits, ports }, dir)
              await mergeRelayEnv(relayDir, ports.map((p) => `socks5://127.0.0.1:${p}`))
              const restarted = await restartRelay(relayDir)
              return fail(`exit ${idx} is now preferred. Relay ${restarted ? "restarted" : "restart FAILED"}.`)
            }

            if (action === "refresh") {
              const secrets = await loadSecrets(dir)
              if (secrets.mode !== "subscription" || !secrets.subUrl) {
                return fail("nothing to refresh (no subscription stored — run setup-subscription).")
              }
              await progress("re-fetching the subscription...")
              const sub = await fetchSubscription(secrets.subUrl, secrets.hwid)
              await progress(describeSub(sub))
              if (sub.isJson) {
                if (!sub.entries.length) return fail("no usable exits in this subscription anymore.")
                const exits: ExitServer[] = sub.entries.slice(0, vpnOpts.poolSize).map((e) => ({
                  tag: e.tag,
                  protocol: e.protocol as ExitServer["protocol"],
                  host: e.host,
                  port: e.port,
                  link: "",
                  outbound: e.outbound,
                }))
                return fail(await buildFlow(exits, sub.skipped, "subscription", secrets.subUrl, []))
              }
              const { exits, skipped } = parseLinkPool(sub.links, vpnOpts.poolSize)
              if (!exits.length) return fail("no usable exits in this subscription anymore.")
              return fail(await buildFlow(exits, skipped, "subscription", secrets.subUrl, sub.links))
            }

            if (action === "off") {
              const stopped = await stopSidecar(dir)
              const secrets = await loadSecrets(dir)
              await saveSecrets({ ...secrets, ports: [] }, dir)
              await removeRelayEnvProxies(relayDir)
              const restarted = await restartRelay(relayDir)
              await vpnLog("pool disabled (off)", dir)
              return fail(
                `VPN pool off${stopped ? " (sidecar stopped)" : ""}. Relay ${restarted ? "restarted direct" : "restart FAILED"}. Stored servers are kept — build-pool re-enables.`,
              )
            }

            return fail(`unknown action "${action}". Use: status | setup-subscription | build-pool | test | switch-exit | refresh | off.`)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (context.signal.aborted || message === "cancelled") {
              return fail("VPN setup cancelled.")
            }
            try {
              await vpnLog(`ERROR (${action}): ${message}`)
            } catch {
              // Logging never breaks the flow.
            }
            return fail(`ERROR: ${message}`)
          }
        },
      })
    })

    if (options.vpnCommand !== false) {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "duck-vpn",
          description: "VPN pool for the Duck.ai relay: /duck-vpn [status|off|test]",
          execute: async ({ sessionID, prompt, delivery }) => {
            const raw = (prompt?.text ?? "").trim().toLowerCase()
            const action = raw.split(/\s+/)[0] || "guide"
            if (action === "status" || action === "off" || action === "test" || action === "refresh") {
              await ctx.session.prompt({
                sessionID,
                delivery,
                text:
                  `Run the \`duck_vpn\` tool once with action "${action}" and report the result briefly.\n\n` +
                  `Rules:\n` +
                  `- Do not print secrets (subscription URL, full links, passwords). Exit tags and ports are fine.\n` +
                  `- If the result asks for a subscription URL, relay that request to the user and stop.`,
              })
              return
            }
            await ctx.session.prompt({
              sessionID,
              delivery,
              text:
                `Set up the VPN pool with the \`duck_vpn\` tool:\n\n` +
                `1. Start with action "status" to avoid redoing a working pool.\n` +
                `2. Call action "setup-subscription" without a url. It returns an ask-the-user text — ` +
                `relay that to the user, wait for the URL, then call again with it.\n\n` +
                `Rules:\n` +
                `- Never print secrets. Never write the URL into the repo.\n` +
                `- If the panel answers 404 (device slots full), say so and stop.`,
            })
          },
        })
      })
    }

    if (options.command !== false) {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "gen",
          description: "Generate artwork into the project with Duck.ai: /gen [preset] <description>",
          execute: async ({ sessionID, prompt, delivery }) => {
            const raw = (prompt?.text ?? "").trim()
            if (!raw) {
              await ctx.session.prompt({
                sessionID,
                delivery,
                text:
                  `/gen needs a description. Usage: /gen [preset] <what the image should show>\n` +
                  `Presets: ${presetNames.join(", ")}.`,
              })
              return
            }

            await ctx.session.prompt({
              sessionID,
              delivery,
              text:
                `Create artwork with the \`gen\` tool. Do it in one call.\n\n` +
                `Request: ${raw}\n\n` +
                `Rules:\n` +
                `- Preset: use one named in the request, otherwise pick the closest from ` +
                `${presetNames.join(", ")} (default ${DEFAULT_PRESET}).\n` +
                `- Pass the whole request as \`prompt\`, expanded into a concrete visual description ` +
                `(subject, pose, lighting, framing) using what you know about this project.\n` +
                `- Do not crop, edit or re-save the file; the tool already writes it to the right folder.`,
            })
          },
        })
      })
    }
  },
})
