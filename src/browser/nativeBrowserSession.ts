// ============================================================
// Native Browser Session Manager
// Connects to the user's own Chrome/Edge via CDP (Chrome DevTools
// Protocol) on --remote-debugging-port=9222, then streams
// screenshots over WebSocket and proxies input events — just
// like BrowserSession, but without launching a new browser.
// ============================================================

import { chromium, Browser, BrowserContext, Page, CDPSession } from 'playwright';
import { WebSocket } from 'ws';
import { getBrowserTraversalScript, parseTraversalResult } from '../traverser/shadowDomTraverser';
import { ElementDiscoverer } from '../discoverer';
import { LocatorGenerator } from '../generator';
import { LocatorRanker } from '../ranker';
import { LocatorValidator } from '../validator';
import {
  DiscoveredElement,
  ElementAnalysis,
  PageAnalysis,
} from '../types';

const VIEWPORT = { width: 1280, height: 900 };
const FRAME_INTERVAL_MS = 120; // ~8 fps – slightly lower than embedded to reduce load
const CDP_ENDPOINT = 'http://127.0.0.1:9222';

export interface NativeSessionInfo {
  id: string;
  status: 'starting' | 'running' | 'closed';
  currentUrl: string;
}

export class NativeBrowserSession {
  id: string;
  private browser: Browser | null = null;
  private activePage: Page | null = null;
  private cdp: CDPSession | null = null;
  private ws: WebSocket | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private status: 'starting' | 'running' | 'closed' = 'starting';
  private isCapturing = false;
  private inputQueue: Promise<void> = Promise.resolve();
  private inspectActive = false;
  private inspectPollTimer: ReturnType<typeof setInterval> | null = null;

  // Reuse the analysis pipeline
  private discoverer = new ElementDiscoverer();
  private generator = new LocatorGenerator();
  private ranker = new LocatorRanker();
  private validator = new LocatorValidator();

  constructor(id: string) {
    this.id = id;
  }

  /* ── Public API ─────────────────────────────── */

