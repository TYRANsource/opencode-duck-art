/**
 * Own Xray-core sidecar: one local SOCKS inbound per exit, each pinned to its
 * own outbound server. The happ app is never touched: its TUN/system proxy
 * keep serving the rest of the machine while only the relay's browser traffic
 * goes through these inbounds.
 *
 * The binary is reused from the happ-desktop install when present
 * (`C:\Program Files\FlyFrogLLC\Happ\core\xray.exe`); otherwise the error
 * tells the user where to get Xray-core. No new runtime dependency is
 * downloaded by the plugin itself.
 */
import { spawn } from "node:child_process"
import * as net from "node:net"
import { access, constants, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ExitServer } from "./vpn-links.js"
import { sidecarConfigPath, sidecarPidPath, vpnDir } from "./vpn-store.js"

export interface PoolBuild {
  /** `socks5://127.0.0.1:PORT` entries for DUCKAI_PROXIES, same order as exits. */
  proxies: string[]
  ports: number[]
}

const HAPP_XRAY_WIN = "C:\\Program Files\\FlyFrogLLC\\Happ\\core\\xray.exe"

/** Locate a usable xray binary. Throws with install hints when none is found. */
export async function findXray(explicit?: string): Promise<string> {
  const candidates = [
    explicit?.trim() || "",
    process.env.DUCK_VPN_XRAY?.trim() || "",
    ...(process.platform === "win32" ? [HAPP_XRAY_WIN] : []),
  ].filter(Boolean)
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK)
      return path
    } catch {
      // Try the next candidate.
    }
  }
  // Last resort: something named xray on PATH.
  const probe = process.platform === "win32" ? "where" : "which"
  try {
    const found = await runCapture(probe, ["xray"], 10_000)
    const first = found.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
    if (first) return first
  } catch {
    // Nothing on PATH either.
  }
  throw new Error(
    "no xray binary found. Install happ-desktop (its core is reused automatically) " +
      "or put Xray-core from https://github.com/XTLS/Xray-core/releases on PATH, " +
      "or point `vpn.xrayPath` / DUCK_VPN_XRAY at the binary.",
  )
}

function runCapture(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("timed out"))
    }, timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => {
      out += String(chunk)
    })
    child.on("error", (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code: number | null) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`exit ${code}`))
    })
  })
}

/** True when something already listens on the port. */
export function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.end()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })
}

