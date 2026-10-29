// ============================================================
// Tests: API hardening (paths, URLs, host/origin/token checks)
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import {
  AccessError,
  assertUrlAllowed,
  isPrivateAddress,
  resolveInsideRoot,
} from '../src/security/guards';
import { isHostAllowed, isOriginAllowed, isAuthorized, loadConfig, ServerConfig, tokenFromHeaders } from '../src/api/config';
import { createServer } from '../src/api/server';

const baseConfig = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  host: '127.0.0.1',
  port: 0,
  allowPrivateNetwork: false,
  allowedTargets: [],
  allowedHosts: [],
  allowedOrigins: [],
  maxConcurrent: 4,
  ...over,
});

// ── Unit: addresses and URLs ──────────────────────────────────

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0',
    '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a00:1', '2002:7f00:1::',
  ])('treats %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it('treats unparseable input as private', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('assertUrlAllowed', () => {
  const policy = { allowPrivateNetwork: false };
  const publicLookup = async () => ['93.184.216.34'];

  it('accepts public http(s) URLs', async () => {
    await expect(assertUrlAllowed('https://example.com/x', policy, publicLookup)).resolves.toBeUndefined();
    await expect(assertUrlAllowed('http://93.184.216.34/', policy, publicLookup)).resolves.toBeUndefined();
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/', 'data:text/html,hi', 'chrome://settings'])(
    'rejects scheme in %s even when private networks are allowed',
    async (u) => {
      await expect(assertUrlAllowed(u, { allowPrivateNetwork: true }, publicLookup)).rejects.toThrow(AccessError);
    },
  );

  it.each([
    'http://localhost:3000/', 'http://app.localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/', // 127.0.0.1 as a single integer: the URL parser normalizes it
    'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/', 'http://10.0.0.5:8080/',
  ])('blocks %s', async (u) => {
    await expect(assertUrlAllowed(u, policy, publicLookup)).rejects.toThrow(/private or local/);
  });

  it('blocks hostnames that resolve to private addresses (any record)', async () => {
    await expect(assertUrlAllowed('http://internal.example/', policy, async () => ['10.0.0.1'])).rejects.toThrow(AccessError);
    await expect(
      assertUrlAllowed('http://mixed.example/', policy, async () => ['93.184.216.34', '127.0.0.1']),
    ).rejects.toThrow(AccessError);
  });

  it('fails closed when the host does not resolve', async () => {
    await expect(
      assertUrlAllowed('http://nowhere.invalid/', policy, async () => { throw new Error('ENOTFOUND'); }),
    ).rejects.toThrow(/Cannot resolve/);
  });

  it('allows private addresses when the policy says so', async () => {
    await expect(assertUrlAllowed('http://localhost:4200/', { allowPrivateNetwork: true }, publicLookup)).resolves.toBeUndefined();
  });

  it('rejects malformed URLs', async () => {
    await expect(assertUrlAllowed('not a url', policy, publicLookup)).rejects.toThrow(/Invalid URL/);
  });
});

// ── Unit: filesystem root ─────────────────────────────────────

describe('resolveInsideRoot', () => {
  let tmp: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'la-sec-')));
    root = path.join(tmp, 'root');
    outside = path.join(tmp, 'outside.html');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'a.html'), '<button>a</button>');
    fs.writeFileSync(outside, 'secret');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('is disabled without a root', () => {
    expect(() => resolveInsideRoot(undefined, 'a.html', 'filePath')).toThrow(/disabled/);
  });

  it('resolves relative and absolute paths inside the root', () => {
    expect(resolveInsideRoot(root, 'sub/a.html', 'filePath')).toBe(path.join(root, 'sub', 'a.html'));
    expect(resolveInsideRoot(root, path.join(root, 'sub', 'a.html'), 'filePath')).toBe(path.join(root, 'sub', 'a.html'));
  });

  it('refuses traversal and absolute paths elsewhere', () => {
    expect(() => resolveInsideRoot(root, '../outside.html', 'filePath')).toThrow(AccessError);
    expect(() => resolveInsideRoot(root, outside, 'filePath')).toThrow(AccessError);
    expect(() => resolveInsideRoot(root, 'sub/../../outside.html', 'filePath')).toThrow(AccessError);
  });

  it('refuses a sibling directory that merely shares the root as a prefix', () => {
    const sibling = path.join(tmp, 'root-evil');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'x.html'), 'x');
    expect(() => resolveInsideRoot(root, path.join(sibling, 'x.html'), 'filePath')).toThrow(AccessError);
  });

  it('refuses a symlink that points outside the root', (ctx) => {
    const link = path.join(root, 'link.html');
    try {
      fs.symlinkSync(outside, link, 'file');
    } catch {
      ctx.skip(); // creating symlinks needs privileges on some Windows setups
      return;
    }
    expect(() => resolveInsideRoot(root, 'link.html', 'filePath')).toThrow(AccessError);
  });

  it('does not reveal whether a missing file exists outside the root', () => {
    expect(() => resolveInsideRoot(root, '../nope.html', 'filePath')).toThrow(/inside the allowed directory/);
  });
});

