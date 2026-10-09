/**
 * duck_vpn share-link parsing + xray outbound builders.
 *
 * Pure functions, no side effects: parse `vless://` / `vmess://` / `trojan://`
 * / `ss://` links (happ subscription style) into normalized exit servers and
 * render matching Xray-core outbound objects. Unknown transports are rejected
 * with a reason instead of producing a broken config.
 */

export type ExitProtocol = "vless" | "vmess" | "trojan" | "shadowsocks"

/** A single VPN exit: the original link plus a ready xray outbound. */
export interface ExitServer {
  /** Human tag (from the link fragment, URL-decoded). */
  tag: string
  protocol: ExitProtocol
  host: string
  port: number
  /** The exact link text, kept for rebuilds/debugging. */
  link: string
  /** Xray-core outbound object (`tag` filled in by the config builder). */
  outbound: Record<string, unknown>
}

function b64decode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, "base64").toString("utf-8")
}

function tagOf(url: URL, fallback: string): string {
  try {
    const t = decodeURIComponent(url.hash.replace(/^#/, "")).trim()
    if (t) return t
  } catch {
    // Malformed percent-encoding: fall through to the fallback.
  }
  return fallback
}

/** Best-effort fragment decode (never throws). */
function safeDecode(fragment: string): string {
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}

function numPort(value: string, link: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`bad port in link: ${link.slice(0, 80)}`)
  }
  return port
}

type StreamKind = "tcp" | "ws" | "grpc"

interface StreamOpts {
  kind: StreamKind
  security: "none" | "tls" | "reality"
  serverName: string
  fingerprint?: string
  publicKey?: string
  shortId?: string
  path?: string
  host?: string
  serviceName?: string
}

/** Read transport options shared by vless/vmess/trojan links. */
function readStream(query: URLSearchParams, host: string): StreamOpts {
  const rawType = (query.get("type") || "tcp").toLowerCase()
  if (rawType !== "tcp" && rawType !== "ws" && rawType !== "grpc") {
    throw new Error(`unsupported transport "${rawType}" (need tcp/ws/grpc)`)
  }
  const rawSec = (query.get("security") || "none").toLowerCase()
  if (rawSec !== "none" && rawSec !== "tls" && rawSec !== "reality") {
    throw new Error(`unsupported security "${rawSec}" (need none/tls/reality)`)
  }
  return {
    kind: rawType,
    security: rawSec,
    serverName: query.get("sni") || query.get("serverName") || query.get("host") || host,
    fingerprint: query.get("fp") || query.get("fingerprint") || undefined,
    publicKey: query.get("pbk") || undefined,
    shortId: query.get("sid") || undefined,
    path: query.get("path") || undefined,
    host: query.get("host") || undefined,
    serviceName: query.get("serviceName") || undefined,
  }
}

/** Render xray `streamSettings` from normalized options. */
function streamSettings(o: StreamOpts): Record<string, unknown> {
  const out: Record<string, unknown> = { network: o.kind, security: o.security }
  if (o.security === "tls") {
    const tls: Record<string, unknown> = { serverName: o.serverName }
    if (o.fingerprint) tls.fingerprint = o.fingerprint
    out.tlsSettings = tls
  } else if (o.security === "reality") {
    if (!o.publicKey) throw new Error("reality needs a public key (pbk)")
    if (!o.fingerprint) throw new Error("reality needs a fingerprint (fp)")
    out.realitySettings = {
      serverName: o.serverName,
      fingerprint: o.fingerprint,
      publicKey: o.publicKey,
      shortId: o.shortId ?? "",
    }
  }
  if (o.kind === "ws") {
    out.wsSettings = {
      path: o.path || "/",
      headers: o.host ? { Host: o.host } : {},
    }
  } else if (o.kind === "grpc") {
    out.grpcSettings = { serviceName: o.serviceName || "" }
  }
  return out
}

function parseVless(link: string): ExitServer {
  const url = new URL(link)
  const uuid = decodeURIComponent(url.username)
  if (!/^[0-9a-f-]{10,}$/i.test(uuid)) throw new Error("bad vless user id")
  const host = url.hostname
  const port = numPort(url.port || "443", link)
  const q = url.searchParams
  const stream = readStream(q, host)
  const flow = q.get("flow") || undefined
  if (flow && flow !== "xtls-rprx-vision") throw new Error(`unsupported flow "${flow}"`)
  return {
    tag: tagOf(url, `${host}:${port}`),
    protocol: "vless",
    host,
    port,
    link,
    outbound: {
      protocol: "vless",
      settings: {
        vnext: [
          {
            address: host,
            port,
            users: [{ id: uuid, encryption: "none", ...(flow ? { flow } : {}) }],
          },
        ],
      },
      streamSettings: streamSettings(stream),
    },
  }
}

interface VmessJson {
  add?: string
  port?: string | number
  id?: string
  aid?: string | number
  scy?: string
  net?: string
  tls?: string
  host?: string
  path?: string
  sni?: string
  ps?: string
}

