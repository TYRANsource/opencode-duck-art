/**
 * duck_vpn orchestration: clipboard collection, pool builds, relay `.env`
 * wiring and status. Relay process control itself (start/stop) stays in
 * `index.ts`, which owns the spawn code; this module only kills by port.
 */
import { spawn } from "node:child_process"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { extractShareLinks, parseShareLink, type ExitServer } from "./vpn-links.js"
import { loadSecrets, saveSecrets, vpnDir, type VpnSecrets } from "./vpn-store.js"
import {
  describeExits,
  findXray,
  pickPorts,
  portBusy,
  probeExit,
  startSidecar,
  stopSidecar,
} from "./vpn-xray.js"

export interface BuildOptions {
  poolSize: number
  basePort: number
  xrayPath?: string
  dir?: string
  progress?: (line: string) => Promise<void>
}

export interface BuiltPool {
  exits: ExitServer[]
  proxies: string[]
  ports: number[]
  /** Per-exit probe: latency ms, or -1 when the exit failed the probe. */
  probeMs: number[]
  skipped: string[]
}

/** `DUCKAI_PROXIES` pool currently stored for the relay (from saved ports). */
export async function readPoolProxies(dir: string = vpnDir()): Promise<string[]> {
  const secrets = await loadSecrets(dir)
  return secrets.ports.map((p) => `socks5://127.0.0.1:${p}`)
}

function readClipboard(): Promise<string> {
  return new Promise((resolve, reject) => {
    const command =
      process.platform === "win32"
        ? { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"] }
        : process.platform === "darwin"
          ? { cmd: "pbpaste", args: [] as string[] }
          : { cmd: "xclip", args: ["-o", "-selection", "clipboard"] }
    const child = spawn(command.cmd, command.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      out += String(chunk)
    })
    child.on("error", (error: Error) => reject(error))
    child.on("close", (code: number | null) => {
      if (code === 0) resolve(out)
      else reject(new Error(`clipboard read failed (exit ${code})`))
    })
  })
}

/**
 * Watch the clipboard until `need` valid share links arrive or the deadline
 * hits. The user clicks Share per server in happ; every new link is picked up
 * automatically, nothing is pasted anywhere by hand.
 */
