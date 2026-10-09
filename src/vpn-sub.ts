/**
 * happ-compatible subscription fetch + decode.
 *
 * A panel serves either a base64 list of share links (what happ-desktop eats)
 * or a JSON document of ready-made xray configs (one full config per server,
 * with `remarks` + a `proxy` outbound). Both shapes are supported; entries
 * whose exit protocol xray cannot dial (hysteria, tuic, wireguard, …) are
 * skipped with a reason instead of breaking the pool.
 * Requests mimic a happ client (`User-Agent: Happ/1.0` + stable `x-hwid`) so a
 * re-fetch does not burn another device slot on HWID-limited panels.
 */
import { extractShareLinks } from "./vpn-links.js"

const FETCH_TIMEOUT_MS = 30_000

/** Protocols our sidecar (plain Xray-core) can actually dial. */
const DIALABLE = new Set(["vless", "vmess", "trojan", "shadowsocks"])

/** One usable exit pulled out of a JSON subscription entry. */
export interface JsonEntryExit {
  tag: string
  protocol: string
  host: string
  port: number
  /** The entry's own `proxy` outbound object (retagged at build time). */
  outbound: Record<string, unknown>
}

export interface SubscriptionResult {
  /** Share links (base64-list shape only). */
  links: string[]
  /** Usable exits (JSON shape only). */
  entries: JsonEntryExit[]
  /** Human reasons for skipped JSON entries (unsupported protocol, no exit…). */
  skipped: string[]
  isJson: boolean
  /** Raw `subscription-userinfo` header when the panel sends one. */
  userinfo: string | null
  title: string | null
}

function b64decodeBody(body: string): string {
  const compact = body.trim().replace(/\s+/g, "")
  const padded = compact + "=".repeat((4 - (compact.length % 4)) % 4)
  return Buffer.from(padded, "base64").toString("utf-8")
}

/** Split decoded body into share links; throws when there is nothing usable. */
export function decodeSubscriptionBody(body: string): string[] {
  const text = body.trim()
  if (!text) throw new Error("subscription body is empty")
  if (/^[\[{]/.test(text)) {
    throw new Error(
      "this subscription serves JSON configs: use decodeSubscriptionEntries(), not the link list.",
    )
  }
  // Most panels serve base64; some serve the plain list. Try both.
  const candidates = [text]
  try {
    const decoded = b64decodeBody(text)
    if (/vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\//i.test(decoded)) candidates.unshift(decoded)
  } catch {
    // Not base64: treat the body itself as the list.
  }
  for (const candidate of candidates) {
    const links = extractShareLinks(candidate)
    if (links.length) return links
  }
  throw new Error("no share links found in the subscription body")
}

/** Fetch a subscription URL the way happ clients do. */
export async function fetchSubscription(url: string, hwid: string): Promise<SubscriptionResult> {
  const target = url.trim()
  if (!/^https?:\/\//i.test(target)) {
    throw new Error("subscription must be an http(s) URL")
  }
  let res: Response
  try {
    res = await fetch(target, {
      headers: {
        "User-Agent": "Happ/1.0",
        "x-hwid": hwid,
        "x-device-os": process.platform === "win32" ? "Windows" : process.platform,
        "x-device-model": "desktop",
        Accept: "*/*",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`subscription fetch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (res.status === 404) {
    throw new Error(
      "the panel answered 404: on HWID-limited keys this means the device slots are full. " +
        "Use the clipboard mode instead (share a few servers from happ, no new device is registered).",
    )
  }
  if (!res.ok) throw new Error(`the panel answered HTTP ${res.status}`)
  const body = await res.text()
  const userinfo = res.headers.get("subscription-userinfo")
  const title = res.headers.get("profile-title")
  if (/^\s*\[/.test(body)) {
    const { entries, skipped } = decodeSubscriptionEntries(body)
    return { links: [], entries, skipped, isJson: true, userinfo, title }
  }
  return { links: decodeSubscriptionBody(body), entries: [], skipped: [], isJson: false, userinfo, title }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exitHostPort(outbound: Record<string, unknown>): { host: string; port: number } | null {
  const settings = asRecord(outbound.settings)
  if (!settings) return null
  const first = (key: string): Record<string, unknown> | null => {
    const list = settings[key]
    if (!Array.isArray(list) || !list.length) return null
    return asRecord(list[0])
  }
  // vless/vmess: settings.vnext[0]; trojan/shadowsocks: settings.servers[0].
  const node = first("vnext") ?? first("servers")
  if (!node) return null
  const host = node.address
  const port = Number(node.port)
  if (typeof host !== "string" || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }
  return { host, port }
}

/**
 * Pull usable exits out of a JSON subscription body (array of full xray
 * configs, one per server). The exit is the outbound tagged `proxy`
 * (fallback: first dialable non-freedom/blackhole/dns outbound); the panel's
 * own routing (direct/block bypasses) is intentionally NOT copied — the
 * sidecar routes each inbound straight to its exit.
 */
export function decodeSubscriptionEntries(body: string): { entries: JsonEntryExit[]; skipped: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error("subscription body is not valid JSON")
  }
  if (!Array.isArray(parsed)) throw new Error("JSON subscription is not a list of server configs")
  const entries: JsonEntryExit[] = []
  const skipped: string[] = []
  parsed.forEach((rawEntry, i) => {
    const label = `#${i + 1}`
    const entry = asRecord(rawEntry)
    const outbounds = entry ? entry.outbounds : null
    if (!entry || !Array.isArray(outbounds)) {
      skipped.push(`${label}: not a server config object`)
      return
    }
    const candidates = (outbounds as unknown[]).map((o) => asRecord(o)).filter((o) => o !== null)
    const proxy =
      candidates.find((o) => o.tag === "proxy") ??
      candidates.find(
        (o) => typeof o.protocol === "string" && !["freedom", "blackhole", "dns"].includes(o.protocol),
      )
    if (!proxy) {
      skipped.push(`${label}: no exit outbound found`)
      return
    }
    const protocol = String(proxy.protocol ?? "")
    if (!DIALABLE.has(protocol)) {
      skipped.push(`${label}: unsupported protocol "${protocol || "?"}" (xray cannot dial it)`)
      return
    }
    const addr = exitHostPort(proxy)
    if (!addr) {
      skipped.push(`${label}: exit has no usable address/port`)
      return
    }
    const remarks = entry.remarks
    const meta = asRecord(entry.meta)
    const group = meta && typeof meta.serverDescription === "string" ? meta.serverDescription : ""
    const tag =
      (typeof remarks === "string" && remarks.trim()) || (group ? `${group} ${label}` : `server ${label}`)
    entries.push({ tag: tag.trim(), protocol, host: addr.host, port: addr.port, outbound: proxy })
  })
  return { entries, skipped }
}
