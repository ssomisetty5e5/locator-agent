// ============================================================
// Locator classification (shared)
// Pure helpers used by every validator: decide how a generated
// locator can be queried, and copy results onto translated forms.
// No browser or Playwright dependency, so they also run in the
// browser extension.
// ============================================================

import { LocatorResult } from '../types';

export type QueryableKind = 'css' | 'xpath' | 'playwright' | 'playwright-locator' | 'js-chain';

/**
 * Parse a LocatorResult and return a queryable selector, or null
 * if it can't be validated programmatically.
 */
export function extractQueryableSelector(loc: LocatorResult): { type: QueryableKind; value: string } | null {
  // Scoped locator (ancestor + inner) — built from its structured form
  if (loc.scope) {
    return { type: 'playwright-locator', value: loc.value };
  }

  // Shadow-piercing CSS (>>> or >>) — must use Playwright locator API
  if (loc.strategy === 'shadowPiercingCss') {
    if (loc.framework === 'playwright' && loc.value.includes(' >> ')) {
      return { type: 'playwright-locator', value: loc.value };
    }
    // JavaScript querySelector chain — validate by executing it
    if (loc.framework === 'javascript' && loc.value.startsWith('document.querySelector')) {
      return { type: 'js-chain', value: loc.value };
    }
    // The CSS >>> version can't be validated via querySelectorAll; skip
    if (loc.value.includes('>>>')) {
      return null;
    }
  }

  // CSS framework → direct CSS selector
  if (loc.framework === 'css') {
    return { type: 'css', value: loc.value };
  }

  // XPath framework → direct XPath expression
  if (loc.framework === 'xpath') {
    return { type: 'xpath', value: loc.value };
  }

  // Playwright semantic API — getByRole(...), getByText(...), etc.
  if (loc.framework === 'playwright') {
    if (loc.value.startsWith('getBy')) {
      return { type: 'playwright', value: loc.value };
    }
    // Playwright CSS selectors (e.g. `#myId`)  — try as plain CSS
    return { type: 'css', value: loc.value };
  }

  // Selenium By.ID — just a raw id string, can be queried as CSS
  if (loc.framework === 'selenium' && loc.strategy === 'id') {
    // Escape the ID for CSS (simple escaping for common chars)
    const escaped = loc.value.replace(/([^\w-])/g, '\\$1');
    return { type: 'css', value: `#${escaped}` };
  }

  // WebdriverIO — unwrap `$('...')` / `$("...")` and classify the inner
  // selector. Skip forms that have no direct DOM-query equivalent:
  // "aria/Name" (accessible-name lookup), "=Text"/"*=Text" (text match),
  // and " >>> " deep-selector chains (shadow piercing).
  if (loc.framework === 'webdriverio') {
    const wdioMatch = loc.value.match(/^\$\((['"])(.*)\1\)$/);
    if (!wdioMatch) return null;
    const inner = wdioMatch[2];
    if (inner.startsWith('aria/') || inner.startsWith('=') || inner.startsWith('*=')) {
      return null;
    }
    if (inner.includes(' >>> ')) {
      return null;
    }
    if (inner.startsWith('/') || inner.startsWith('(')) {
      return { type: 'xpath', value: inner };
    }
    return { type: 'css', value: inner };
  }

  return null;
}

/**
 * Translated locators (e.g. WebdriverIO `$('aria/Save')`) that couldn't be
 * run directly inherit the result of the locator they were derived from,
 * so an unverified translation can't outrank a source known to be ambiguous.
 * Call after every directly-queryable locator has been validated.
 */
export function propagateDerived(locators: LocatorResult[]): void {
  const byKey = new Map<string, LocatorResult>();
  for (const l of locators) byKey.set(`${l.strategy}::${l.framework}::${l.value}`, l);
  for (const l of locators) {
    if (!l.derivedFrom || l.matchCount !== undefined) continue;
    const src = byKey.get(l.derivedFrom);
    if (!src || src.matchCount === undefined) continue;
    l.matchCount = src.matchCount;
    l.isUnique = src.isUnique;
    if (src.resolvesToTarget !== undefined) l.resolvesToTarget = src.resolvesToTarget;
  }
}
