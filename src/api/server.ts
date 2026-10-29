// ============================================================
// LocatorAgent REST API Server
// Express-based API for locator generation.
// Includes WebSocket server for live browser sessions.
//
// Secure by default: binds to loopback, only accepts loopback Host
// headers, refuses cross-site browser requests, and disables
// server-side file access unless LA_ROOT is set. See ./config.ts.
// ============================================================

import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { LocatorAgent } from '../agent';
import { BrowserSession, NativeBrowserSession } from '../browser';
import { AgentInput } from '../types';
import {
  AccessError,
  BadRequestError,
  assertUrlAllowed,
  resolveInsideRoot,
} from '../security/guards';
import {
  ServerConfig,
  isAuthorized,
  isHostAllowed,
  isOriginAllowed,
  loadConfig,
  tokenFromHeaders,
} from './config';

/** Page-load timeout and element limits a caller may ask for */
const MAX_TIMEOUT_MS = 120_000;
const MAX_ELEMENTS = 1000;

const clamp = (value: unknown, fallback: number, max: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(1, n), max);
};

function requireString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestError(`"${name}" must be a string`);
  return value;
}

export function createServer(config: ServerConfig = loadConfig()) {
  const app = express();
  const networkPolicy = { allowPrivateNetwork: config.allowPrivateNetwork, allowedTargets: config.allowedTargets };
  let activeAnalyses = 0;

  // ── Cross-cutting checks ─────────────────────────
  // Host check first: defeats DNS rebinding for every route, static files included
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isHostAllowed(req.headers.host, config)) {
      res.status(403).json({ error: 'Host not allowed (see LA_ALLOWED_HOSTS)' });
      return;
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  // Serve the static web UI
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  /** Browser origin + token checks for everything that does work or reveals state */
  const protect = (req: Request, res: Response, next: NextFunction) => {
    if (!isOriginAllowed(req.headers.origin, req.headers.host, config)) {
      res.status(403).json({ error: 'Cross-origin requests are not allowed (see LA_ALLOWED_ORIGINS)' });
      return;
    }
    if (!isAuthorized(tokenFromHeaders(req.headers), config)) {
      res.status(401).json({ error: 'Missing or invalid API token' });
      return;
    }
    next();
  };

  /** Turn a request body into a safe AgentInput, or throw BadRequestError/AccessError */
  async function buildInput(body: any, overrides: Partial<AgentInput> = {}): Promise<AgentInput> {
    const url = requireString(body.url, 'url');
    const html = requireString(body.html, 'html');
    const filePath = requireString(body.filePath, 'filePath');
    const storageState = requireString(body.storageState, 'storageState');

    if (!url && !html && !filePath) {
      throw new BadRequestError('Provide at least one of: url, html, filePath');
    }

    if (url) await assertUrlAllowed(url, networkPolicy);

    return {
      url,
      html,
      filePath: filePath ? resolveInsideRoot(config.root, filePath, 'filePath') : undefined,
      storageState: storageState ? resolveInsideRoot(config.root, storageState, 'storageState') : undefined,
      includeNonInteractive: body.includeNonInteractive === true,
      maxElements: clamp(body.maxElements, 100, MAX_ELEMENTS),
      timeout: clamp(body.timeout, 30_000, MAX_TIMEOUT_MS),
      networkPolicy,
      ...overrides,
    };
  }

  /** Run one analysis job with the concurrency cap, mapping errors to HTTP statuses */
  async function handle(res: Response, job: () => Promise<unknown>): Promise<void> {
    if (activeAnalyses >= config.maxConcurrent) {
      res.status(429).json({ error: 'Too many analyses in progress, retry shortly' });
      return;
    }
    activeAnalyses++;
    try {
      res.json(await job());
    } catch (err: any) {
      const message = err?.message || 'Internal server error';
      const status =
        err instanceof AccessError ? 403
        : err instanceof BadRequestError || /Unsupported language/.test(message) ? 400
        : 500;
      res.status(status).json({ error: message });
    } finally {
      activeAnalyses--;
    }
  }

  /**
   * POST /analyze
   * Accepts { url, html, filePath, includeNonInteractive, maxElements, timeout, storageState }
   */
  app.post('/analyze', protect, (req: Request, res: Response) =>
    handle(res, async () => {
      const input = await buildInput(req.body ?? {});
      const agent = new LocatorAgent();
      try {
        return await agent.analyze(input);
      } finally {
        await agent.shutdown();
      }
    }),
  );

  /**
   * POST /generate/page-object
   * Accepts the same inputs as /analyze plus { className, language, javaPackage, minScore, importFrom, noGoto }
   * (language: 'typescript' | 'python' | 'java') and returns { className, language, code, elements, skipped }.
   */
  app.post('/generate/page-object', protect, (req: Request, res: Response) =>
    handle(res, async () => {
      const body = req.body ?? {};
      const input = await buildInput(body);
      const { className, minScore, importFrom, noGoto, language, javaPackage } = body;
      const agent = new LocatorAgent();
      try {
        return await agent.generatePageObject(input, { className, minScore, importFrom, noGoto, language, javaPackage });
      } finally {
        await agent.shutdown();
      }
    }),
  );

  /**
   * POST /analyze/element
   * Targeted analysis: same as /analyze but filter the output
   * to elements matching a text/attribute query.
   */
  app.post('/analyze/element', protect, (req: Request, res: Response) =>
    handle(res, async () => {
      const body = req.body ?? {};
      const query = requireString(body.query, 'query');
      const input = await buildInput(body, { includeNonInteractive: true, maxElements: MAX_ELEMENTS / 2 });
      if (!query) {
        throw new BadRequestError('Provide a "query" to match elements (text, id, name, data-testid, etc.)');
      }

      const agent = new LocatorAgent();
      try {
        const result = await agent.analyze(input);

        // Filter elements matching the query
        const queryLower = query.toLowerCase();
        const matched = result.elements.filter((el) => {
          const e = el.element;
          // Match against text, id, name, data-testid, aria-label, placeholder, class
          return (
            e.text?.toLowerCase().includes(queryLower) ||
            e.attributes['id']?.toLowerCase().includes(queryLower) ||
            e.attributes['name']?.toLowerCase().includes(queryLower) ||
            e.attributes['data-testid']?.toLowerCase().includes(queryLower) ||
            e.attributes['aria-label']?.toLowerCase().includes(queryLower) ||
            e.attributes['placeholder']?.toLowerCase().includes(queryLower) ||
            e.attributes['class']?.toLowerCase().includes(queryLower) ||
            e.tag.toLowerCase() === queryLower
          );
        });

        return { ...result, elements: matched, interactiveElementsFound: matched.length, query };
      } finally {
        await agent.shutdown();
      }
    }),
  );

  /**
   * GET /health
   */
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: '1.0.0' });
  });

  // ── HTTP Server + WebSocket ───────────────────────
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const nativeWss = new WebSocketServer({ noServer: true });

  const sessions = new Map<string, BrowserSession>();
  const nativeSessions = new Map<string, NativeBrowserSession>();
  let sessionCounter = 0;

  /** WebSocket handshakes bypass Express, so apply the same checks here */
  const rejectUpgrade = (socket: import('stream').Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  // Route WebSocket upgrades by path
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', 'http://localhost');
    const pathname = url.pathname;

    if (!isHostAllowed(request.headers.host, config) || !isOriginAllowed(request.headers.origin, request.headers.host, config)) {
      rejectUpgrade(socket, '403 Forbidden');
      return;
    }
    // Browsers cannot set headers on a WebSocket, so the token may come as ?token=
    const provided = tokenFromHeaders(request.headers) ?? url.searchParams.get('token') ?? undefined;
    if (!isAuthorized(provided, config)) {
      rejectUpgrade(socket, '401 Unauthorized');
      return;
    }

    if (pathname === '/ws/browser') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/native') {
      nativeWss.handleUpgrade(request, socket, head, (ws) => {
        nativeWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket, req) => {
    sessionCounter++;
    const sessionId = `session-${sessionCounter}`;

    // Parse the start URL from query params: /ws/browser?url=...
    const url = new URL(req.url || '', 'http://localhost');
    const startUrl = url.searchParams.get('url') || undefined;

    console.log(`🖥️  New browser session: ${sessionId}${startUrl ? ` → ${startUrl}` : ''}`);

    const session = new BrowserSession(sessionId, networkPolicy);
    sessions.set(sessionId, session);

    ws.on('close', async () => {
      console.log(`🖥️  Session closed: ${sessionId}`);
      await session.close();
      sessions.delete(sessionId);
    });

    ws.on('error', async () => {
      await session.close();
      sessions.delete(sessionId);
    });

    try {
      if (startUrl) await assertUrlAllowed(startUrl, networkPolicy);
      await session.start(ws, startUrl);
    } catch (err: any) {
      console.error(`Session ${sessionId} failed to start:`, err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to start browser: ' + err.message }));
        ws.close();
      }
      await session.close();
      sessions.delete(sessionId);
    }
  });

  /**
   * GET /sessions — List active browser sessions
   */
  app.get('/sessions', protect, (_req: Request, res: Response) => {
    const list = [
      ...Array.from(sessions.values()).map((s) => ({ ...s.getInfo(), mode: 'embedded' })),
      ...Array.from(nativeSessions.values()).map((s) => ({ ...s.getInfo(), mode: 'native' })),
    ];
    res.json(list);
  });

  // ── Native Browser WebSocket ──────────────────────
  nativeWss.on('connection', async (ws: WebSocket, req) => {
    sessionCounter++;
    const sessionId = `native-${sessionCounter}`;

    const url = new URL(req.url || '', 'http://localhost');
    const startUrl = url.searchParams.get('url') || undefined;

    console.log(`🌐 New native browser session: ${sessionId}${startUrl ? ` → ${startUrl}` : ''}`);

    const session = new NativeBrowserSession(sessionId);
    nativeSessions.set(sessionId, session);

    ws.on('close', async () => {
      console.log(`🌐 Native session closed: ${sessionId}`);
      await session.close();
      nativeSessions.delete(sessionId);
    });

    ws.on('error', async () => {
      await session.close();
      nativeSessions.delete(sessionId);
    });

    try {
      await session.start(ws, startUrl);
    } catch (err: any) {
      console.error(`Native session ${sessionId} failed to start:`, err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to start native browser: ' + err.message }));
        ws.close();
      }
      await session.close();
      nativeSessions.delete(sessionId);
    }
  });

  return { app, server };
}

export default createServer;

// Start listening only when run directly (`npm run start:api`), not when imported
if (require.main === module) {
  const config = loadConfig();
  const { server } = createServer(config);
  server.listen(config.port, config.host, () => {
    const base = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
    console.log(`🚀 LocatorAgent API listening on ${base}`);
    console.log(`🖥️  Live browser sessions: ${base.replace('http', 'ws')}/ws/browser`);
    console.log(`🌐 Native browser mode: ${base}/native.html`);
    console.log(`📄 Web UI: ${base}/`);
    console.log(`🖥️  Embedded browser: ${base}/browser.html`);
    if (!/^(127\.|localhost|::1)/.test(config.host) && !config.token) {
      console.warn('⚠️  Listening beyond loopback without LA_API_TOKEN: anyone who can reach this port can drive a browser.');
    }
    console.log(
      `🔒 File access: ${config.root ? config.root : 'disabled (set LA_ROOT)'} | private networks: ${config.allowPrivateNetwork ? 'allowed' : 'blocked'} | token: ${config.token ? 'required' : 'off'}`,
    );
  });
}
