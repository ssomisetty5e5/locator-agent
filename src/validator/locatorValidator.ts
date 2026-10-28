// ============================================================
// Locator Validator
// Validates generated locators against the live page to check
// uniqueness — how many elements each locator actually matches.
// ============================================================

import { Page, Frame, Locator } from 'playwright';

/** Anything that can resolve locators: the main page or one of its iframes. */
type QueryContext = Page | Frame;

/** A context, or a Locator narrowed to an ancestor (scoped locators). */
type LocatorRoot = QueryContext | Locator;
import { LocatorResult } from '../types';

/**
 * Given a list of locators that were generated for an element, run each
 * one against the live Playwright page and record how many elements it
 * matches.  Locators that match exactly 1 element are marked `isUnique`.
 *
 * Only CSS-like and XPath selectors are validated directly.
 * Playwright semantic API calls (getByRole, getByText, etc.) are
 * validated through the Playwright locator API.
 */
export class LocatorValidator {

  /**
   * Validate all locators in the array, mutating each with
   * `matchCount` and `isUnique`.
   *
   * @param page      Live Playwright page to query against
   * @param locators  Locator results to validate (mutated in-place)
   * @param timeout   Max ms to spend per locator (default 500)
   */
  async validate(
    page: QueryContext,
    locators: LocatorResult[],
    timeout = 500,
    targetIndex?: number,
  ): Promise<void> {
    // Build one big evaluate call for all CSS/XPath selectors at once
    // to minimize round-trips.
    const cssSelectors: { index: number; selector: string }[] = [];
    const xpathSelectors: { index: number; expr: string }[] = [];
    const playwrightLocators: { index: number; locator: LocatorResult }[] = [];

    for (let i = 0; i < locators.length; i++) {
      const loc = locators[i];
      const parsed = this.extractQueryableSelector(loc);
      if (!parsed) {
        // Can't validate this one (e.g. CSS >>> notation) — skip
        continue;
      }
      if (parsed.type === 'css') {
        cssSelectors.push({ index: i, selector: parsed.value });
      } else if (parsed.type === 'xpath') {
        xpathSelectors.push({ index: i, expr: parsed.value });
      } else if (parsed.type === 'playwright' || parsed.type === 'playwright-locator') {
        playwrightLocators.push({ index: i, locator: loc });
      } else if (parsed.type === 'js-chain') {
        // JS chains validated in their own batch below
        playwrightLocators.push({ index: i, locator: loc });
      }
    }

    // ── Batch: CSS + XPath in one page.evaluate ──────────────
    if (cssSelectors.length > 0 || xpathSelectors.length > 0) {
      try {
        const counts = await page.evaluate(
          `(() => {
            const cssSels = ${JSON.stringify(cssSelectors.map(s => s.selector))};
            const xpathExprs = ${JSON.stringify(xpathSelectors.map(s => s.expr))};
            const targetIdx = ${targetIndex ?? -1};
            const target = targetIdx >= 0 && window.__laNodes ? window.__laNodes[targetIdx] : null;
            const results = [];

            // CSS
            for (const sel of cssSels) {
              try {
                const matches = document.querySelectorAll(sel);
                results.push([matches.length, target ? Array.prototype.includes.call(matches, target) : null]);
              } catch(e) {
                results.push([-1, null]);
              }
            }

            // XPath
            for (const expr of xpathExprs) {
              try {
                const xr = document.evaluate(
                  expr, document, null,
                  XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
                );
                let hit = null;
                if (target) {
                  hit = false;
                  for (let i = 0; i < xr.snapshotLength; i++) {
                    if (xr.snapshotItem(i) === target) { hit = true; break; }
                  }
                }
                results.push([xr.snapshotLength, hit]);
              } catch(e) {
                results.push([-1, null]);
              }
            }

            return results;
          })()`
        ) as [number, boolean | null][];

        // Map results back
        let ri = 0;
        for (const cs of cssSelectors) {
          const [count, hit] = counts[ri++];
          if (count >= 0) {
            locators[cs.index].matchCount = count;
            locators[cs.index].isUnique = count === 1;
            if (hit !== null) locators[cs.index].resolvesToTarget = hit;
          }
        }
        for (const xs of xpathSelectors) {
          const [count, hit] = counts[ri++];
          if (count >= 0) {
            locators[xs.index].matchCount = count;
            locators[xs.index].isUnique = count === 1;
            if (hit !== null) locators[xs.index].resolvesToTarget = hit;
          }
        }
      } catch {
        // Evaluation failed — leave matchCount undefined
      }
    }

    // Translated locators (e.g. WebdriverIO `$('aria/Save')`) that couldn't be
    // run directly inherit the result of the locator they were derived from,
    // so an unverified translation can't outrank a source known to be ambiguous.
    // Done after the Playwright pass below.
    const propagateDerived = () => {
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
    };

    // ── Playwright semantic locators (getByRole, getByText, etc.) ─
    // Use Playwright's own locator().count() API — must be done one
    // at a time, but these are fast since they don't hit the network.
    for (const pw of playwrightLocators) {
      try {
        const { count, hit } = await this.countPlaywrightLocator(page, pw.locator, timeout, targetIndex);
        if (count >= 0) {
          locators[pw.index].matchCount = count;
          locators[pw.index].isUnique = count === 1;
          if (hit !== null) locators[pw.index].resolvesToTarget = hit;
        }
      } catch {
        // Skip
      }
    }

    propagateDerived();
  }

