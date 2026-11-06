/**
 * SSRF guard for every URL the platform fetches on a freelancer's behalf
 * (live URL checks, evidence links).
 *
 * Rules: HTTPS only, port 443 only, no credentials in the URL, no internal host names,
 * and every resolved address must be a public unicast address.
 *
 * Known limit: the address is checked at lookup time, not pinned for the connection,
 * so a DNS rebinding window remains. Pin connections through a custom dispatcher if
 * this ever fetches arbitrary hosts at scale.
 */
import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

/** True only for globally routable unicast addresses (v4, v6, and v4-mapped v6). */
export function isPublicIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home.arpa"];

export interface SafeTarget {
  url: URL;
  addresses: string[];
}

export interface SafeUrlOptions {
  lookup?: LookupFn;
  allowedPorts?: number[];
}

export async function assertSafeUrl(raw: string, opts: SafeUrlOptions = {}): Promise<SafeTarget> {
  const lookup = opts.lookup ?? defaultLookup;
  const allowedPorts = opts.allowedPorts ?? [443];

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }

  if (url.protocol !== "https:") throw new UnsafeUrlError("Only https URLs are allowed");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials are not allowed");

  const port = url.port === "" ? 443 : Number(url.port);
  if (!allowedPorts.includes(port)) throw new UnsafeUrlError(`Port ${port} is not allowed`);

  // The URL parser already normalises 0x7f.1, 2130706433 and similar to dotted form.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw new UnsafeUrlError("Missing host");

  if (ipaddr.isValid(host)) {
    if (!isPublicIp(host)) throw new UnsafeUrlError("Address is not public");
    return { url, addresses: [host] };
  }

  if (host === "localhost" || !host.includes(".") || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("Internal host names are not allowed");
  }

  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new UnsafeUrlError("Host could not be resolved");
  }
  if (addresses.length === 0) throw new UnsafeUrlError("Host did not resolve to any address");
  if (!addresses.every(isPublicIp)) throw new UnsafeUrlError("Host resolves to a non-public address");

  return { url, addresses };
}

export interface SafeFetchOptions extends SafeUrlOptions {
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
  finalUrl: string;
}

/**
 * GET a URL with every hop validated, a timeout, and a body size cap.
 * Redirects are followed by hand so each Location is checked before it is requested.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 3;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url } = await assertSafeUrl(current, opts);
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: opts.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new UnsafeUrlError("Redirect without a Location header");
      current = new URL(location, url).toString();
      continue;
    }

    return {
      status: res.status,
      headers: res.headers,
      body: await readCapped(res, maxBytes),
      finalUrl: url.toString(),
    };
  }
  throw new UnsafeUrlError("Too many redirects");
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UnsafeUrlError(`Response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
