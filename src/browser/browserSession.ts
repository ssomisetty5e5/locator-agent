// ============================================================
// Browser Session Manager
// Manages a live, user-interactive Playwright browser session
// that streams viewport screenshots over WebSocket and proxies
// user input events (mouse, keyboard) to the real browser.
// ============================================================

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { WebSocket } from 'ws';
import { getBrowserTraversalScript, parseTraversalResult } from '../traverser/shadowDomTraverser';
import { ElementDiscoverer } from '../discoverer';
import { LocatorGenerator } from '../generator';
import { LocatorRanker } from '../ranker';
import { LocatorValidator } from '../validator';
import {
  SerializedNode,
  LoadedPage,
  PageAnalysis,
  ElementAnalysis,
  DiscoveredElement,
} from '../types';

const VIEWPORT = { width: 1280, height: 900 };
const FRAME_INTERVAL_MS = 100; // ~10 fps for responsive feel

export interface SessionInfo {
  id: string;
  status: 'starting' | 'running' | 'closed';
  currentUrl: string;
}

export class BrowserSession {
  id: string;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private ws: WebSocket | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private status: 'starting' | 'running' | 'closed' = 'starting';
  private isCapturing = false; // prevent concurrent screenshots
  private inputQueue: Promise<void> = Promise.resolve(); // serialize input