  async start(ws: WebSocket, _startUrl?: string): Promise<void> {
    this.ws = ws;

    try {
      this.browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    } catch (err: any) {
      this.sendMessage({
        type: 'connect:failed',
        message: 'Could not connect to Chrome via CDP on port 9222.',
        instructions:
          'Close all Chrome windows, then start Chrome with:\n\n' +
          '  chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\temp\\chrome-debug\n\n' +
          'Then click "Connect" again.',
      });
      return;
    }

    // Listen for disconnect
    this.browser.on('disconnected', () => {
      if (this.status !== 'closed') {
        this.sendMessage({ type: 'browser:disconnected' });
        this.close();
      }
    });

    this.status = 'running';
    this.sendMessage({ type: 'session:started' });

    // Handle WS messages from frontend
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.enqueueInput(msg);
      } catch { /* ignore */ }
    });

    ws.on('close', () => {
      this.close();
    });
  }

  async close(): Promise<void> {
    this.status = 'closed';
    this.stopFrameStream();
    this.stopInspectPoll();

    // Disconnect CDP — does NOT close the user's browser
    if (this.cdp) {
      try { await this.cdp.detach(); } catch {}
      this.cdp = null;
    }
    if (this.browser) {
      try { this.browser.removeAllListeners('disconnected'); } catch {}
      // Don't call browser.close() — that would kill the user's Chrome.
      // Just release the CDP connection.
      this.browser = null;
    }
    this.activePage = null;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  getInfo(): NativeSessionInfo {
    return {
      id: this.id,
      status: this.status,
      currentUrl: this.activePage?.url() || '',
    };
  }

  /* ── Frame streaming via CDP screencast ──────── */

  private async startFrameStream(): Promise<void> {
    this.stopFrameStream();

    if (!this.cdp || !this.ws) return;

    // Use Chrome's native screencast — much faster than page.screenshot() over CDP
    this.cdp.on('Page.screencastFrame', (params: any) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      // Acknowledge the frame so Chrome sends the next one
      this.cdp!.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});

      // Convert base64 data to buffer and send as binary
      const buf = Buffer.from(params.data, 'base64');
      this.ws.send(buf);
    });

    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    }).catch(() => {
      // Fallback to polling screenshots if screencast not supported
      console.log('Screencast not available, falling back to polling');
      this.startFallbackFrameStream();
    });
  }

  private startFallbackFrameStream(): void {
    this.frameTimer = setInterval(async () => {
      if (
        this.isCapturing ||
        !this.activePage ||
        this.status === 'closed' ||
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN
      ) return;

      this.isCapturing = true;
      try {
        const buf = await this.activePage.screenshot({ type: 'jpeg', quality: 60 });
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(buf);
        }
      } catch {
        // page might be navigating, skip frame
      } finally {
        this.isCapturing = false;
      }
    }, FRAME_INTERVAL_MS);
  }

  private stopFrameStream(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    // Stop CDP screencast if active
    if (this.cdp) {
      this.cdp.send('Page.stopScreencast').catch(() => {});
    }
  }

  /* ── Input serialisation ────────────────────── */

  private enqueueInput(msg: any): void {
    // mouse:move is fire-and-forget — don't queue it, don't block clicks
    if (msg.type === 'mouse:move') {
      if (this.cdp && this.status !== 'closed') {
        this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(msg.x),
          y: Math.round(msg.y),
        }).catch(() => {});
      }
      return;
    }
    this.inputQueue = this.inputQueue
      .then(() => this.handleClientMessage(msg))
      .catch(() => {});
  }

  private async handleClientMessage(msg: any): Promise<void> {
    if (this.status === 'closed') return;

    try {
      switch (msg.type) {
        /* ── Navigation ── */
        case 'navigate': {
          let url = (msg.url as string || '').trim();
          if (!url) return;
          if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

          // Reuse the existing page; on first navigate grab an existing tab instead of opening a new one
          if (!this.activePage) {
            const contexts = this.browser?.contexts() || [];
            const ctx = contexts[0];
            if (!ctx) return;

            // Try to reuse an existing page (Chrome always has at least one tab open)
            const pages = ctx.pages();
            let page: Page | null = null;
            if (pages.length > 0) {
              page = pages.find(p => {
                const u = p.url();
                return u === 'about:blank' || u === 'chrome://newtab/' || u === 'chrome://new-tab-page/';
              }) || pages[pages.length - 1];
            } else {
              page = await ctx.newPage();
            }

            await page.setViewportSize(VIEWPORT);
            this.activePage = page;

            // Create CDP session for raw input dispatching
            this.cdp = await page.context().newCDPSession(page);

            // Listen for in-page navigations (only wire once)
            page.on('framenavigated', (frame) => {
              if (frame === page!.mainFrame()) {
                this.sendMessage({ type: 'navigated', url: page!.url() });
              }
            });

            this.startFrameStream();
          }

          try {
            await this.activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          } catch {
            // partial load is fine, we'll stream what's there
          }

          const title = await this.activePage.title().catch(() => '');
          this.sendMessage({ type: 'navigate:done', url: this.activePage.url(), title });
          break;
        }

        /* ── Mouse events (via raw CDP for trusted input) ── */
        case 'mouse:click': {
          if (!this.cdp) return;
          const x = Math.round(msg.x);
          const y = Math.round(msg.y);
          const btn = msg.button === 'right' ? 'right' : msg.button === 'middle' ? 'middle' : 'left';
          const count = msg.clickCount || 1;
          await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: btn, clickCount: count });
          await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: btn, clickCount: count });
          break;
        }
        case 'mouse:wheel': {
          if (!this.cdp) return;
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: VIEWPORT.width / 2,
            y: VIEWPORT.height / 2,
            deltaX: msg.deltaX || 0,
            deltaY: msg.deltaY || 0,
          });
          break;
        }

        /* ── Keyboard events (via raw CDP for trusted input) ── */
        case 'key:press': {
          if (!this.activePage) return;
          await this.activePage.keyboard.press(msg.key);
          break;
        }
        case 'key:type': {
          if (!this.activePage) return;
          if (msg.text) {
            // Use CDP insertText for reliable text input
            if (this.cdp) {
              await this.cdp.send('Input.insertText', { text: msg.text });
            } else {
              await this.activePage.keyboard.type(msg.text, { delay: 0 });
            }
          }
          break;
        }

        /* ── Inspect ── */
        case 'inspect:start': {
          await this.startInspect();
          break;
        }
        case 'inspect:stop': {
          await this.stopInspect();
          break;
        }

        /* ── Analyze ── */
        case 'analyze': {
          await this.runAnalysis(msg.includeNonInteractive, msg.maxElements);
          break;
        }
      }
    } catch (err: any) {
      this.sendMessage({ type: 'error', message: err.message });
    }
  }

  /* ── Inspect mode ───────────────────────────── */

  private async startInspect(): Promise<void> {
    if (!this.activePage) return;
    this.inspectActive = true;
    this.sendMessage({ type: 'inspect:active' });

    // Inject overlay + click handler into the page
    const injectScript = `(() => {
      if (window.__locatorAgentInspect) return;
      window.__locatorAgentInspect = true;
      window.__locatorAgentClicked = null;

      const overlay = document.createElement('div');
      overlay.id = '__la_inspect_overlay__';
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #6c5ce7;background:rgba(108,92,231,0.12);transition:all 0.08s ease;display:none';
      document.body.appendChild(overlay);

      const tooltip = document.createElement('div');
      tooltip.id = '__la_inspect_tooltip__';
      tooltip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#1a1d27;color:#e1e4ed;font:12px monospace;padding:4px 8px;border-radius:4px;border:1px solid #6c5ce7;white-space:nowrap;max-width:400px;overflow:hidden;text-overflow:ellipsis;display:none';
      document.body.appendChild(tooltip);

      function deepElementFromPoint(x, y) {
        let el = document.elementFromPoint(x, y);
        if (!el) return null;
        let deepest = el;
        while (deepest.shadowRoot) {
          const inner = deepest.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === deepest) break;
          deepest = inner;
        }
        return deepest;
      }

      document.addEventListener('mousemove', function __laMove(e) {
        if (!window.__locatorAgentInspect) { document.removeEventListener('mousemove', __laMove, true); return; }
        const el = deepElementFromPoint(e.clientX, e.clientY);
        if (!el) { overlay.style.display = 'none'; tooltip.style.display = 'none'; return; }
        const rect = el.getBoundingClientRect();
        overlay.style.display = 'block';
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        const tag = el.tagName.toLowerCase();
        const idStr = el.id ? '#' + el.id : '';
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
        tooltip.textContent = '<' + tag + idStr + cls + '>';
        tooltip.style.display = 'block';
        const tt = rect.top > 30 ? rect.top - 26 : rect.bottom + 4;
        tooltip.style.left = Math.max(0, rect.left) + 'px';
        tooltip.style.top = tt + 'px';
      }, true);

      document.addEventListener('click', function __laClick(e) {
        if (!window.__locatorAgentInspect) { document.removeEventListener('click', __laClick, true); return; }
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        window.__locatorAgentClicked = { x: e.clientX, y: e.clientY };
      }, true);
    })()`;
    await this.activePage.evaluate(injectScript).catch(() => {});

    // Poll for clicks
    this.startInspectPoll();
  }

  private startInspectPoll(): void {
    this.stopInspectPoll();
    this.inspectPollTimer = setInterval(async () => {
      if (!this.inspectActive || !this.activePage || this.status === 'closed') {
        this.stopInspectPoll();
        return;
      }
      try {
        const clicked = await this.activePage.evaluate('window.__locatorAgentClicked');
        if (clicked) {
          await this.activePage.evaluate('window.__locatorAgentClicked = null');
          this.sendMessage({ type: 'inspect:generating' });
          await this.inspectElementAt((clicked as any).x, (clicked as any).y);
        }
      } catch {
        // page might have navigated, stop poll
        this.stopInspect();
      }
    }, 200);
  }

  private stopInspectPoll(): void {
    if (this.inspectPollTimer) {
      clearInterval(this.inspectPollTimer);
      this.inspectPollTimer = null;
    }
  }

  private async stopInspect(): Promise<void> {
    this.inspectActive = false;
    this.stopInspectPoll();

    if (this.activePage) {
      await this.activePage.evaluate(`(() => {
        window.__locatorAgentInspect = false;
        window.__locatorAgentClicked = null;
        const ov = document.getElementById('__la_inspect_overlay__');
        if (ov) ov.remove();
        const tt = document.getElementById('__la_inspect_tooltip__');
        if (tt) tt.remove();
      })()`).catch(() => {});
    }

    this.sendMessage({ type: 'inspect:stopped' });
  }

  private async inspectElementAt(x: number, y: number): Promise<void> {
    if (!this.activePage) return;

    try {
      const inspectScript = `(() => {
        const x = ${x}, y = ${y};
        let el = document.elementFromPoint(x, y);
        if (!el) return null;
        let deepest = el;
        while (deepest.shadowRoot) {
          const inner = deepest.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === deepest) break;
          deepest = inner;
        }
        el = deepest;

        function getHostSel(host) {
          const t = host.tagName.toLowerCase();
          const hid = host.id;
          if (hid && !hid.match(/^[a-f0-9]{8,}$/i) && !hid.match(/^:r[0-9a-z]+:$/)) {
            return t + '#' + CSS.escape(hid);
          }
          const keyAttrs = ['name', 'data-testid', 'label', 'icon', 'page', 'role', 'aria-label'];
          for (const a of keyAttrs) {
            const v = host.getAttribute(a);
            if (v) return t + '[' + a + '="' + v.replace(/"/g, '\\\\"') + '"]';
          }
          const cls = Array.from(host.classList || [])
            .filter(c => !c.match(/^[a-z]{1,3}[0-9a-f]{4,}/i)).slice(0, 2);
          if (cls.length > 0) return t + '.' + cls.map(c => CSS.escape(c)).join('.');
          return t;
        }
        let shadowDepth = 0;
        const shadowHostChain = [];
        let root = el.getRootNode();
        while (root instanceof ShadowRoot) {
          shadowDepth++;
          if (root.host) shadowHostChain.unshift(getHostSel(root.host));
          root = root.host.getRootNode();
        }

        const attrs = {};
        for (const attr of el.attributes || []) attrs[attr.name] = attr.value;

        let text = '';
        for (const child of el.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
        }
        text = text.trim().substring(0, 100);

        const ariaRole = el.getAttribute('role') || null;

        const cssPath = [];
        let current = el;
        let pathDepth = 0;
        while (current && current !== document.body && pathDepth < 15) {
          const tag = current.tagName.toLowerCase();
          if (current.id) { cssPath.unshift(tag + '#' + CSS.escape(current.id)); break; }
          const classes = Array.from(current.classList || [])
            .filter(c => !c.match(/^[a-z]{1,3}[0-9a-f]{4,}/i)).slice(0, 2);
          if (classes.length > 0) { cssPath.unshift(tag + '.' + classes.map(c => CSS.escape(c)).join('.')); }
          else { cssPath.unshift(tag); }
          const r = current.getRootNode();
          if (r instanceof ShadowRoot && r.host) { current = r.host; }
          else { current = current.parentElement; }
          pathDepth++;
        }

        const rect = el.getBoundingClientRect();
        const bbox = (rect.width > 0 || rect.height > 0) ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;

        let nthOfType = 1, siblingsOfSameType = 1;
        const parent = el.parentElement;
        if (parent) {
          let idx = 0, cnt = 0;
          for (const sib of parent.children) {
            if (sib.tagName === el.tagName) { cnt++; if (sib === el) idx = cnt; }
          }
          nthOfType = idx || 1;
          siblingsOfSameType = cnt || 1;
        }

        let htmlSnippet = '';
        try { htmlSnippet = el.outerHTML.substring(0, 300); } catch(e) {}

        return {
          tag: el.tagName.toLowerCase(),
          attributes: attrs,
          text, htmlSnippet,
          childCount: el.children ? el.children.length : 0,
          nthOfType, siblingsOfSameType,
          shadowDepth, shadowHostChain,
          shadowHost: shadowHostChain.length > 0 ? shadowHostChain[shadowHostChain.length - 1] : null,
          ariaRole,
          cssPathSegments: cssPath,
          boundingBox: bbox,
          isInteractive: true,
        };
      })()`;

      const elementData = await this.activePage.evaluate(inspectScript) as any;
      if (!elementData) {
        this.sendMessage({ type: 'inspect:result', data: null });
        return;
      }

      const element: DiscoveredElement = { uid: `inspect-${Date.now()}`, ...elementData };
      const rawLocators = this.generator.generate(element);
      await this.validator.validate(this.activePage!, rawLocators);
      const ranked = this.ranker.rank(rawLocators, element);
      const recommended = ranked.length > 0
        ? this.ranker.getBest(ranked)
        : { strategy: 'css' as const, value: element.tag, framework: 'css' as const, score: 0, scoreReason: 'No locators generated' };

      this.sendMessage({ type: 'inspect:result', data: { element, locators: ranked, recommended } as ElementAnalysis });
    } catch (err: any) {
      this.sendMessage({ type: 'inspect:error', message: err.message });
    }
  }

  /* ── Analysis ───────────────────────────────── */

  private async runAnalysis(includeNonInteractive = false, maxElements = 100): Promise<void> {
    if (!this.activePage) return;

    this.sendMessage({ type: 'analyze:start' });

    try {
      await this.activePage.waitForTimeout(300);

      const script = getBrowserTraversalScript();
      const rawResult = await this.activePage.evaluate(script);
      const parsed = parseTraversalResult(rawResult);

      const elements = this.discoverer.discover(parsed.nodes, includeNonInteractive, maxElements);

      const elementAnalyses: ElementAnalysis[] = [];
      for (const el of elements) {
        const rawLocators = this.generator.generate(el);
        await this.validator.validate(this.activePage!, rawLocators);
        const ranked = this.ranker.rank(rawLocators, el);
        const recommended = ranked.length > 0
          ? this.ranker.getBest(ranked)
          : { strategy: 'css' as const, value: el.tag, framework: 'css' as const, score: 0, scoreReason: 'No locators generated' };
        elementAnalyses.push({ element: el, locators: ranked, recommended } as ElementAnalysis);
      }

      const result: PageAnalysis = {
        source: this.activePage.url(),
        timestamp: new Date().toISOString(),
        pageTitle: parsed.title,
        totalDomElements: parsed.totalElements,
        interactiveElementsFound: elements.length,
        shadowRootsPierced: parsed.shadowRootCount,
        elements: elementAnalyses,
      };

      this.sendMessage({ type: 'analyze:result', data: result });
    } catch (err: any) {
      this.sendMessage({ type: 'analyze:error', message: err.message });
    }
  }

  /* ── Helpers ────────────────────────────────── */

  private sendMessage(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
