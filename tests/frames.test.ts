// ============================================================
// Tests: iframe support, storageState auth, DOM settle wait
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocatorAgent } from '../src/agent';
import { formatWithFrames, playwrightFramePrefix } from '../src/util/frames';
import { LocatorResult } from '../src/types';

const esc = (html: string) => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

describe('formatWithFrames', () => {
  const base: LocatorResult = {
    strategy: 'ariaRole', value: "getByRole('button', { name: 'Pay' })", framework: 'playwright',
    score: 0, scoreReason: '',
  };

  it('returns the value unchanged outside iframes', () => {
    expect(formatWithFrames(base)).toBe(base.value);
  });

  it('prefixes playwright locators with the frameLocator chain', () => {
    const out = formatWithFrames({ ...base, framePath: ['iframe#a', 'iframe[name="b"]'] });
    expect(out).toBe(`page.frameLocator("iframe#a").frameLocator("iframe[name=\\"b\\"]").${base.value}`);
    expect(playwrightFramePrefix(['iframe#a'])).toBe('frameLocator("iframe#a")');
  });

  it('wraps plain selectors in locator() and annotates other frameworks', () => {
    const css: LocatorResult = { strategy: 'css', value: '#pay', framework: 'playwright', score: 0, scoreReason: '' };
    expect(formatWithFrames({ ...css, framePath: ['iframe#a'] })).toBe('page.frameLocator("iframe#a").locator("#pay")');
    const sel: LocatorResult = { strategy: 'id', value: 'pay', framework: 'selenium', score: 0, scoreReason: '' };
    expect(formatWithFrames({ ...sel, framePath: ['iframe#a'] })).toContain('in iframe: iframe#a');
  });
});

describe('iframes', () => {
  let agent: LocatorAgent;
  beforeAll(() => { agent = new LocatorAgent(); });
  afterAll(async () => { await agent.shutdown(); });

  it('discovers elements inside an iframe and validates them in that frame', async () => {
    const inner = '<button data-testid="pay-btn">Pay now</button>';
    const html = `<html><body>
      <button id="outer-btn">Outer</button>
      <iframe id="checkout" srcdoc="${esc(inner)}"></iframe>
    </body></html>`;

    const result = await agent.analyze({ html });
    expect(result.framesAnalyzed).toBe(2);

    const pay = result.elements.find((e) => e.element.attributes['data-testid'] === 'pay-btn');
    expect(pay).toBeDefined();
    expect(pay!.element.framePath).toEqual(['iframe#checkout']);
    expect(pay!.recommended.framePath).toEqual(['iframe#checkout']);
    expect(pay!.recommended.matchCount).toBe(1);
    expect(pay!.recommended.resolvesToTarget).toBe(true);
    const pw = pay!.locators.find((l) => l.framework === 'playwright' && l.value.startsWith('getBy'));
    expect(pw).toBeDefined();
    expect(pw!.framePath).toEqual(['iframe#checkout']);
    expect(formatWithFrames(pw!).startsWith('page.frameLocator("iframe#checkout").getBy')).toBe(true);

    const outer = result.elements.find((e) => e.element.attributes['id'] === 'outer-btn');
    expect(outer!.element.framePath).toBeUndefined();
  }, 30_000);

  it('keeps identical elements in different iframes distinct', async () => {
    const inner = '<button data-testid="go">Go</button>';
    const html = `<html><body>
      <iframe name="left" srcdoc="${esc(inner)}"></iframe>
      <iframe name="right" srcdoc="${esc(inner)}"></iframe>
    </body></html>`;

    const result = await agent.analyze({ html });
    const goButtons = result.elements.filter((e) => e.element.attributes['data-testid'] === 'go');

    expect(goButtons).toHaveLength(2);
    const paths = goButtons.map((g) => g.element.framePath!.join('|')).sort();
    expect(paths).toEqual(['iframe[name="left"]', 'iframe[name="right"]']);
    for (const g of goButtons) {
      // Each is unique *within its own frame*
      expect(g.recommended.matchCount).toBe(1);
      expect(g.recommended.resolvesToTarget).toBe(true);
    }
  }, 30_000);

  it('traverses nested iframes', async () => {
    const innermost = '<input name="card" placeholder="Card number">';
    const middle = `<iframe id="card-frame" srcdoc="${esc(innermost)}"></iframe>`;
    const html = `<html><body><iframe id="outer" srcdoc="${esc(middle)}"></iframe></body></html>`;

    const result = await agent.analyze({ html });
    const card = result.elements.find((e) => e.element.attributes['name'] === 'card');

    expect(card).toBeDefined();
    expect(card!.element.framePath).toEqual(['iframe#outer', 'iframe#card-frame']);
    expect(card!.recommended.matchCount).toBe(1);
  }, 30_000);

  it('falls back to a positional selector for anonymous iframes', async () => {
    const inner = '<button data-testid="anon">Anon</button>';
    const html = `<html><body><iframe srcdoc="${esc(inner)}"></iframe></body></html>`;

    const result = await agent.analyze({ html });
    const el = result.elements.find((e) => e.element.attributes['data-testid'] === 'anon');

    expect(el).toBeDefined();
    expect(el!.element.framePath).toEqual(['iframe >> nth=0']);
  }, 30_000);
});

describe('page loading', () => {
  let agent: LocatorAgent;
  beforeAll(() => { agent = new LocatorAgent(); });
  afterAll(async () => { await agent.shutdown(); });

  it('waits for a page that is still rendering in bursts', async () => {
    // Simulates a component framework rendering progressively: a DOM change
    // every 150ms (inside the 300ms quiet window), with the button added last.
    const html = `<html><body>
      <div id="root"></div>
      <script>
        let n = 0;
        const timer = setInterval(() => {
          const root = document.getElementById('root');
          n++;
          if (n < 8) {
            root.appendChild(document.createElement('span'));
          } else {
            const b = document.createElement('button');
            b.setAttribute('data-testid', 'late-btn');
            b.textContent = 'Late';
            root.appendChild(b);
            clearInterval(timer);
          }
        }, 150);
      </script></body></html>`;

    const result = await agent.analyze({ html });
    expect(result.elements.some((e) => e.element.attributes['data-testid'] === 'late-btn')).toBe(true);
  }, 30_000);

  it('rejects a missing storageState file with a clear error', async () => {
    await expect(
      agent.analyze({ html: '<button>x</button>', storageState: path.join(os.tmpdir(), 'nope-state.json') }),
    ).rejects.toThrow(/Storage state file not found/);
  }, 30_000);

  it('applies a storageState file to the browser context', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'la-state-')), 'state.json');
    fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
    try {
      const result = await agent.analyze({ html: '<button data-testid="ok">OK</button>', storageState: file });
      expect(result.elements.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }, 30_000);
});