  // Reuse the analysis pipeline
  private discoverer = new ElementDiscoverer();
  private generator = new LocatorGenerator();
  private ranker = new LocatorRanker();
  private validator = new LocatorValidator();
  private pendingFileChooser: any = null;

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Launch the browser, open a page, and start streaming to the WebSocket.
   */
  async start(ws: WebSocket, startUrl?: string): Promise<void> {
    this.ws = ws;

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: VIEWPORT,
      ignoreHTTPSErrors: true,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });

    this.page = await this.context.newPage();

    // Navigate to start URL or blank
    const url = startUrl || 'about:blank';
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      // ignore timeout on slow pages — we'll still stream whatever loaded
    }

    this.status = 'running';
    this.sendMessage({ type: 'session:started', url: this.page.url() });

    // Start streaming frames
    this.startFrameStream();

    // Listen for navigations
    this.page.on('framenavigated', (frame) => {
      if (frame === this.page!.mainFrame()) {
        this.sendMessage({ type: 'navigated', url: this.page!.url() });
      }
    });

    // Listen for file chooser dialogs
    this.page.on('filechooser', async (fileChooser) => {
      this.pendingFileChooser = fileChooser;
      this.sendMessage({
        type: 'filechooser:open',
        multiple: fileChooser.isMultiple(),
      });
    });

    // Handle WS messages from frontend
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.enqueueInput(msg);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      this.close();
    });
  }

  /**
   * Stream screenshots at regular intervals.
   */
  private startFrameStream(): void {
    this.frameTimer = setInterval(async () => {
      if (this.isCapturing || !this.page || this.status === 'closed' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      this.isCapturing = true;
      try {
        const buf = await this.page.screenshot({
          type: 'jpeg',
          quality: 70,
        });
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

  /**
   * Serialize input events so they don't overlap with each other.
   */
  private enqueueInput(msg: any): void {
    this.inputQueue = this.inputQueue
      .then(() => this.handleClientMessage(msg))
      .catch(() => {});
  }

  /**
   * Handle input events from the frontend.
   */
  private async handleClientMessage(msg: any): Promise<void> {
    if (!this.page || this.status === 'closed') return;

    try {
      switch (msg.type) {
        case 'navigate': {
          let url = msg.url as string;
          if (url && !url.startsWith('http')) url = 'https://' + url;
          await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
          this.sendMessage({ type: 'navigated', url: this.page.url() });
          break;
        }

        case 'mouse:click': {
          const opts: any = { button: msg.button || 'left' };
          if (msg.clickCount) opts.clickCount = msg.clickCount;
          await this.page.mouse.click(msg.x, msg.y, opts);
          break;
        }

        case 'mouse:down': {
          await this.page.mouse.move(msg.x, msg.y);
          await this.page.mouse.down({ button: msg.button || 'left' });
          break;
        }

        case 'mouse:up': {
          await this.page.mouse.up({ button: msg.button || 'left' });
          break;
        }

        case 'mouse:move': {
          await this.page.mouse.move(msg.x, msg.y);
          break;
        }

        case 'mouse:wheel': {
          await this.page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0);
          break;
        }

        case 'key:press': {
          // For single character presses or special keys
          await this.page.keyboard.press(msg.key);
          break;
        }

        case 'key:type': {
          // For typing strings of text into fields
          if (msg.text) {
            await this.page.keyboard.type(msg.text, { delay: 0 });
          }
          break;
        }

        case 'key:combo': {
          // For modifier combos: Ctrl+A, Ctrl+C, etc.
          if (msg.key) {
            await this.page.keyboard.press(msg.key);
          }
          break;
        }

        case 'analyze': {
          await this.runAnalysis(msg.includeNonInteractive, msg.maxElements);
          break;
        }

        case 'filechooser:setFiles': {
          if (this.pendingFileChooser && msg.files && msg.files.length > 0) {
            // msg.files is an array of { name, data } where data is base64
            const filePayloads = msg.files.map((f: any) => ({
              name: f.name,
              mimeType: f.mimeType || 'application/octet-stream',
              buffer: Buffer.from(f.data, 'base64'),
            }));
            await this.pendingFileChooser.setFiles(filePayloads);
            this.pendingFileChooser = null;
          }
          break;
        }

        case 'filechooser:cancel': {
          this.pendingFileChooser = null;
          break;
        }

        case 'screenshot': {
          const buf = await this.page.screenshot({ type: 'png', fullPage: false });
          this.sendMessage({ type: 'screenshot', data: buf.toString('base64') });
          break;
        }

        case 'inspect:hover': {
          // Highlight the element at (x, y) in the remote browser
          await this.inspectHover(msg.x, msg.y);
          break;
        }

        case 'inspect:click': {
          // Analyze the single element at (x, y)
          await this.inspectElement(msg.x, msg.y);
          break;
        }

        case 'inspect:off': {
          // Remove any highlights
          await this.clearInspectOverlay();
          break;
        }
      }
    } catch (err: any) {
      this.sendMessage({ type: 'error', message: err.message });
    }
  }

  /**
   * Highlight the element at the given viewport coordinates.
   * Injects a temporary overlay into the page.
   */
  private async inspectHover(x: number, y: number): Promise<void> {
    if (!this.page) return;

    const script = `(() => {
      const x = ${x}, y = ${y};
      let el = document.elementFromPoint(x, y);
      if (!el) {
        const old = document.getElementById('__locator_agent_overlay__');
        if (old) old.remove();
        const oldTip = document.getElementById('__locator_agent_tooltip__');
        if (oldTip) oldTip.remove();
        return;
      }
      let deepest = el;
      while (deepest.shadowRoot) {
        const inner = deepest.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === deepest) break;
        deepest = inner;
      }
      el = deepest;
      const rect = el.getBoundingClientRect();

      let overlay = document.getElementById('__locator_agent_overlay__');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = '__locator_agent_overlay__';
        overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #6c5ce7;background:rgba(108,92,231,0.12);transition:all 0.08s ease;';
        document.body.appendChild(overlay);
      }
      overlay.style.left = rect.left + 'px';
      overlay.style.top = rect.top + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';

      let tooltip = document.getElementById('__locator_agent_tooltip__');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = '__locator_agent_tooltip__';
        tooltip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#1a1d27;color:#e1e4ed;font:12px monospace;padding:4px 8px;border-radius:4px;border:1px solid #6c5ce7;white-space:nowrap;max-width:400px;overflow:hidden;text-overflow:ellipsis;';
        document.body.appendChild(tooltip);
      }
      const tag = el.tagName.toLowerCase();
      const idStr = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '';
      const testId = el.getAttribute('data-testid') ? ' [data-testid="' + el.getAttribute('data-testid') + '"]' : '';
      tooltip.textContent = '<' + tag + idStr + cls + '>' + testId;
      const tooltipTop = rect.top > 30 ? rect.top - 26 : rect.bottom + 4;
      tooltip.style.left = Math.max(0, rect.left) + 'px';
      tooltip.style.top = tooltipTop + 'px';
    })()`;
    await this.page.evaluate(script).catch(() => {});
  }

  /**
   * Inspect the element at coordinates — generate locators for it.
   */
  private async inspectElement(x: number, y: number): Promise<void> {
    if (!this.page) return;

    this.sendMessage({ type: 'inspect:start' });

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

        // Shadow depth and host chain (with qualified selectors)
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

        // Attributes
        const attrs = {};
        for (const attr of el.attributes || []) attrs[attr.name] = attr.value;

        // Direct text content
        let text = '';
        for (const child of el.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
        }
        text = text.trim().substring(0, 100);

        const ariaRole = el.getAttribute('role') || null;

        // CSS path
        const cssPath = [];
        let current = el;
        let pathDepth = 0;
        while (current && current !== document.body && pathDepth < 15) {
          const tag = current.tagName.toLowerCase();
          if (current.id) {
            cssPath.unshift(tag + '#' + CSS.escape(current.id));
            break;
          }
          const classes = Array.from(current.classList || [])
            .filter(c => !c.match(/^[a-z]{1,3}[0-9a-f]{4,}/i))
            .slice(0, 2);
          if (classes.length > 0) {
            cssPath.unshift(tag + '.' + classes.map(c => CSS.escape(c)).join('.'));
          } else {
            cssPath.unshift(tag);
          }
          const r = current.getRootNode();
          if (r instanceof ShadowRoot && r.host) {
            current = r.host;
          } else {
            current = current.parentElement;
          }
          pathDepth++;
        }

        // Bounding box
        const rect = el.getBoundingClientRect();
        const bbox = (rect.width > 0 || rect.height > 0)
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;

        // nth-of-type
        let nthOfType = 1;
        let siblingsOfSameType = 1;
        const parent = el.parentElement;
        if (parent) {
          let idx = 0, cnt = 0;
          for (const sib of parent.children) {
            if (sib.tagName === el.tagName) {
              cnt++;
              if (sib === el) idx = cnt;
            }
          }
          nthOfType = idx || 1;
          siblingsOfSameType = cnt || 1;
        }

        let htmlSnippet = '';
        try { htmlSnippet = el.outerHTML.substring(0, 300); } catch(e) {}

        return {
          tag: el.tagName.toLowerCase(),
          attributes: attrs,
          text: text,
          htmlSnippet: htmlSnippet,
          childCount: el.children ? el.children.length : 0,
          nthOfType: nthOfType,
          siblingsOfSameType: siblingsOfSameType,
          shadowDepth: shadowDepth,
          shadowHostChain: shadowHostChain,
          shadowHost: shadowHostChain.length > 0 ? shadowHostChain[shadowHostChain.length - 1] : null,
          ariaRole: ariaRole,
          cssPathSegments: cssPath,
          boundingBox: bbox,
          isInteractive: true,
        };
      })()`;

      const elementData = await this.page.evaluate(inspectScript) as any;

      if (!elementData) {
        this.sendMessage({ type: 'inspect:result', data: null });
        return;
      }

      // Convert to DiscoveredElement and generate locators
      const element: DiscoveredElement = {
        uid: `inspect-${Date.now()}`,
        ...elementData,
      };

      const rawLocators = this.generator.generate(element);

      // Validate uniqueness against the live page
      await this.validator.validate(this.page!, rawLocators);

      // Rank (now includes uniqueness bonuses/penalties)
      const ranked = this.ranker.rank(rawLocators, element);
      const recommended = ranked.length > 0
        ? this.ranker.getBest(ranked)
        : { strategy: 'css' as const, value: element.tag, framework: 'css' as const, score: 0, scoreReason: 'No locators generated' };

      const analysis: ElementAnalysis = {
        element,
        locators: ranked,
        recommended,
      };

      this.sendMessage({ type: 'inspect:result', data: analysis });
    } catch (err: any) {
      this.sendMessage({ type: 'inspect:error', message: err.message });
    }
  }

  /**
   * Remove the inspect overlay from the page.
   */
  private async clearInspectOverlay(): Promise<void> {
    if (!this.page) return;
    await this.page.evaluate(`(() => {
      const overlay = document.getElementById('__locator_agent_overlay__');
      if (overlay) overlay.remove();
      const tooltip = document.getElementById('__locator_agent_tooltip__');
      if (tooltip) tooltip.remove();
    })()`).catch(() => {});
  }

  /**
   * Run the locator analysis pipeline on the currently loaded page.
   */
  private async runAnalysis(includeNonInteractive = false, maxElements = 100): Promise<void> {
    if (!this.page) return;

    this.sendMessage({ type: 'analyze:start' });

    try {
      // Wait a moment for any in-flight JS
      await this.page.waitForTimeout(300);

      // Run traversal
      const script = getBrowserTraversalScript();
      const rawResult = await this.page.evaluate(script);
      const parsed = parseTraversalResult(rawResult);

      // Discover elements
      const elements = this.discoverer.discover(
        parsed.nodes,
        includeNonInteractive,
        maxElements,
      );

      // Generate locators
      const elementAnalyses: ElementAnalysis[] = [];
      for (const el of elements) {
        const rawLocators = this.generator.generate(el);

        // Validate uniqueness against the live page
        await this.validator.validate(this.page!, rawLocators, undefined, el.nodeIndex);

        // Rank (now includes uniqueness bonuses/penalties)
        const ranked = this.ranker.rank(rawLocators, el);
        const recommended = ranked.length > 0
          ? this.ranker.getBest(ranked)
          : { strategy: 'css' as const, value: el.tag, framework: 'css' as const, score: 0, scoreReason: 'No locators generated' };
        elementAnalyses.push({ element: el, locators: ranked, recommended } as ElementAnalysis);
      }

      const result: PageAnalysis = {
        source: this.page.url(),
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

  /**
   * Send a JSON message to the frontend WebSocket.
   */
  private sendMessage(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Clean up everything.
   */
  async close(): Promise<void> {
    this.status = 'closed';
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.page = null;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  getInfo(): SessionInfo {
    return {
      id: this.id,
      status: this.status,
      currentUrl: this.page?.url() || '',
    };
  }
}