export async function collectFromClipboard(
  need: number,
  timeoutSec: number,
  progress: (line: string) => Promise<void>,
): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()
  try {
    await readClipboard()
  } catch {
    throw new Error(
      process.platform === "linux"
        ? "cannot read the clipboard (need `xclip` on PATH)."
        : "cannot read the clipboard on this machine.",
    )
  }
  await progress(
    `Press Share on servers in happ (${need} needed) — picking links from the clipboard automatically...`,
  )
  const deadline = Date.now() + timeoutSec * 1000
  for (;;) {
    let text = ""
    try {
      text = await readClipboard()
    } catch {
      // Transient clipboard lock (another app holds it): keep waiting.
    }
    for (const link of extractShareLinks(text)) {
      if (seen.has(link)) continue
      seen.add(link)
      try {
        const parsed = parseShareLink(link)
        found.push(link)
        await progress(`Caught ${found.length}/${need}: ${parsed.tag} [${parsed.protocol}]`)
      } catch {
        await progress(`Skipped a clipboard link (unrecognized format, usually surrounding noise).`)
      }
      if (found.length >= need) return found
    }
    if (Date.now() >= deadline) {
      if (!found.length) {
        throw new Error(
          `caught no links in ${timeoutSec}s. Press Share on a server in happ and start collection again.`,
        )
      }
      await progress(`Time is up, taking what we have: ${found.length}.`)
      return found
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/** Validate links, start the sidecar, probe every exit. Throws on total failure. */
export async function buildPoolFromLinks(rawLinks: string[], opts: BuildOptions): Promise<BuiltPool> {
  const dir = opts.dir ?? vpnDir()
  const exits: ExitServer[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const raw of rawLinks) {
    const link = raw.trim()
    if (!link || seen.has(link)) continue
    seen.add(link)
    try {
      exits.push(parseShareLink(link))
    } catch (error) {
      skipped.push(`${link.slice(0, 60)}…: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (exits.length >= opts.poolSize) break
  }
  if (!exits.length) {
    throw new Error(
      "no link usable." + (skipped.length ? `\n- ${skipped.join("\n- ")}` : ""),
    )
  }
  const say = opts.progress ?? (async () => undefined)
  const xrayExe = await findXray(opts.xrayPath)
  await say(`xray: ${xrayExe}`)
  const ports = await pickPorts(opts.basePort, exits.length)
  const { proxies } = await startSidecar(xrayExe, exits, ports, dir, say)
  const probeMs: number[] = []
  const alive: number[] = []
  for (let i = 0; i < exits.length; i++) {
    try {
      const ms = await probeExit(ports[i])
      probeMs.push(ms)
      alive.push(i)
      await say(`exit ${i + 1} OK (${ms}ms): ${exits[i].tag}`)
    } catch (error) {
      probeMs.push(-1)
      await say(
        `exit ${i + 1} UNREACHABLE: ${exits[i].tag} (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }
  if (!alive.length) {
    await stopSidecar(dir)
    throw new Error("no exit reached duck.ai — check the servers in happ and retry.")
  }
  return { exits, proxies, ports, probeMs, skipped }
}

/** Persist pool links/ports into the secret store (mode + links). */
export async function rememberPool(
  mode: VpnSecrets["mode"],
  links: string[],
  ports: number[],
  subUrl: string | undefined,
  dir: string = vpnDir(),
): Promise<void> {
  const secrets = await loadSecrets(dir)
  await saveSecrets({ ...secrets, mode, links, ports, subUrl }, dir)
}

/** Add or replace the `DUCKAI_PROXIES=` line in the relay `.env` (backup once). */
export async function mergeRelayEnv(relayDir: string, proxies: string[]): Promise<void> {
  const envFile = join(relayDir, ".env")
  const line = `DUCKAI_PROXIES=${proxies.join(",")}`
  let current = ""
  try {
    current = await readFile(envFile, "utf8")
  } catch {
    await mkdir(relayDir, { recursive: true })
    await writeFile(envFile, `# written by opencode-duck-art (duck_vpn)\n${line}\n`, "utf8")
    return
  }
  try {
    await readFile(`${envFile}.vpn.bak`, "utf8")
  } catch {
    await writeFile(`${envFile}.vpn.bak`, current, "utf8")
  }
  const next = /^DUCKAI_PROXIES=/m.test(current)
    ? current.replace(/^DUCKAI_PROXIES=.*$/m, line)
    : current.replace(/\s*$/, "") + `\n${line}\n`
  await writeFile(envFile, next, "utf8")
}

/** Drop the `DUCKAI_PROXIES=` line from the relay `.env` (direct mode again). */
export async function removeRelayEnvProxies(relayDir: string): Promise<boolean> {
  const envFile = join(relayDir, ".env")
  let current: string
  try {
    current = await readFile(envFile, "utf8")
  } catch {
    return false
  }
  if (!/^DUCKAI_PROXIES=/m.test(current)) return false
  await writeFile(envFile, current.replace(/^DUCKAI_PROXIES=.*$/m, "").replace(/\n{3,}/g, "\n\n"), "utf8")
  return true
}

/** Parse the `DUCKAI_PROXIES=` line from the relay `.env`, if present. */
export async function readRelayEnvProxies(relayDir: string): Promise<string[]> {
  try {
    const current = await readFile(join(relayDir, ".env"), "utf8")
    const m = current.match(/^DUCKAI_PROXIES=(.*)$/m)
    if (!m) return []
    return m[1].split(",").map((s: string) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** PID listening on a TCP port (relay restart helper). Null when free/unknown. */
export async function pidOnPort(port: number): Promise<number | null> {
  if (process.platform === "win32") {
    const child = spawn("netstat", ["-ano"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    await new Promise<void>((resolve) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        out += String(chunk)
      })
      child.on("close", () => resolve())
      child.on("error", () => resolve())
    })
    for (const line of out.split("\n")) {
      const m = line.match(/TCP\s+[\d.:]+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
      if (m && Number(m[1]) === port) return Number(m[2])
    }
    return null
  }
  return new Promise((resolve) => {
    const child = spawn("lsof", ["-ti", `tcp:${port}`], { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      out += String(chunk)
    })
    child.on("close", (code: number | null) => {
      const pid = Number(out.trim().split(/\s+/)[0])
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null)
    })
    child.on("error", (_error: Error) => resolve(null))
  })
}

/** happ app detection: its xray inbound on the default local ports. */
export async function detectHapp(): Promise<{ inbound: boolean; ports: number[] }> {
  const ports: number[] = []
  for (const port of [10808, 10809]) {
    if (await portBusy(port)) ports.push(port)
  }
  return { inbound: ports.length > 0, ports }
}

/** Append-only debug log for the sidecar/pool lifecycle (user-data dir, not repo). */
export async function vpnLog(line: string, dir: string = vpnDir()): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, "vpn.log"), `${new Date().toISOString()} ${line}\n`, "utf8")
  } catch {
    // Logging never breaks the flow.
  }
}
