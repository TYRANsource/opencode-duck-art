/**
 * happ-compatible subscription fetch + decode.
 *
 * A panel serves either a base64 list of share links (what happ-desktop eats)
 * or a JSON document of ready-made xray configs. v1 supports the base64 list;
 * JSON bodies get a clear "use clipboard mode" error instead of silent garbage.
 * Requests mimic a happ client (`User-Agent: Happ/1.0` + stable `x-hwid`) so a
 * re-fetch does not burn another device slot on HWID-limited panels.
 */
import { extractShareLinks } from "./vpn-links.js"

const FETCH_TIMEOUT_MS = 30_000

export interface SubscriptionResult {
  links: string[]
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
      "this subscription serves JSON configs, which duck_vpn does not read yet. " +
        "Use the clipboard mode instead: share a few servers from happ and run `collect-links`.",
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
  return {
    links: decodeSubscriptionBody(body),
    userinfo: res.headers.get("subscription-userinfo"),
    title: res.headers.get("profile-title"),
  }
}
