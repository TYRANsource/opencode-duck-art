/**
 * duck_vpn orchestration: pool builds, relay `.env`
 * wiring and status. Relay process control itself (start/stop) stays in
 * `index.ts`, which owns the spawn code; this module only kills by port.
 */
import { spawn } from "node:child_process"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseShareLink, type ExitServer } from "./vpn-links.js"
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

/** Validate raw share links into exits (at most `poolSize`), collecting skip reasons. */
export function parseLinkPool(
  rawLinks: string[],
  poolSize: number,
): { exits: ExitServer[]; skipped: string[] } {
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
    if (exits.length >= poolSize) break
  }
  return { exits, skipped }
}

/** Validate links, start the sidecar, probe every exit. Throws on total failure. */
export async function buildPoolFromLinks(rawLinks: string[], opts: BuildOptions): Promise<BuiltPool> {
  const { exits, skipped } = parseLinkPool(rawLinks, opts.poolSize)
  if (!exits.length) {
    throw new Error("no link usable." + (skipped.length ? `\n- ${skipped.join("\n- ")}` : ""))
  }
  const built = await buildPoolFromExits(exits, opts)
  return { ...built, skipped: [...skipped, ...built.skipped] }
}

/** Start the sidecar for ready exits and probe each one. Throws on total failure. */
export async function buildPoolFromExits(exits: ExitServer[], opts: BuildOptions): Promise<BuiltPool> {
  const dir = opts.dir ?? vpnDir()
  const bounded = exits.slice(0, opts.poolSize)
  if (!bounded.length) throw new Error("no exits to build the pool from.")
  const say = opts.progress ?? (async () => undefined)
  const xrayExe = await findXray(opts.xrayPath)
  await say(`xray: ${xrayExe}`)
  const ports = await pickPorts(opts.basePort, bounded.length)
  const { proxies } = await startSidecar(xrayExe, bounded, ports, dir, say)
  const probeMs: number[] = []
  const alive: number[] = []
  for (let i = 0; i < bounded.length; i++) {
    try {
      const ms = await probeExit(ports[i])
      probeMs.push(ms)
      alive.push(i)
      await say(`exit ${i + 1} OK (${ms}ms): ${bounded[i].tag}`)
    } catch (error) {
      probeMs.push(-1)
      await say(
        `exit ${i + 1} UNREACHABLE: ${bounded[i].tag} (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }
  if (!alive.length) {
    await stopSidecar(dir)
    throw new Error("no exit reached duck.ai — check the servers in happ and retry.")
  }
  return { exits: bounded, proxies, ports, probeMs, skipped: [] }
}

/** Persist pool links/exits/ports into the secret store (mode + links). */
export async function rememberPool(
  mode: VpnSecrets["mode"],
  links: string[],
  exits: ExitServer[],
  ports: number[],
  subUrl: string | undefined,
  dir: string = vpnDir(),
): Promise<void> {
  const secrets = await loadSecrets(dir)
  await saveSecrets(
    {
      ...secrets,
      mode,
      links,
      exits: exits.map((e) => ({
        tag: e.tag,
        protocol: e.protocol,
        host: e.host,
        port: e.port,
        outbound: e.outbound,
      })),
      ports,
      subUrl,
    },
    dir,
  )
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
