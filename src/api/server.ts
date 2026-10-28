// ============================================================
// LocatorAgent REST API Server
// Express-based API for locator generation.
// Includes WebSocket server for live browser sessions.
// ============================================================

import express, { Request, Response } from 'express';
import path from 'path';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { LocatorAgent } from '../agent';
import { BrowserSession, NativeBrowserSession } from '../browser';
import { AgentInput } from '../types';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Serve the static web UI
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

const PORT = process.env.PORT || 3000;

// ── Active browser sessions ──────────────────────
const sessions = new Map<string, BrowserSession>();
const nativeSessions = new Map<string, NativeBrowserSession>();
let sessionCounter = 0;

/**
 * POST /analyze
 * Accepts { url, html, filePath, includeNonInteractive, maxElements, timeout, storageState }
 */
app.post('/analyze', async (req: Request, res: Response) => {
  const { url, html, filePath, includeNonInteractive, maxElements, timeout, storageState } = req.body;

  if (!url && !html && !filePath) {
    res.status(400).json({
      error: 'Provide at least one of: url, html, filePath',
    });
    return;
  }

  const input: AgentInput = {
    url,
    html,
    filePath,
    includeNonInteractive: includeNonInteractive ?? false,
    maxElements: maxElements ?? 100,
    timeout: timeout ?? 30000,
    storageState,
  };

  const agent = new LocatorAgent();

  try {
    const result = await agent.analyze(input);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      error: err.message || 'Internal server error',
    });
  } finally {
    await agent.shutdown();
  }
});

/**
 * POST /analyze/element
 * Targeted analysis: same as /analyze but filter the output
 * to elements matching a text/attribute query.
 */
app.post('/analyze/element', async (req: Request, res: Response) => {
  const { url, html, filePath, query, timeout, storageState } = req.body;

  if (!url && !html && !filePath) {
    res.status(400).json({
      error: 'Provide at least one of: url, html, filePath',
    });
    return;
  }

  if (!query) {
    res.status(400).json({
      error: 'Provide a "query" to match elements (text, id, name, data-testid, etc.)',
    });
    return;
  }

  const input: AgentInput = {
    url,
    html,
    filePath,
    includeNonInteractive: true,
    maxElements: 500,
    timeout: timeout ?? 30000,
    storageState,
  };

  const agent = new LocatorAgent();

  try {
    const result = await agent.analyze(input);

    // Filter elements matching the query
    const queryLower = (query as string).toLowerCase();
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

    res.json({
      ...result,
      elements: matched,
      interactiveElementsFound: matched.length,
      query,
    });
  } catch (err: any) {
    res.status(500).json({
      error: err.message || 'Internal server error',
    });
  } finally {
    await agent.shutdown();
  }
});

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

// Route WebSocket upgrades by path
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://localhost:${PORT}`).pathname;

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
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const startUrl = url.searchParams.get('url') || undefined;

  console.log(`🖥️  New browser session: ${sessionId}${startUrl ? ` → ${startUrl}` : ''}`);

  const session = new BrowserSession(sessionId);
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
app.get('/sessions', (_req: Request, res: Response) => {
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

  const url = new URL(req.url || '', `http://localhost:${PORT}`);
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

server.listen(PORT, () => {
  console.log(`🚀 LocatorAgent API listening on http://localhost:${PORT}`);
  console.log(`🖥️  Live browser sessions: ws://localhost:${PORT}/ws/browser`);
  console.log(`🌐 Native browser mode: http://localhost:${PORT}/native.html`);
  console.log(`📄 Web UI: http://localhost:${PORT}/`);
  console.log(`🖥️  Embedded browser: http://localhost:${PORT}/browser.html`);
});

export default app;
