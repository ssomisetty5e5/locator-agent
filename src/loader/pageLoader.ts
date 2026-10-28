// ============================================================
// Page Loader
// Loads a web page from a URL or an HTML file/string using
// Playwright, then runs the Shadow DOM traversal script.
// ============================================================

import { chromium, Browser, Page, Frame } from 'playwright';
import { AgentInput, LoadedPage, SerializedNode } from '../types';
import { getBrowserTraversalScript, parseTraversalResult } from '../traverser/shadowDomTraverser';
import { buildFrameSelector } from './frameSelector';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const MAX_FRAME_DEPTH = 5;

/** Key used to look up a frame by its iframe selector path. */
const frameKey = (framePath?: string[]): string => (framePath ?? []).join(' >>> ');

/**
 * Wait until the DOM has stopped mutating (no changes for `quietMs`),
 * or `maxMs` has elapsed. Replaces a fixed sleep so slow component
 * frameworks get enough time and fast pages don't wait needlessly.
 */
async function waitForDomSettled(page: Page, quietMs = 300, maxMs = 3000): Promise<void> {
  try {
    // String script: this project compiles without DOM typings
    await page.evaluate(`new Promise((resolve) => {
      let timer;
      const done = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, ${quietMs});
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(done, ${quietMs});
      setTimeout(done, ${maxMs});
    })`);
  } catch {
    // Page navigated or closed while waiting — carry on with whatever is there
  }
}

/**
 * Result from loadWithPage — includes a live Playwright Page
 * that must be cleaned up by calling `cleanup()`.
 */
export interface LoadedPageWithHandle extends LoadedPage {
  /** The live Playwright Page — usable for validation queries */
  page: Page;
  /** Call this when done to close the context and release resources */
  cleanup: () => Promise<void>;
  /**
   * The Playwright Page or Frame in which an element lives. Pass the element's
   * `framePath` (absent/empty = main document).
   */
  getContext: (framePath?: string[]) => Page | Frame;
}

export class PageLoader {
  private browser: Browser | null = null;

  /**
   * Launch a headless browser instance.
   */
  async launch(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
  }

  /**
   * Close the browser instance.
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Load a page from a URL, file path, or raw HTML string,
   * traverse its DOM (including Shadow DOM and iframes), and return the results.
   */
  async load(input: AgentInput): Promise<LoadedPage> {
    const loaded = await this.loadWithPage(input);
    const { page: _page, cleanup, getContext: _getContext, ...rest } = loaded;
    await cleanup();
    return rest;
  }

  /**
   * Same as load(), but keeps the Page alive so callers can run
   * additional queries (e.g. locator validation).
   * The caller MUST invoke `cleanup()` on the result when done.
   */
  async loadWithPage(input: AgentInput): Promise<LoadedPageWithHandle> {
    await this.launch();

    if (input.storageState && !fs.existsSync(path.resolve(input.storageState))) {
      throw new Error(`Storage state file not found: ${path.resolve(input.storageState)}`);
    }

    const context = await this.browser!.newContext({
      viewport: input.viewport || DEFAULT_VIEWPORT,
      ignoreHTTPSErrors: true,
      ...(input.storageState ? { storageState: path.resolve(input.storageState) } : {}),
    });

    try {
      const page = await context.newPage();
      const timeout = input.timeout || DEFAULT_TIMEOUT;

      let source = '';

      if (input.url) {
        source = input.url;
        await page.goto(input.url, { waitUntil: 'networkidle', timeout });
      } else if (input.filePath) {
        source = input.filePath;
        const resolved = path.resolve(input.filePath);
        if (!fs.existsSync(resolved)) {
          throw new Error(`File not found: ${resolved}`);
        }
        const content = fs.readFileSync(resolved, 'utf-8');
        await page.setContent(content, { waitUntil: 'networkidle', timeout });
      } else if (input.html) {
        source = 'inline-html';
        await page.setContent(input.html, { waitUntil: 'networkidle', timeout });
      } else {
        throw new Error('No input provided. Specify url, filePath, or html.');
      }

      // Let web components, lazy renderers and iframes finish mutating the DOM
      await waitForDomSettled(page);

      const traversal = await this.traverseAllFrames(page);

      return {
        source,
        title: traversal.title,
        nodes: traversal.nodes,
        totalDomElements: traversal.totalElements,
        shadowRootsPierced: traversal.shadowRootCount,
        framesAnalyzed: traversal.frames.size,
        page,
        getContext: (framePath?: string[]) => traversal.frames.get(frameKey(framePath)) ?? page,
        cleanup: async () => { await context.close(); },
      };
    } catch (err) {
      await context.close();
      throw err;
    }
  }

  /**
   * Run the traversal script in the main frame and then in every
   * (nested) iframe, tagging each node with the iframe path that leads to it.
   * Frames that can't be inspected (detached, navigated away) are skipped.
   */
  private async traverseAllFrames(page: Page): Promise<{
    nodes: SerializedNode[];
    totalElements: number;
    shadowRootCount: number;
    title: string;
    frames: Map<string, Frame>;
  }> {
    const script = getBrowserTraversalScript();
    const nodes: SerializedNode[] = [];
    const frames = new Map<string, Frame>();
    let totalElements = 0;
    let shadowRootCount = 0;
    let title = '';

    const walk = async (frame: Frame, framePath: string[], depth: number): Promise<void> => {
      let parsed;
      try {
        parsed = parseTraversalResult(await frame.evaluate(script));
      } catch {
        return;
      }

      frames.set(frameKey(framePath), frame);
      if (framePath.length === 0) title = parsed.title;
      totalElements += parsed.totalElements;
      shadowRootCount += parsed.shadowRootCount;
      for (const node of parsed.nodes) {
        if (framePath.length > 0) node.framePath = framePath;
        nodes.push(node);
      }

      if (depth >= MAX_FRAME_DEPTH) return;
      for (const child of frame.childFrames()) {
        try {
          const selector = await buildFrameSelector(frame, child);
          await walk(child, [...framePath, selector], depth + 1);
        } catch {
          // detached or inaccessible frame — skip it
        }
      }
    };

    await walk(page.mainFrame(), [], 0);
    return { nodes, totalElements, shadowRootCount, title, frames };
  }

  /**
   * Take a screenshot of a page for debugging/visual context.
   */
  async screenshot(input: AgentInput, outputPath: string): Promise<string> {
    await this.launch();

    const context = await this.browser!.newContext({
      viewport: input.viewport || DEFAULT_VIEWPORT,
    });
    const page = await context.newPage();

    try {
      if (input.url) {
        await page.goto(input.url, { waitUntil: 'networkidle', timeout: input.timeout || DEFAULT_TIMEOUT });
      } else if (input.html) {
        await page.setContent(input.html, { waitUntil: 'networkidle' });
      }

      const resolved = path.resolve(outputPath);
      await page.screenshot({ path: resolved, fullPage: true });
      return resolved;
    } finally {
      await context.close();
    }
  }
}
