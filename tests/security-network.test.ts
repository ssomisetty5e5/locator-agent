// ============================================================
// Tests: filtering proxy and network policy in the page loader
// (redirects, subresources, tunnels, DNS rebinding)
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { AccessError, resolveAllowedAddress } from '../src/security/guards';
import { startFilteringProxy } from '../src/security/filteringProxy';
import { LocatorAgent } from '../src/agent';

const proxyPort = (url: string) => Number(new URL(url).port);

describe('filtering proxy', () => {
  it('refuses plain HTTP to private targets with a 403 and records why', async () => {
    const proxy = await startFilteringProxy({ allowPrivateNetwork: false });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: proxyPort(proxy.url), method: 'GET', path: 'http://169.254.169.254/latest/', headers: { host: '169.254.169.254' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
      expect([...proxy.blocked().keys()]).toContain('169.254.169.254:80');
    } finally {
      await proxy.close();
    }
  });

  it('refuses CONNECT tunnels to private targets', async () => {
    const proxy = await startFilteringProxy({ allowPrivateNetwork: false });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: proxyPort(proxy.url), method: 'CONNECT', path: '10.0.0.5:443' });
        req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
        req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
      expect(proxy.blocked().has('10.0.0.5:443')).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('connects to the address it validated, resolving the name only once', async () => {
    const origin = http.createServer((_req, res) => res.end('hello'));
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    const originPort = (origin.address() as AddressInfo).port;
    let lookups = 0;
    const proxy = await startFilteringProxy(
      { allowPrivateNetwork: false, allowedTargets: [`rebind.test:${originPort}`] },
      async () => { lookups++; return ['127.0.0.1']; },
    );
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: proxyPort(proxy.url), method: 'GET', path: `http://rebind.test:${originPort}/`, headers: { host: `rebind.test:${originPort}` } },
          (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve(text));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('hello');
      expect(lookups).toBe(1);
    } finally {
      await proxy.close();
      origin.closeAllConnections?.();
      await new Promise((r) => origin.close(r));
    }
  });

  it('exempts explicitly allowed targets only', async () => {
    const policy = { allowPrivateNetwork: false, allowedTargets: ['staging.corp', '10.1.1.1:8080'] };
    await expect(resolveAllowedAddress('10.1.1.1', 8080, policy)).resolves.toBe('10.1.1.1');
    await expect(resolveAllowedAddress('10.1.1.1', 9090, policy)).rejects.toThrow(AccessError);
    await expect(resolveAllowedAddress('staging.corp', 443, policy, async () => ['10.9.9.9'])).resolves.toBe('10.9.9.9');
    await expect(resolveAllowedAddress('other.corp', 443, policy, async () => ['10.9.9.9'])).rejects.toThrow(AccessError);
  });

  it('prefers an IPv4 address when a host resolves to both families', async () => {
    const policy = { allowPrivateNetwork: false, allowedTargets: ['localhost:3000'] };
    await expect(resolveAllowedAddress('localhost', 3000, policy, async () => ['::1', '127.0.0.1'])).resolves.toBe('127.0.0.1');
    // still refuses when any address is private and the target is not exempt
    await expect(
      resolveAllowedAddress('mixed.example', 443, { allowPrivateNetwork: false }, async () => ['93.184.216.34', '10.0.0.1']),
    ).rejects.toThrow(AccessError);
  });
});

describe('network policy in the page loader', () => {
  let allowed: http.Server;
  let internal: http.Server;
  let internalHits = 0;
  let allowedPort: number;
  let internalPort: number;

  beforeAll(async () => {
    internal = http.createServer((_req, res) => { internalHits++; res.end('<button>internal</button>'); });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
    internalPort = (internal.address() as AddressInfo).port;

    allowed = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/` });
        res.end();
      } else if (req.url === '/redirect-twice') {
        res.writeHead(302, { location: '/redirect' });
        res.end();
      } else {
        res.setHeader('content-type', 'text/html');
        res.end(`<button>ok</button><img src="http://127.0.0.1:${internalPort}/pixel.png">`);
      }
    });
    await new Promise<void>((r) => allowed.listen(0, '127.0.0.1', r));
    allowedPort = (allowed.address() as AddressInfo).port;
  });
  afterAll(async () => {
    allowed.closeAllConnections?.();
    internal.closeAllConnections?.();
    await Promise.all([new Promise((r) => allowed.close(r)), new Promise((r) => internal.close(r))]);
  });

  // 127.0.0.1 is private, so the "public" test server is explicitly exempted; the internal one is not
  const policy = () => ({ allowPrivateNetwork: false, allowedTargets: [`127.0.0.1:${allowedPort}`] });

  async function withAgent<T>(fn: (agent: LocatorAgent) => Promise<T>): Promise<T> {
    const agent = new LocatorAgent();
    try {
      internalHits = 0;
      return await fn(agent);
    } finally {
      await agent.shutdown();
    }
  }

  it('blocks a redirect to a forbidden address and reports why', () =>
    withAgent(async (agent) => {
      await expect(
        agent.analyze({ url: `http://127.0.0.1:${allowedPort}/redirect`, networkPolicy: policy(), timeout: 15_000 }),
      ).rejects.toThrow(AccessError);
      expect(internalHits).toBe(0);
    }), 60_000);

  it('blocks a redirect chain whose later hop is forbidden', () =>
    withAgent(async (agent) => {
      await expect(
        agent.analyze({ url: `http://127.0.0.1:${allowedPort}/redirect-twice`, networkPolicy: policy(), timeout: 15_000 }),
      ).rejects.toThrow(/private or local/);
      expect(internalHits).toBe(0);
    }), 60_000);

  it('blocks forbidden subresources but still analyzes the page', () =>
    withAgent(async (agent) => {
      const r = await agent.analyze({ url: `http://127.0.0.1:${allowedPort}/`, networkPolicy: policy(), timeout: 15_000 });
      expect(r.elements.some((e) => e.element.text === 'ok')).toBe(true);
      expect(internalHits).toBe(0);
    }), 60_000);

  it('blocks forbidden subresources in inline HTML too', () =>
    withAgent(async (agent) => {
      await agent.analyze({
        html: `<button>x</button><img src="http://127.0.0.1:${internalPort}/a.png">`,
        networkPolicy: { allowPrivateNetwork: false },
        timeout: 15_000,
      });
      expect(internalHits).toBe(0);
    }), 60_000);

  it('leaves traffic alone when private networks are allowed (the default for a local server)', () =>
    withAgent(async (agent) => {
      await agent.analyze({ url: `http://127.0.0.1:${allowedPort}/`, networkPolicy: { allowPrivateNetwork: true }, timeout: 15_000 });
      expect(internalHits).toBeGreaterThan(0);
    }), 60_000);

  it('does not intercept anything when no policy is set', () =>
    withAgent(async (agent) => {
      await agent.analyze({ url: `http://127.0.0.1:${allowedPort}/`, timeout: 15_000 });
      expect(internalHits).toBeGreaterThan(0);
    }), 60_000);
});
