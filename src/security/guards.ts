// ============================================================
// Input guards for running LocatorAgent as a service:
//  - server-side file paths must stay inside a configured root
//  - URLs must be http(s) and, optionally, point at public hosts only
// (Redirects and subresources are enforced by ./filteringProxy.ts.)
// ============================================================

import * as dns from 'dns';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

/** The request is refused by policy (maps to HTTP 403). */
export class AccessError extends Error {}

/** The request is malformed (maps to HTTP 400). */
export class BadRequestError extends Error {}

export interface NetworkPolicy {
  /** Allow loopback, private, link-local and other non-public addresses */
  allowPrivateNetwork: boolean;
  /** Exceptions to the private-address block: `host` or `host:port` (e.g. an internal staging server) */
  allowedTargets?: string[];
}

export type Lookup = (host: string) => Promise<string[]>;

// ── Filesystem ───────────────────────────────────────────────

/**
 * Resolve a caller-supplied path against `root` and return its real path,
 * refusing anything that ends up outside it (`..`, absolute paths elsewhere,
 * symlinks pointing out). With no root configured, file access is disabled.
 */
export function resolveInsideRoot(root: string | undefined, requested: string, what: string): string {
  if (!root) {
    throw new AccessError(`${what} is disabled on this server (set LA_ROOT to a directory to enable it)`);
  }
  const rootReal = fs.realpathSync(path.resolve(root));
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(rootReal, requested));
  } catch {
    // Same wording for "missing" and "outside": don't reveal what exists elsewhere
    throw new AccessError(`${what} not found inside the allowed directory`);
  }
  const rel = path.relative(rootReal, real);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new AccessError(`${what} must be inside the allowed directory`);
  }
  return real;
}

// ── Network ──────────────────────────────────────────────────

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.some((b) => !(b >= 0 && b <= 255)) ? null : bytes;
}

function isPrivateIPv4(b: number[]): boolean {
  const [a, c] = b;
  return (
    a === 0 || // "this" network
    a === 10 ||
    (a === 100 && c >= 64 && c <= 127) || // carrier-grade NAT
    a === 127 ||
    (a === 169 && c === 254) || // link-local, cloud metadata
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 0 && b[2] === 0) ||
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) ||
    a >= 224 // multicast and reserved
  );
}

/** Expand an IPv6 literal into eight 16-bit groups (handles `::` and a trailing dotted IPv4). */
function ipv6ToGroups(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0];
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = ipv4ToBytes(dotted[1]);
    if (!v4) return null;
    text = text.slice(0, -dotted[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for any address that is not a plain public unicast address (unparseable counts as private). */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ipv4ToBytes(ip)!);
  if (!net.isIPv6(ip)) return true;

  const g = ipv6ToGroups(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => isPrivateIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);

  if (g.slice(0, 5).every((x) => x === 0)) {
    if (g[5] === 0xffff) return embedded(g[6], g[7]); // IPv4-mapped ::ffff:a.b.c.d
    if (g[5] === 0) return true; // :: and ::1 (and deprecated IPv4-compatible)
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4
  return (
    (g[0] & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g[0] & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g[0] & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x2001 && g[1] === 0x0db8) // documentation
  );
}

async function defaultLookup(host: string): Promise<string[]> {
  const found = await dns.promises.lookup(host, { all: true });
  return found.map((f) => f.address);
}

/**
 * Decide whether a connection to `hostname:port` is allowed and return the
 * address to connect to. Connecting to the returned address (rather than
 * resolving the name again) closes the DNS-rebinding window.
 */
export async function resolveAllowedAddress(
  hostname: string,
  port: number,
  policy: NetworkPolicy,
  lookup: Lookup = defaultLookup,
): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const deny = () => new AccessError(`Requests to private or local network addresses are blocked (${host})`);

  const targeted = !!policy.allowedTargets?.some((t) => {
    const x = t.trim().toLowerCase();
    return x === host || x === `${host}:${port}`;
  });
  const permitted = policy.allowPrivateNetwork || targeted;

  if (net.isIP(host)) {
    if (!permitted && isPrivateAddress(host)) throw deny();
    return host;
  }
  if (!permitted && (host === 'localhost' || host.endsWith('.localhost'))) throw deny();

  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new AccessError(`Cannot resolve host ${host}`);
  }
  if (addresses.length === 0) throw new AccessError(`Cannot resolve host ${host}`);
  if (!permitted && addresses.some(isPrivateAddress)) throw deny();
  // Every address passed the check above; prefer IPv4 since "localhost" often lists ::1 first
  // while servers (e.g. in a container) listen on IPv4 only
  return addresses.find((a) => net.isIPv4(a)) ?? addresses[0];
}

/**
 * Validate a URL for navigation: http(s) only, and (unless allowed) only to
 * hosts whose every resolved address is public.
 */
export async function assertUrlAllowed(raw: string, policy: NetworkPolicy, lookup: Lookup = defaultLookup): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadRequestError('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AccessError(`URL scheme "${u.protocol}" is not allowed (use http or https)`);
  }
  if (policy.allowPrivateNetwork) return;
  await resolveAllowedAddress(u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80), policy, lookup);
}