// ── Unit: config checks ───────────────────────────────────────

describe('server config', () => {
  it('defaults to loopback, private networks allowed, file access off', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ host: '127.0.0.1', port: 3000, allowPrivateNetwork: true, root: undefined, token: undefined });
  });

  it('blocks private networks by default when bound beyond loopback', () => {
    expect(loadConfig({ LA_HOST: '0.0.0.0' }).allowPrivateNetwork).toBe(false);
    expect(loadConfig({ LA_HOST: '0.0.0.0', LA_ALLOW_PRIVATE_NETWORK: '1' }).allowPrivateNetwork).toBe(true);
    expect(loadConfig({ LA_ALLOW_PRIVATE_NETWORK: '0' }).allowPrivateNetwork).toBe(false);
  });

  it('only accepts loopback Host headers on a loopback bind (DNS rebinding)', () => {
    const c = baseConfig();
    expect(isHostAllowed('localhost:3000', c)).toBe(true);
    expect(isHostAllowed('127.0.0.1:3000', c)).toBe(true);
    expect(isHostAllowed('[::1]:3000', c)).toBe(true);
    expect(isHostAllowed('evil.example:3000', c)).toBe(false);
    expect(isHostAllowed(undefined, c)).toBe(false);
    expect(isHostAllowed('tool.corp:3000', baseConfig({ allowedHosts: ['tool.corp'] }))).toBe(true);
    expect(isHostAllowed('anything', baseConfig({ host: '0.0.0.0' }))).toBe(true);
  });

  it('accepts same-origin and non-browser requests, refuses foreign origins', () => {
    const c = baseConfig();
    expect(isOriginAllowed(undefined, 'localhost:3000', c)).toBe(true);
    expect(isOriginAllowed('http://localhost:3000', 'localhost:3000', c)).toBe(true);
    expect(isOriginAllowed('http://evil.example', 'localhost:3000', c)).toBe(false);
    expect(isOriginAllowed('null', 'localhost:3000', c)).toBe(false);
    expect(isOriginAllowed('http://ci.corp', 'localhost:3000', baseConfig({ allowedOrigins: ['http://ci.corp'] }))).toBe(true);
  });

  it('checks tokens in constant time and only when configured', () => {
    expect(isAuthorized(undefined, baseConfig())).toBe(true);
    const c = baseConfig({ token: 's3cret' });
    expect(isAuthorized('s3cret', c)).toBe(true);
    expect(isAuthorized('s3cre', c)).toBe(false);
    expect(isAuthorized(undefined, c)).toBe(false);
    expect(tokenFromHeaders({ authorization: 'Bearer abc' })).toBe('abc');
    expect(tokenFromHeaders({ 'x-api-key': 'k' })).toBe('k');
    expect(tokenFromHeaders({})).toBeUndefined();
  });
});

// ── HTTP: the real server ─────────────────────────────────────

interface Reply { status: number; json: any }

