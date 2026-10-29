// ============================================================
// Filtering forward proxy
//
// Chromium is pointed at this proxy when the network policy forbids private
// addresses. Every connection the page makes (navigations, every redirect hop,
// subresources, WebSockets) arrives here, is checked, and is then made to the
// *address that was checked*, so neither redirects nor DNS rebinding can reach
// an internal host.
//
// HTTPS is tunnelled with CONNECT; nothing is decrypted.
// ============================================================

import * as http from 'http';
import * as net from 'net';
import { AccessError, Lookup, NetworkPolicy, resolveAllowedAddress } from './guards';

export interface FilteringProxy {
  /** `http://127.0.0.1:<port>`: give this to the browser as its proxy server */
  url: string;
  /** `host:port` targets refused so far, with the reason */
  blocked(): ReadonlyMap<string, string>;
  close(): Promise<void>;
}

const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'];

/** "example.com:443" / "[::1]:443" -> { host, port } */
function splitHostPort(target: string, defaultPort: number): { host: string; port: number } {
  const m = target.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? target.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) throw new AccessError(`Invalid target ${target}`);
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
}

export async function startFilteringProxy(policy: NetworkPolicy, lookup?: Lookup): Promise<FilteringProxy> {
  const blocked = new Map<string, string>();

  const check = async (host: string, port: number): Promise<string> => {
    try {
      return await resolveAllowedAddress(host, port, policy, lookup);
    } catch (err: any) {
      blocked.set(`${host.replace(/^\[|\]$/g, '').toLowerCase()}:${port}`, err.message);
      throw err;
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      let target: URL;
      try {
        target = new URL(req.url ?? '');
      } catch {
        throw new AccessError('Proxy requests must use an absolute URL');
      }
      if (target.protocol !== 'http:') throw new AccessError(`Scheme ${target.protocol} is not proxied`);
      const port = Number(target.port) || 80;
      const address = await check(target.hostname, port);

      const headers = { ...req.headers };
      for (const h of HOP_BY_HOP) delete headers[h];
      const upstream = http.request(
        { host: address, port, path: target.pathname + target.search, method: req.method, headers, agent: false },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch (err: any) {
      // The reason travels in a header so the loader can tell a policy block from a normal 403
      res.writeHead(403, { 'content-type': 'text/plain', 'x-locator-agent-blocked': 'policy' });
      res.end(err?.message ?? 'Blocked');
    }
  });

  server.on('connect', async (req, clientSocket: net.Socket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());
    try {
      const { host, port } = splitHostPort(req.url ?? '', 443);
      const address = await check(host, port);
      const upstream = net.connect(port, address, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstream.destroy());
    } catch {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    blocked: () => blocked,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
