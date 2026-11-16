// ============================================================
// Tests: the browser extension's in-page engine must agree with the
// Playwright pipeline. Both analyse the same page; every locator's
// match count and "hits the target" result, and every recommendation,
// has to be identical.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, Browser, Page } from 'playwright';
import { LocatorAgent } from '../src/agent';
import type { ElementAnalysis, LocatorResult, PageAnalysis } from '../src/types';

const root = path.resolve(__dirname, '..');
const key = (l: LocatorResult) => `${l.strategy}::${l.framework}::${l.value}`;

declare const LocatorAgentEngine: {
  analyzePage(doc: unknown, opts?: { includeNonInteractive?: boolean; maxElements?: number }): Promise<PageAnalysis>;
  analyzeElement(el: unknown): Promise<ElementAnalysis | null>;
};

let bundle: string;
let browser: Browser;
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-engine-'));
  bundle = path.join(tmp, 'engine.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildExtension } = require(path.join(root, 'scripts', 'build-extension.js'));
  await buildExtension({ engineOut: bundle });
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function enginePage(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.addScriptTag({ path: bundle });
  return page;
}

const fixtures: Record<string, string> = {
  'sample page': fs.readFileSync(path.join(root, 'public', 'demo.html'), 'utf8'),
  'rich fixture': fs.readFileSync(path.join(__dirname, 'fixtures', 'extension-rich.html'), 'utf8'),
};

describe('extension engine', () => {
  it('is built without eval or new Function (extensions forbid both)', () => {
    const code = fs.readFileSync(bundle, 'utf8');
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/new Function\s*\(/);
  });

  for (const [name, html] of Object.entries(fixtures)) {
    it(`matches the Playwright pipeline on the ${name}`, async () => {
      const agent = new LocatorAgent();
      let reference: PageAnalysis;
      try {
        reference = await agent.analyze({ html, maxElements: 500 });
      } finally {
        await agent.shutdown();
      }

      const page = await enginePage(html);
      const ext = await page.evaluate(() => LocatorAgentEngine.analyzePage(document, { maxElements: 500 }));
      await page.close();

      // Iframe contents are analysed per frame by the extension, not in one pass
      const mainDocument = reference.elements.filter((e) => !e.element.framePath);
      const byIndex = new Map(ext.elements.map((e) => [e.element.nodeIndex, e]));
      expect(ext.elements.length).toBe(mainDocument.length);

      const problems: string[] = [];
      let compared = 0;
      for (const r of mainDocument) {
        const e = byIndex.get(r.element.nodeIndex);
        if (!e) { problems.push(`missing element ${r.element.tag} #${r.element.nodeIndex}`); continue; }
        const extLocators = new Map(e.locators.map((l) => [key(l), l]));
        expect(new Set(extLocators.keys())).toEqual(new Set(r.locators.map(key)));
        for (const rl of r.locators) {
          const el = extLocators.get(key(rl))!;
          compared++;
          if (rl.matchCount !== el.matchCount || rl.resolvesToTarget !== el.resolvesToTarget) {
            problems.push(`${key(rl)}: playwright ${rl.matchCount}/${rl.resolvesToTarget} vs engine ${el.matchCount}/${el.resolvesToTarget}`);
          }
        }
        if (r.recommended.value !== e.recommended.value) {
          problems.push(`recommended differs for <${r.element.tag}>: ${r.recommended.value} vs ${e.recommended.value}`);
        }
      }

      expect(problems).toEqual([]);
      expect(compared).toBeGreaterThan(100);
      // (neither fixture has shadow roots inside its iframe, so the counts agree)
      expect(ext.shadowRootsPierced).toBe(reference.shadowRootsPierced);
    }, 180_000);
  }

  it('analyses a single picked element, including one inside Shadow DOM', async () => {
    const page = await enginePage(fixtures['sample page']);
    const result = await page.evaluate(async () => {
      const toolbar = document.querySelector('acme-toolbar')!.shadowRoot!;
      const button = toolbar.querySelector('acme-icon-button')!.shadowRoot!.querySelector('button')!;
      const a = await LocatorAgentEngine.analyzeElement(button);
      return a && { tag: a.element.tag, depth: a.element.shadowDepth, best: a.recommended.value, matches: a.recommended.matchCount };
    });
    await page.close();
    expect(result).toEqual({ tag: 'button', depth: 2, best: "getByRole('button', { name: 'Settings' })", matches: 1 });
  }, 60_000);

  it('builds row-scoped locators for a repeated element', async () => {
    const page = await enginePage(fixtures['sample page']);
    const result = await page.evaluate(async () => {
      const del = document.querySelectorAll('table button')[3]; // second row's Delete
      const a = await LocatorAgentEngine.analyzeElement(del);
      return a && { best: a.recommended.value, strategy: a.recommended.strategy, unique: a.recommended.isUnique };
    });
    await page.close();
    expect(result?.strategy).toBe('scoped');
    expect(result?.best).toContain('INV-1042');
    expect(result?.unique).toBe(true);
  }, 60_000);

  it('describes the iframe path for an element inside a same-origin iframe', async () => {
    const page = await enginePage(fixtures['sample page']);
    const result = await page.evaluate(async () => {
      const frame = document.querySelector('iframe') as HTMLIFrameElement;
      const inner = frame.contentDocument!.querySelector('button')!;
      const a = await LocatorAgentEngine.analyzeElement(inner);
      return a && { framePath: a.element.framePath, best: a.recommended.value, matches: a.recommended.matchCount };
    });
    await page.close();
    expect(result?.framePath).toEqual(['iframe[title="Newsletter"]']);
    expect(result?.matches).toBe(1);
  }, 60_000);

  it('returns null for nodes outside the page body', async () => {
    const page = await enginePage('<button>x</button>');
    const result = await page.evaluate(async () => LocatorAgentEngine.analyzeElement(document.documentElement));
    await page.close();
    expect(result).toBeNull();
  }, 30_000);
});