function call(
  port: number,
  method: string,
  urlPath: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path: urlPath,
        headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...opts.headers },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: any;
          try { json = JSON.parse(text); } catch { json = text; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function listen(config: ServerConfig): Promise<{ port: number; close: () => Promise<void> }> {
  const { server } = createServer(config);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

describe('API server hardening', () => {
  let tmp: string;
  let root: string;
  let api: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'la-api-')));
    root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'page.html'), '<button id="save">Save</button>');
    fs.writeFileSync(path.join(tmp, 'secret.html'), '<button>secret</button>');
    api = await listen(baseConfig({ root }));
  });
  afterAll(async () => {
    await api.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serves /health', async () => {
    expect((await call(api.port, 'GET', '/health')).status).toBe(200);
  });

  it('rejects a foreign Host header (DNS rebinding), including for static files', async () => {
    expect((await call(api.port, 'GET', '/health', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await call(api.port, 'GET', '/', { headers: { host: 'evil.example' } })).status).toBe(403);
  });

  it('rejects cross-site browser POSTs', async () => {
    const r = await call(api.port, 'POST', '/analyze', {
      headers: { origin: 'http://evil.example' },
      body: { html: '<button>x</button>' },
    });
    expect(r.status).toBe(403);
  });

  it('validates input types and presence', async () => {
    expect((await call(api.port, 'POST', '/analyze', { body: {} })).status).toBe(400);
    expect((await call(api.port, 'POST', '/analyze', { body: { url: 42 } })).status).toBe(400);
    expect((await call(api.port, 'POST', '/analyze/element', { body: { html: '<b>x</b>' } })).status).toBe(400);
  });

  it('refuses non-http(s) URLs and private addresses', async () => {
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1:1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/']) {
      const r = await call(api.port, 'POST', '/analyze', { body: { url } });
      expect(r.status, url).toBe(403);
    }
  });

  it('refuses file paths outside LA_ROOT', async () => {
    for (const filePath of ['../secret.html', path.join(tmp, 'secret.html'), 'does-not-exist.html']) {
      const r = await call(api.port, 'POST', '/analyze', { body: { filePath } });
      expect(r.status, filePath).toBe(403);
    }
    expect((await call(api.port, 'POST', '/analyze', { body: { html: '<b>x</b>', storageState: '../secret.html' } })).status).toBe(403);
  });

  it('analyzes a file inside LA_ROOT', async () => {
    const r = await call(api.port, 'POST', '/analyze', { body: { filePath: 'page.html' } });
    expect(r.status).toBe(200);
    expect(r.json.elements.length).toBeGreaterThan(0);
  }, 60_000);

  it('disables file access entirely when LA_ROOT is unset', async () => {
    const open = await listen(baseConfig());
    try {
      const r = await call(open.port, 'POST', '/analyze', { body: { filePath: 'page.html' } });
      expect(r.status).toBe(403);
      expect(r.json.error).toMatch(/LA_ROOT/);
    } finally {
      await open.close();
    }
  });

  it('clamps timeout and maxElements instead of trusting the caller', async () => {
    const r = await call(api.port, 'POST', '/analyze', { body: { html: '<button>a</button><button>b</button>', maxElements: 1, timeout: 1e12 } });
    expect(r.status).toBe(200);
    expect(r.json.elements).toHaveLength(1);
  }, 60_000);

  it('answers 429 beyond the concurrency cap', async () => {
    const capped = await listen(baseConfig({ maxConcurrent: 1 }));
    try {
      const body = { html: '<button>x</button>' };
      const replies = await Promise.all([
        call(capped.port, 'POST', '/analyze', { body }),
        call(capped.port, 'POST', '/analyze', { body }),
      ]);
      expect(replies.map((r) => r.status).sort()).toEqual([200, 429]);
    } finally {
      await capped.close();
    }
  }, 60_000);

  describe('with an API token', () => {
    let secured: { port: number; close: () => Promise<void> };
    beforeAll(async () => { secured = await listen(baseConfig({ token: 's3cret' })); });
    afterAll(async () => { await secured.close(); });

    it('requires the token on API routes but not for /health or the UI', async () => {
      expect((await call(secured.port, 'POST', '/analyze', { body: {} })).status).toBe(401);
      expect((await call(secured.port, 'POST', '/analyze', { body: {}, headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
      // Passing auth reaches input validation (400) without launching a browser
      expect((await call(secured.port, 'POST', '/analyze', { body: {}, headers: { authorization: 'Bearer s3cret' } })).status).toBe(400);
      expect((await call(secured.port, 'POST', '/analyze', { body: {}, headers: { 'x-api-key': 's3cret' } })).status).toBe(400);
      expect((await call(secured.port, 'GET', '/sessions')).status).toBe(401);
      expect((await call(secured.port, 'GET', '/health')).status).toBe(200);
    });

    function handshake(port: number, query: string, origin?: string): Promise<number> {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser${query}`, origin ? { origin } : {});
        ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
        ws.on('open', () => { resolve(101); ws.terminate(); });
        ws.on('error', () => {});
      });
    }

    it('guards WebSocket sessions: token and origin are enforced on the handshake', async () => {
      expect(await handshake(secured.port, '')).toBe(401);
      expect(await handshake(secured.port, '?token=wrong')).toBe(401);
      expect(await handshake(secured.port, '?token=s3cret', 'http://evil.example')).toBe(403);
    });
  });
});