  /**
   * Parse a LocatorResult and return a queryable selector, or null
   * if it can't be validated programmatically.
   */
  private extractQueryableSelector(
    loc: LocatorResult,
  ): { type: 'css' | 'xpath' | 'playwright' | 'playwright-locator' | 'js-chain'; value: string } | null {
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
   * Count matches for a Playwright semantic locator (getByRole, getByText, etc.)
   * by invoking the actual Playwright locator API.
   */
  private async countPlaywrightLocator(
    page: QueryContext,
    loc: LocatorResult,
    _timeout: number,
    targetIndex?: number,
  ): Promise<{ count: number; hit: boolean | null }> {
    const val = loc.value;

    // JavaScript querySelector chain — execute it directly in the page
    if (loc.strategy === 'shadowPiercingCss' && loc.framework === 'javascript' && val.startsWith('document.querySelector')) {
      const result = (await page.evaluate(`(() => {
        try {
          const el = ${val};
          const idx = ${targetIndex ?? -1};
          const target = idx >= 0 && window.__laNodes ? window.__laNodes[idx] : null;
          return [el ? 1 : 0, target ? el === target : null];
        } catch(e) { return [0, null]; }
      })()`)) as [number, boolean | null];
      return { count: result[0], hit: result[1] };
    }

    const locator = this.buildPlaywrightLocator(page, loc);
    if (!locator) return { count: -1, hit: null };

    const count = await locator.count();
    let hit: boolean | null = null;
    if (targetIndex !== undefined) {
      hit = count > 0
        ? await locator.evaluateAll(
            (els: any[], idx: number) => {
              const target = (globalThis as any).__laNodes?.[idx];
              return !!target && els.includes(target);
            },
            targetIndex,
          )
        : false;
    }
    return { count, hit };
  }

  /**
   * Turn a generated Playwright-style locator string into a real Playwright
   * Locator, or null if the string isn't one we understand.
   */
  private buildPlaywrightLocator(page: LocatorRoot, loc: LocatorResult): Locator | null {
    // Scoped: narrow to the ancestor first, then resolve the inner expression inside it
    if (loc.scope) {
      let scoped = (page as QueryContext).locator(loc.scope.css);
      if (loc.scope.hasText) scoped = scoped.filter({ hasText: loc.scope.hasText });
      return this.buildPlaywrightLocator(scoped, {
        ...loc,
        scope: undefined,
        strategy: 'css',
        framework: 'playwright',
        value: loc.scope.inner,
      });
    }

    const val = loc.value;

    // locator('css') — plain selector written with the same quoting the scoped generator uses
    const cssMatch = val.match(/^locator\('((?:\\.|[^'\\])*)'\)$/);
    if (cssMatch) return page.locator(cssMatch[1].replace(/\\(.)/g, '$1'));

    // getByRole('button', { name: 'Submit' })
    const roleMatch = val.match(/^getByRole\('([^']+)'(?:\s*,\s*\{\s*name:\s*'([^']*)'\s*\})?\)$/);
    if (roleMatch) {
      const role = roleMatch[1];
      const name = roleMatch[2];
      return name ? page.getByRole(role as any, { name }) : page.getByRole(role as any);
    }

    const textMatch = val.match(/^getByText\('([^']*)'\)$/);
    if (textMatch) return page.getByText(textMatch[1]);

    const labelMatch = val.match(/^getByLabel\('([^']*)'\)$/);
    if (labelMatch) return page.getByLabel(labelMatch[1]);

    const phMatch = val.match(/^getByPlaceholder\('([^']*)'\)$/);
    if (phMatch) return page.getByPlaceholder(phMatch[1]);

    const tidMatch = val.match(/^getByTestId\('([^']*)'\)$/);
    if (tidMatch) return page.getByTestId(tidMatch[1]);

    // Shadow-piercing selector (Playwright >> combinator)
    if (loc.strategy === 'shadowPiercingCss' && loc.framework === 'playwright' && val.includes(' >> ')) {
      return page.locator(val);
    }

    // Generic Playwright CSS selector (no getBy prefix)
    if (loc.framework === 'playwright' && !val.startsWith('getBy')) {
      return page.locator(val);
    }

    return null;
  }
}