function parseVmess(link: string): ExitServer {
  const payload = link.replace(/^vmess:\/\//i, "").split("#")[0]
  let json: VmessJson
  try {
    json = JSON.parse(b64decode(payload)) as VmessJson
  } catch {
    throw new Error("bad vmess payload (not base64 json)")
  }
  const host = (json.add || "").trim()
  if (!host) throw new Error("vmess has no address")
  const port = numPort(String(json.port ?? ""), link)
  if (!json.id) throw new Error("vmess has no user id")
  const net = (json.net || "tcp").toLowerCase()
  if (net !== "tcp" && net !== "ws" && net !== "grpc") {
    throw new Error(`unsupported vmess net "${net}" (need tcp/ws/grpc)`)
  }
  const tls = (json.tls || "none").toLowerCase() === "tls"
  const q = new URLSearchParams()
  q.set("type", net)
  q.set("security", tls ? "tls" : "none")
  if (json.sni || json.host) q.set("sni", json.sni || json.host || "")
  if (json.host) q.set("host", json.host)
  if (json.path) q.set("path", json.path)
  const stream = readStream(q, host)
  return {
    tag: (json.ps || "").trim() || `${host}:${port}`,
    protocol: "vmess",
    host,
    port,
    link,
    outbound: {
      protocol: "vmess",
      settings: {
        vnext: [
          {
            address: host,
            port,
            users: [
              {
                id: json.id,
                alterId: Number(json.aid ?? 0) || 0,
                security: json.scy || "auto",
              },
            ],
          },
        ],
      },
      streamSettings: streamSettings(stream),
    },
  }
}

function parseTrojan(link: string): ExitServer {
  const url = new URL(link)
  const password = decodeURIComponent(url.username)
  if (!password) throw new Error("trojan has no password")
  const host = url.hostname
  const port = numPort(url.port || "443", link)
  const q = url.searchParams
  // Trojan is always TLS; accept an explicit security param only if sane.
  const sec = (q.get("security") || "tls").toLowerCase()
  if (sec !== "tls") throw new Error(`trojan needs tls, got "${sec}"`)
  q.set("security", "tls")
  const stream = readStream(q, host)
  return {
    tag: tagOf(url, `${host}:${port}`),
    protocol: "trojan",
    host,
    port,
    link,
    outbound: {
      protocol: "trojan",
      settings: { servers: [{ address: host, port, password }] },
      streamSettings: streamSettings(stream),
    },
  }
}

function parseShadowsocks(link: string): ExitServer {
  // NOTE: intentionally no `new URL()` here — URL lowercases the hostname,
  // which corrupts base64 userinfo/hunks. Manual split instead.
  const hash = link.indexOf("#")
  const tag = hash === -1 ? "" : safeDecode(link.slice(hash + 1)).trim()
  let body = (hash === -1 ? link : link.slice(0, hash)).replace(/^ss:\/\//i, "")
  body = body.split("?")[0]
  let method = ""
  let password = ""
  let host = ""
  let port = ""
  const at = body.lastIndexOf("@")
  if (at !== -1) {
    // ss://[base64(method:password) | method:password]@host:port
    const left = body.slice(0, at)
    const right = body.slice(at + 1)
    const hm = right.match(/^(.*?):(\d+)\/?$/)
    if (!hm) throw new Error("bad ss link (cannot split host:port)")
    host = hm[1]
    port = hm[2]
    const userinfo = left.includes(":") ? left : b64decode(left)
    const um = userinfo.match(/^(.*?):(.*)$/)
    if (!um) throw new Error("bad ss userinfo (cannot split method:password)")
    method = um[1]
    password = um[2]
  } else {
    // ss://base64(method:password@host:port)
    const decoded = b64decode(body)
    const m = decoded.match(/^(.*?):(.*?)@(.*?):(\d+)\/?$/)
    if (!m) throw new Error("bad ss link (cannot split method:password@host:port)")
    method = m[1]
    password = m[2]
    host = m[3]
    port = m[4]
  }
  if (!method || !password || !host) throw new Error("ss needs method, password and host")
  return {
    tag: tag || `${host}:${port}`,
    protocol: "shadowsocks",
    host,
    port: numPort(port, link),
    link,
    outbound: {
      protocol: "shadowsocks",
      settings: { servers: [{ address: host, port: Number(port), method, password }] },
    },
  }
}

/** Parse one share link into an exit server. Throws with a human reason. */
export function parseShareLink(raw: string): ExitServer {
  const link = raw.trim()
  if (/^vless:\/\//i.test(link)) return parseVless(link)
  if (/^vmess:\/\//i.test(link)) return parseVmess(link)
  if (/^trojan:\/\//i.test(link)) return parseTrojan(link)
  if (/^ss:\/\//i.test(link)) return parseShadowsocks(link)
  throw new Error("not a share link (need vless:// vmess:// trojan:// ss://)")
}

/** Pull candidate share links out of arbitrary clipboard/text input. */
export function extractShareLinks(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const re = /(vless:\/\/[^\s"'<>]+|vmess:\/\/[^\s"'<>]+|trojan:\/\/[^\s"'<>]+|ss:\/\/[^\s"'<>]+)/gi
  for (const m of text.matchAll(re)) {
    const link = m[1].trim().replace(/[.,;)\]]+$/, "")
    if (!seen.has(link)) {
      seen.add(link)
      found.push(link)
    }
  }
  return found
}
