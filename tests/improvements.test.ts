// ============================================================
// Tests: suggestions for weak locators (what to ask developers to add)
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  developerNote, developerReport, suggestImprovements, suggestedTestId, WEAK_SCORE,
} from '../src/suggest/improvements';
import { DiscoveredElement, ElementAnalysis, LocatorResult, PageAnalysis } from '../src/types';

const el = (over: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  uid: 'u', tag: 'button', text: '', attributes: {}, shadowDepth: 0, shadowHostChain: [], shadowHost: null,
  ariaRole: null, cssPathSegments: [], isInteractive: true, boundingBox: null, htmlSnippet: '', childCount: 0,
  ...over,
} as DiscoveredElement);

const loc = (over: Partial<LocatorResult> = {}): LocatorResult => ({
  strategy: 'shadowPiercingCss', framework: 'playwright', value: 'a >> b >> c', score: 40, scoreReason: 'long chain',
  matchCount: 1, isUnique: true, resolvesToTarget: true,
  ...over,
});

const analysis = (element: DiscoveredElement, recommended: LocatorResult, locators: LocatorResult[] = [recommended]): ElementAnalysis =>
  ({ element, recommended, locators });

const page = (elements: ElementAnalysis[]): PageAnalysis => ({
  source: 'https://app.example.com/home', timestamp: '2026-11-19T10:00:00.000Z', pageTitle: 'Home',
  totalDomElements: 100, interactiveElementsFound: elements.length, shadowRootsPierced: 0, elements,
} as PageAnalysis);

describe('suggestImprovements', () => {
  it('says nothing about a locator that is already strong and unique', () => {
    const strong = analysis(el({ text: 'Save' }), loc({ score: 95, strategy: 'testId' }));
    expect(suggestImprovements(strong)).toBeNull();
    expect(developerNote(strong)).toBe('');
  });

  it('treats a not-unique locator as weak even when its score is high', () => {
    const ambiguous = analysis(el({ text: 'Save' }), loc({ score: 90, matchCount: 3, isUnique: false }));
    expect(suggestImprovements(ambiguous)?.problem).toContain('matches 3 elements');
  });

  it('asks for a test id named after the element and gives the ideal locator', () => {
    const s = suggestImprovements(analysis(el({ text: 'Save changes' }), loc({ score: 43 })))!;
    expect(s.score).toBe(43);
    expect(s.improvements[0]).toMatchObject({
      kind: 'testId',
      snippet: 'data-testid="save-changes-button"',
      idealLocator: "page.getByTestId('save-changes-button')",
    });
  });

  it('names an unlabeled control after the component that holds it, and asks for an accessible name', () => {
    const icon = el({ tag: 'button', shadowDepth: 2, shadowHost: 'acme-toolbar', shadowHostChain: ['acme-app', 'acme-toolbar'] });
    expect(suggestedTestId(icon)).toBe('acme-toolbar-button');
    const kinds = suggestImprovements(analysis(icon, loc()))!.improvements.map((i) => i.kind);
    expect(kinds).toEqual(['testId', 'accessibleName']);
  });

  it('does not ask for an accessible name when the control already has one', () => {
    const kinds = suggestImprovements(analysis(el({ attributes: { 'aria-label': 'Close' } }), loc()))!.improvements.map((i) => i.kind);
    expect(kinds).not.toContain('accessibleName');
  });

  it('does not ask for a test id the element already has, but flags one shared by several elements', () => {
    const has = el({ text: 'Go', attributes: { 'data-testid': 'go' } });
    expect(suggestImprovements(analysis(has, loc({ score: 30 })))!.improvements.map((i) => i.kind)).not.toContain('testId');

    const shared = suggestImprovements(
      analysis(has, loc({ score: 30 }), [loc({ score: 30 }), loc({ strategy: 'testId', value: "getByTestId('go')", score: 95, matchCount: 4, isUnique: false })]),
    )!;
    expect(shared.improvements.map((i) => i.kind)).toContain('uniqueTestId');
  });

  it('asks to replace a generated id', () => {
    const generated = el({ text: 'Next', attributes: { id: 'mat-input-4' } });
    const imp = suggestImprovements(analysis(generated, loc()))!.improvements.find((i) => i.kind === 'stableId')!;
    expect(imp.snippet).toContain('mat-input-4');
    expect(imp.idealLocator).toBe("page.locator('#next-button')");
  });

  it('asks for a stable key on the row when a repeated element is found only by its text', () => {
    const scoped = loc({
      strategy: 'scoped', score: 60, value: "locator('tr').filter({ hasText: 'INV-1' }).getByRole('button', { name: 'Delete' })",
      scope: { css: 'tr', hasText: 'INV-1', inner: "getByRole('button', { name: 'Delete' })" },
    });
    const row = suggestImprovements(analysis(el({ text: 'Delete' }), scoped))!.improvements.find((i) => i.kind === 'rowKey')!;
    expect(row.snippet).toBe('data-testid="row-<record id>" on the repeated <tr>');
    expect(row.idealLocator).toBe("page.getByTestId('row-<record id>').getByRole('button', { name: 'Delete' })");
  });

  it('uses 70 as the default weak score', () => {
    expect(WEAK_SCORE).toBe(70);
    expect(suggestImprovements(analysis(el({ text: 'A' }), loc({ score: 69 })))).not.toBeNull();
    expect(suggestImprovements(analysis(el({ text: 'A' }), loc({ score: 70 })))).toBeNull();
  });
});

