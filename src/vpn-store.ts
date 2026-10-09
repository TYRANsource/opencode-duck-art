/**
 * duck_vpn secret store.
 *
 * Server links and the subscription URL are secrets: they NEVER go into the
 * repo or `duck-art.json`. Everything lives in a per-user data directory
 * (`%LOCALAPPDATA%/opencode/duck-vpn` on Windows,
 * `~/.local/share/opencode/duck-vpn` elsewhere) with owner-only permissions
 * where the platform supports them.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

export type VpnMode = "subscription" | "links"

/** One pooled exit as stored (full outbound included: this file IS the secret store). */
export interface StoredExit {
  tag: string
  protocol: string
  host: string
  port: number
  outbound: Record<string, unknown>
}

export interface VpnSecrets {
  /** Stable device id sent as `x-hwid` so panel re-fetches reuse one slot. */
  hwid: string
  mode: VpnMode | null
  /** happ subscription URL (mode "subscription" only). Secret. */
  subUrl?: string
  /** Raw share links backing the pool (link shapes only). Secret. */
  links: string[]
  /** Built pool exits (both modes end up here; drives test/status/switch). */
  exits: StoredExit[]
  /** Local SOCKS ports handed to the relay, one per exit. */
  ports: number[]
  updatedAt?: string
}

const EMPTY: VpnSecrets = { hwid: "", mode: null, links: [], exits: [], ports: [] }

/** Per-user directory for VPN secrets, sidecar config and logs. */
export function vpnDir(): string {
  const base =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : join(homedir(), ".local", "share")
  return join(base, "opencode", "duck-vpn")
}

export function secretsPath(dir: string = vpnDir()): string {
  return join(dir, "vpn.json")
}

export function sidecarConfigPath(dir: string = vpnDir()): string {
  return join(dir, "xray-duck.json")
}

export function sidecarPidPath(dir: string = vpnDir()): string {
  return join(dir, "xray-duck.pid")
}

function isStoredExit(value: unknown): value is StoredExit {
  if (!value || typeof value !== "object") return false
  const o = value as Record<string, unknown>
  return (
    typeof o.tag === "string" &&
    typeof o.protocol === "string" &&
    typeof o.host === "string" &&
    Number.isInteger(o.port) &&
    !!o.outbound &&
    typeof o.outbound === "object"
  )
}

export async function loadSecrets(dir: string = vpnDir()): Promise<VpnSecrets> {
  try {
    const parsed = JSON.parse(await readFile(secretsPath(dir), "utf8")) as Partial<VpnSecrets>
    return {
      hwid: typeof parsed.hwid === "string" && parsed.hwid ? parsed.hwid : randomUUID(),
      mode: parsed.mode === "subscription" || parsed.mode === "links" ? parsed.mode : null,
      subUrl: typeof parsed.subUrl === "string" ? parsed.subUrl : undefined,
      links: Array.isArray(parsed.links) ? parsed.links.filter((l): l is string => typeof l === "string") : [],
      exits: Array.isArray(parsed.exits) ? parsed.exits.filter(isStoredExit) : [],
      ports: Array.isArray(parsed.ports)
        ? parsed.ports.filter((p): p is number => Number.isInteger(p))
        : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    }
  } catch {
    return { ...EMPTY, hwid: randomUUID() }
  }
}

export async function saveSecrets(secrets: VpnSecrets, dir: string = vpnDir()): Promise<void> {
  await mkdir(dir, { recursive: true })
  const path = secretsPath(dir)
  await writeFile(path, JSON.stringify({ ...secrets, updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  })
}