/** Wait until the SOCKS inbound answers (or throw after the deadline). */
async function waitPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await portBusy(port)) return
    if (Date.now() >= deadline) throw new Error(`sidecar inbound 127.0.0.1:${port} never came up`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

/**
 * Pick `count` free consecutive-ish ports starting at `base`, skipping ones
 * that are already taken (e.g. happ's own 10808/10809 when base overlaps).
 */
export async function pickPorts(base: number, count: number): Promise<number[]> {
  const ports: number[] = []
  let port = base
  while (ports.length < count && port < base + 200) {
    if (!(await portBusy(port))) ports.push(port)
    port++
  }
  if (ports.length < count) throw new Error(`only ${ports.length} free ports near ${base}`)
  return ports
}

/** Build the sidecar config: inbound `i` is routed to outbound `i`, nothing else. */
export function buildSidecarConfig(exits: ExitServer[], ports: number[]): Record<string, unknown> {
  if (exits.length !== ports.length) throw new Error("exits and ports length mismatch")
  const inbounds = ports.map((port, i) => ({
    protocol: "socks",
    listen: "127.0.0.1",
    port,
    tag: `duck-in-${i}`,
    settings: { auth: "noauth", udp: true },
  }))
  const outbounds = exits.map((exit, i) => ({ ...exit.outbound, tag: `duck-out-${i}` }))
  const rules = ports.map((_, i) => ({
    type: "field",
    inboundTag: [`duck-in-${i}`],
    // NB: xray wants outboundTag as a single string (array form is rejected).
    outboundTag: `duck-out-${i}`,
  }))
  return {
    log: { loglevel: "warning" },
    inbounds,
    outbounds,
    routing: { domainStrategy: "IPIfNonMatch", rules },
  }
}

/** Human one-liner per exit for status/summary lines. */
export function describeExits(exits: ExitServer[], ports: number[]): string[] {
  return exits.map((exit, i) => `${i + 1}. ${exit.tag} [${exit.protocol} ${exit.host}:${exit.port}] -> socks5://127.0.0.1:${ports[i]}`)
}

/** Read the sidecar pidfile, null when absent/unparseable. */
async function readPid(dir: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(sidecarPidPath(dir), "utf8")).trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Stop a previously started sidecar (pidfile-based, best effort). */
export async function stopSidecar(dir: string = vpnDir()): Promise<boolean> {
  const pid = await readPid(dir)
  if (pid === null) return false
  if (!processAlive(pid)) {
    await rm(sidecarPidPath(dir), { force: true })
    return false
  }
  try {
    if (process.platform === "win32") {
      await runCapture("taskkill", ["/PID", String(pid), "/F"], 10_000)
    } else {
      process.kill(pid, "SIGTERM")
    }
  } catch {
    return false
  }
  await rm(sidecarPidPath(dir), { force: true })
  return true
}

/**
 * (Re)start the sidecar with the given exits. Kills a stale instance first,
 * writes the config next to the secrets, waits for every inbound to answer.
 */
export async function startSidecar(
  xrayExe: string,
  exits: ExitServer[],
  ports: number[],
  dir: string = vpnDir(),
  progress?: (line: string) => Promise<void>,
): Promise<PoolBuild> {
  await stopSidecar(dir)
  await mkdir(dir, { recursive: true })
  const config = buildSidecarConfig(exits, ports)
  await writeFile(sidecarConfigPath(dir), JSON.stringify(config, null, 2), "utf8")
  const child = spawn(xrayExe, ["-config", sidecarConfigPath(dir)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.on("error", () => undefined)
  child.unref()
  if (!child.pid) throw new Error("failed to spawn the xray sidecar")
  await writeFile(sidecarPidPath(dir), String(child.pid), "utf8")
  if (progress) await progress(`sidecar started (pid ${child.pid}), waiting for ${ports.length} inbound(s)...`)
  // The process may die instantly on a bad config: fail fast instead of
  // waiting out the whole deadline on silent ports.
  const earlyDeadline = Date.now() + 4000
  for (const port of ports) {
    for (;;) {
      if (await portBusy(port)) break
      if (!processAlive(child.pid)) {
        throw new Error(
          "the xray sidecar died immediately (bad config?). " +
            `See ${sidecarConfigPath(dir)}; run it by hand to see the error.`,
        )
      }
      if (Date.now() >= earlyDeadline) break
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  for (const port of ports) await waitPort(port, 15_000)
  return { proxies: ports.map((p) => `socks5://127.0.0.1:${p}`), ports }
}

/**
 * Functional probe: fetch duck.ai's public model catalog through one SOCKS
 * exit using the OS curl (preinstalled on Windows 10+ / macOS / Linux).
 * Returns latency ms on success, throws with the reason on failure.
 */
export async function probeExit(port: number, timeoutSec = 25): Promise<number> {
  const curl = process.platform === "win32" ? "curl.exe" : "curl"
  const started = Date.now()
  const out = await runCapture(
    curl,
    [
      "-s",
      "-m",
      String(timeoutSec),
      "--socks5",
      `127.0.0.1:${port}`,
      "https://duck.ai/duckchat/v1/models",
    ],
    (timeoutSec + 10) * 1000,
  )
  const parsed = JSON.parse(out) as { models?: unknown[] };
  if (!parsed || !Array.isArray(parsed.models) || !parsed.models.length) {
    throw new Error("duck.ai answered but sent no model catalog")
  }
  return Date.now() - started
}

/** Scratch directory for near-repo temp work (kept out of the repo itself). */
export function scratchDir(): string {
  return join(vpnDir(), "scratch")
}