describe('developerNote', () => {
  it('describes the page, element, current locator, problem and fix', () => {
    const a = analysis(
      el({ text: 'Save', shadowDepth: 7, shadowHostChain: ['nuxeo-app', 'nuxeo-x', 'paper-button'] }),
      loc({ score: 43, value: "document.querySelector('nuxeo-app').shadowRoot.querySelector('slot')" }),
    );
    const note = developerNote(a, { pageUrl: 'https://app.example.com/home', pageTitle: 'Home' });
    expect(note).toContain('**Locator improvement request**');
    expect(note).toContain('Page: Home — https://app.example.com/home');
    expect(note).toContain('`<button>` "Save", inside Shadow DOM, depth 7 (…<nuxeo-app> › <nuxeo-x> › <paper-button>)');
    expect(note).toContain('(score 43, 1 match)');
    expect(note).toContain('`data-testid="save-button"`');
    expect(note).toContain("Tests could then use: `page.getByTestId('save-button')`");
  });
});

describe('developerReport', () => {
  const weak = (text: string, score: number, over: Partial<DiscoveredElement> = {}) =>
    analysis(el({ text, ...over }), loc({ score }));

  it('lists weak elements worst first and skips the strong ones', () => {
    const report = developerReport(page([
      weak('Fine', 95),
      weak('Meh', 60),
      weak('Bad', 20),
    ]));
    expect(report.total).toBe(3);
    expect(report.weak).toBe(2);
    expect(report.markdown).toContain('**2 of 3**');
    expect(report.markdown.indexOf('"Bad"')).toBeLessThan(report.markdown.indexOf('"Meh"'));
    expect(report.markdown).not.toContain('"Fine"');
  });

  it('makes the suggested test ids unique across the page, and avoids ones already in use', () => {
    const report = developerReport(page([
      weak('Save', 30),
      weak('Save', 31),
      weak('Save', 32),
      analysis(el({ text: 'Other', attributes: { 'data-testid': 'cancel-button' } }), loc({ score: 95, strategy: 'testId' })),
      weak('Cancel', 33),
    ]));
    for (const id of ['save-button', 'save-button-2', 'save-button-3', 'cancel-button-2']) {
      expect(report.markdown).toContain(`data-testid="${id}"`);
    }
    // each suggested id appears exactly once
    expect(report.markdown.match(/data-testid="save-button"/g)).toHaveLength(1);
  });

  it('summarises what is needed and caps the list', () => {
    const many = Array.from({ length: 5 }, (_, i) => weak(`Item ${i}`, 10 + i));
    const report = developerReport(page(many), { max: 3 });
    expect(report.markdown).toContain('- 5 elements need a `data-testid`');
    expect(report.markdown).toContain('…and 2 more');
    expect(report.markdown).toContain('### 3.');
    expect(report.markdown).not.toContain('### 4.');
  });

  it('reports nothing to do for a page of strong locators', () => {
    const report = developerReport(page([weak('Fine', 95)]));
    expect(report.weak).toBe(0);
  });
});
