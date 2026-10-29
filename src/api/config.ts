// ============================================================
// Server configuration and request checks (host, origin, token).
// Everything here is pure so it can be tested without a socket.
// ============================================================

import * as crypto from 'crypto';

export interface ServerConfig {
  host: string;
  port: number;
  /** Directory that `filePath` and `storageState` must stay inside; unset disables both */
  root?: string;
  /** When set, API calls and WebSocket sessions must present it */
  token?: string;
  /** Allow analyzing loopback/private addresses */
  allowPrivateNetwork: boolean;
  /** `host` or `host:port` targets exempt from the private-network block (e.g. an internal staging server) */
  allowedTargets: string[];
  /** Extra Host header values accepted besides loopback names (reverse proxies, containers) */
  allowedHosts: string[];
  /** Extra browser Origins accepted besides the server's own */
  allowedOrigins: string[];
  /** Concurrent analyses allowed before answering 429 */
  maxConcurrent: number;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK_NAMES.has(h) || /^127\./.test(h);
}

const list = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Read configuration from the environment.
 *
 *  LA_HOST                   bind address (default 127.0.0.1)
 *  PORT                      port (default 3000)
 *  LA_ROOT                   directory for server-side filePath / storageState (default: disabled)
 *  LA_API_TOKEN              require this token (Authorization: Bearer … or x-api-key)
 *  LA_ALLOW_PRIVATE_NETWORK  1/0; default is allowed only when bound to loopback
 *  LA_ALLOWED_TARGETS        comma-separated host or host:port exempt from the private-network block
 *  LA_ALLOWED_HOSTS          comma-separated extra Host header values
 *  LA_ALLOWED_ORIGINS        comma-separated extra browser origins
 *  LA_MAX_CONCURRENT         concurrent analyses (default 4)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.LA_HOST || '127.0.0.1';
  const flag = env.LA_ALLOW_PRIVATE_NETWORK?.trim().toLowerCase();
  const allowPrivateNetwork = flag ? ['1', 'true', 'yes'].includes(flag) : isLoopbackHost(host);
  const maxConcurrent = parseInt(env.LA_MAX_CONCURRENT ?? '', 10);

  return {
    host,
    port: parseInt(env.PORT ?? '', 10) || 3000,
    root: env.LA_ROOT || undefined,
    token: env.LA_API_TOKEN || undefined,
    allowPrivateNetwork,
    allowedTargets: list(env.LA_ALLOWED_TARGETS),
    allowedHosts: list(env.LA_ALLOWED_HOSTS),
    allowedOrigins: list(env.LA_ALLOWED_ORIGINS),
    maxConcurrent: maxConcurrent > 0 ? maxConcurrent : 4,
  };
}

/** "example.com:3000" -> "example.com"; "[::1]:3000" -> "::1" */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.split(':')[0];
}

/**
 * Host header check. A server bound to loopback accepts only loopback names
 * (plus LA_ALLOWED_HOSTS): that defeats DNS rebinding, where a hostile site
 * re-points its own name at 127.0.0.1 and talks to the server as "same origin".
 */
export function isHostAllowed(hostHeader: string | undefined, cfg: ServerConfig): boolean {
  if (!hostHeader) return !isLoopbackHost(cfg.host);
  const name = hostnameOf(hostHeader);
  if (cfg.allowedHosts.includes(name) || cfg.allowedHosts.includes(hostHeader.trim().toLowerCase())) return true;
  if (isLoopbackHost(cfg.host)) return isLoopbackHost(name);
  return true;
}

/**
 * Browsers always send Origin on WebSocket handshakes and cross-site POSTs.
 * Reject it unless it is this server's own origin or explicitly allowed;
 * clients that send none (curl, CI, SDKs) are not browsers and pass.
 */
export function isOriginAllowed(origin: string | undefined, hostHeader: string | undefined, cfg: ServerConfig): boolean {
  if (!origin) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (cfg.allowedOrigins.includes(o.origin.toLowerCase())) return true;
  return !!hostHeader && o.host.toLowerCase() === hostHeader.trim().toLowerCase();
}

/** Constant-time token comparison; always true when no token is configured. */
export function isAuthorized(provided: string | undefined, cfg: ServerConfig): boolean {
  if (!cfg.token) return true;
  if (!provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(cfg.token).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Token from `Authorization: Bearer x` or `x-api-key: x`. */
export function tokenFromHeaders(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const key = headers['x-api-key'];
  return typeof key === 'string' ? key : undefined;
}
