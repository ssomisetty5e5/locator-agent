// ============================================================
// Tests: scoped (ancestor-relative) locators for repeated elements
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LocatorAgent } from '../src/agent';
import { ScopedLocatorGenerator } from '../src/generator/scopedLocatorGenerator';
import { formatWithFrames } from '../src/util/frames';
import { AncestorInfo, DiscoveredElement, LocatorResult } from '../src/types';

const esc = (html: string) => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

describe('ScopedLocatorGenerator', () => {
  const gen = new ScopedLocatorGenerator();
  const el = { uid: 'u', tag: 'button', attributes: {}, framePath: undefined } as unknown as DiscoveredElement;
  const base: LocatorResult[] = [
    { strategy: 'ariaRole', value: "getByRole('button', { name: 'Delete' })", framework: 'playwright', score: 0, scoreReason: '' },
  ];
  const anc = (extra: Partial<AncestorInfo>): AncestorInfo => ({
    tag: 'div', id: '', testId: '', ariaLabel: '', role: '', texts: [], ...extra,
  });

  it('builds row + hasText scopes with a readable chain', () => {
    const out = gen.generate(el, base, [anc({ tag: 'tr', texts: ['Invoice 1042'] })]);
    expect(out).toHaveLength(1);
    expect(out[0].strategy).toBe('scoped');
    expect(out[0].value).toBe(
      "locator('tr').filter({ hasText: 'Invoice 1042' }).getByRole('button', { name: 'Delete' })",
    );
    expect(out[0].scope).toEqual({ css: 'tr', hasText: 'Invoice 1042', inner: base[0].value });
  });

  it('prefers stable ids/test ids and skips generated ids and generic divs', () => {
    const out = gen.generate(el, base, [
      anc({ id: 'mat-input-4', texts: ['x1'] }),
      anc({ testId: 'card-7', texts: ['y1'] }),
    ]);
    expect(out.map((o) => o.scope!.css)).toEqual(['[data-testid="card-7"]']);
  });

  it('returns nothing when there is no way to describe the target', () => {
    expect(gen.generate(el, [], [anc({ tag: 'tr', texts: ['a1'] })])).toEqual([]);
  });

  it('escapes quotes in scope text', () => {
    const out = gen.generate(el, base, [anc({ tag: 'li', texts: ["Bob's order"] })]);
    expect(out[0].value).toContain("hasText: 'Bob\\'s order'");
  });
});

describe('scoped locators on real pages', () => {
  let agent: LocatorAgent;
  beforeAll(() => { agent = new LocatorAgent(); });
  afterAll(async () => { await agent.shutdown(); });

  it('scopes repeated buttons in a table to their row', async () => {
    const html = `<html><body><table><tbody>
      <tr><td>Invoice 1001</td><td>$10</td><td><button>Delete</button></td></tr>
      <tr><td>Invoice 1002</td><td>$20</td><td><button>Delete</button></td></tr>
      <tr><td>Invoice 1003</td><td>$30</td><td><button>Delete</button></td></tr>
    </tbody></table></body></html>`;

    const result = await agent.analyze({ html });
    const deletes = result.elements.filter((e) => e.element.tag === 'button');
    expect(deletes).toHaveLength(3);

    const recommended = deletes.map((d) => d.recommended);
    for (const rec of recommended) {
      expect(rec.strategy).toBe('scoped');
      expect(rec.matchCount).toBe(1);
      expect(rec.resolvesToTarget).toBe(true);
      expect(rec.value).toMatch(/^locator\('tr'\)\.filter\(\{ hasText: 'Invoice 100\d' \}\)\.getByRole\('button'/);
    }
    // Each row is addressed by its own text
    expect(new Set(recommended.map((r) => r.value)).size).toBe(3);

    // Translated (WebdriverIO) locators inherit their source's validation, so an
    // ambiguous `$('aria/Delete')` can't be reported as unverified-but-best
    for (const d of deletes) {
      const wdio = d.locators.filter((l) => l.derivedFrom);
      expect(wdio.length).toBeGreaterThan(0);
      expect(wdio.every((l) => l.matchCount !== undefined)).toBe(true);
      expect(d.recommended.framework).not.toBe('webdriverio');
    }
  }, 60_000);

  it('uses a container test id when cards carry one', async () => {
    const html = `<html><body>
      <div data-testid="card-1"><h3>Alpha</h3><button>Buy</button></div>
      <div data-testid="card-2"><h3>Beta</h3><button>Buy</button></div>
    </body></html>`;

    const result = await agent.analyze({ html });
    const buys = result.elements.filter((e) => e.element.tag === 'button');
    expect(buys).toHaveLength(2);
    const cssScopes = buys.map((b) => b.recommended.scope?.css).sort();
    expect(cssScopes).toEqual(['[data-testid="card-1"]', '[data-testid="card-2"]']);
    for (const b of buys) expect(b.recommended.resolvesToTarget).toBe(true);
  }, 60_000);

  it('does not add scoped locators when the element is already uniquely identified', async () => {
    const html = `<html><body><button data-testid="only">Only</button></body></html>`;
    const result = await agent.analyze({ html });
    const btn = result.elements.find((e) => e.element.tag === 'button')!;
    expect(btn.locators.some((l) => l.strategy === 'scoped')).toBe(false);
  }, 60_000);

  it('scopes inside an iframe and keeps the frame path', async () => {
    const inner = `<ul>
      <li>Task one <button>Done</button></li>
      <li>Task two <button>Done</button></li>
    </ul>`;
    const html = `<html><body><iframe id="todo" srcdoc="${esc(inner)}"></iframe></body></html>`;

    const result = await agent.analyze({ html });
    const dones = result.elements.filter((e) => e.element.tag === 'button');
    expect(dones).toHaveLength(2);
    for (const d of dones) {
      expect(d.recommended.strategy).toBe('scoped');
      expect(d.recommended.framePath).toEqual(['iframe#todo']);
      expect(d.recommended.resolvesToTarget).toBe(true);
      expect(formatWithFrames(d.recommended)).toMatch(/^page\.frameLocator\("iframe#todo"\)\.locator\('li'\)/);
    }
  }, 60_000);
});
