// ============================================================
// Page Loader
// Loads a web page from a URL or an HTML file/string using
// Playwright, then runs the Shadow DOM traversal script.
// ============================================================

import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { AgentInput, LoadedPage, SerializedNode } from '../types';
import { getBrowserTraversalScript, parseTraversalResult } from '../traverser/shadowDomTraverser';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

/**
 * Result from loadWithPage — includes a live Playwright Page
 * that must be cleaned up by calling `cleanup()`.
 */
export interface LoadedPageWithHandle extends LoadedPage {
  /** The live Playwright Page — usable for validation queries */
  page: Page;
  /** Call this when done to close the context and release resources */
  cleanup: () => Promise<void>;
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
   * traverse its DOM (including Shadow DOM), and return the results.
   */
  async load(input: AgentInput): Promise<LoadedPage> {
    await this.launch();

    const context = await this.browser!.newContext({
      viewport: input.viewport || DEFAULT_VIEWPORT,
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();
    const timeout = input.timeout || DEFAULT_TIMEOUT;

    try {
      let source = '';

      if (input.url) {
        // Load from URL
        source = input.url;
        await page.goto(input.url, {
          waitUntil: 'networkidle',
          timeout,
        });
      } else if (input.filePath) {
        // Load from HTML/MHTML file
        source = input.filePath;
        const resolved = path.resolve(input.filePath);

        if (!fs.existsSync(resolved)) {
          throw new Error(`File not found: ${resolved}`);
        }

        const content = fs.readFileSync(resolved, 'utf-8');
        await page.setContent(content, {
          waitUntil: 'networkidle',
          timeout,
        });
      } else if (input.html) {
        // Load from raw HTML string
        source = 'inline-html';
        await page.setContent(input.html, {
          waitUntil: 'networkidle',
          timeout,
        });
      } else {
        throw new Error('No input provided. Specify url, filePath, or html.');
      }

      // Allow any remaining JS to settle (web components, etc.)
      await page.waitForTimeout(500);

      // Run Shadow DOM traversal
      const script = getBrowserTraversalScript();
      const rawResult = await page.evaluate(script);
      const parsed = parseTraversalResult(rawResult);

      return {
        source,
        title: parsed.title,
        nodes: parsed.nodes,
        totalDomElements: parsed.totalElements,
        shadowRootsPierced: parsed.shadowRootCount,
      };
    } finally {
      await context.close();
    }
  }

  /**
   * Same as load(), but keeps the Page alive so callers can run
   * additional queries (e.g. locator validation).
   * The caller MUST invoke `cleanup()` on the result when done.
   */
  async loadWithPage(input: AgentInput): Promise<LoadedPageWithHandle> {
    await this.launch();

    const context = await this.browser!.newContext({
      viewport: input.viewport || DEFAULT_VIEWPORT,
      ignoreHTTPSErrors: true,
    });

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

    await page.waitForTimeout(500);

    const script = getBrowserTraversalScript();
    const rawResult = await page.evaluate(script);
    const parsed = parseTraversalResult(rawResult);

    return {
      source,
      title: parsed.title,
      nodes: parsed.nodes,
      totalDomElements: parsed.totalElements,
      shadowRootsPierced: parsed.shadowRootCount,
      page,
      cleanup: async () => { await context.close(); },
    };
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
