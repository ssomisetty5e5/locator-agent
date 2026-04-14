// ============================================================
// Locator Validator
// Validates generated locators against the live page to check
// uniqueness — how many elements each locator actually matches.
// ============================================================

import { Page } from 'playwright';
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
    page: Page,
    locators: LocatorResult[],
    timeout = 500,
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
            const results = [];

            // CSS
            for (const sel of cssSels) {
              try {
                const matches = document.querySelectorAll(sel);
                results.push(matches.length);
              } catch(e) {
                results.push(-1);
              }
            }

            // XPath
            for (const expr of xpathExprs) {
              try {
                const xr = document.evaluate(
                  expr, document, null,
                  XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
                );
                results.push(xr.snapshotLength);
              } catch(e) {
                results.push(-1);
              }
            }

            return results;
          })()`
        ) as number[];

        // Map results back
        let ri = 0;
        for (const cs of cssSelectors) {
          const count = counts[ri++];
          if (count >= 0) {
            locators[cs.index].matchCount = count;
            locators[cs.index].isUnique = count === 1;
          }
        }
        for (const xs of xpathSelectors) {
          const count = counts[ri++];
          if (count >= 0) {
            locators[xs.index].matchCount = count;
            locators[xs.index].isUnique = count === 1;
          }
        }
      } catch {
        // Evaluation failed — leave matchCount undefined
      }
    }

    // ── Playwright semantic locators (getByRole, getByText, etc.) ─
    // Use Playwright's own locator().count() API — must be done one
    // at a time, but these are fast since they don't hit the network.
    for (const pw of playwrightLocators) {
      try {
        const count = await this.countPlaywrightLocator(page, pw.locator, timeout);
        if (count >= 0) {
          locators[pw.index].matchCount = count;
          locators[pw.index].isUnique = count === 1;
        }
      } catch {
        // Skip
      }
    }
  }

  /**
   * Parse a LocatorResult and return a queryable selector, or null
   * if it can't be validated programmatically.
   */
  private extractQueryableSelector(
    loc: LocatorResult,
  ): { type: 'css' | 'xpath' | 'playwright' | 'playwright-locator' | 'js-chain'; value: string } | null {
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

    return null;
  }

  /**
   * Count matches for a Playwright semantic locator (getByRole, getByText, etc.)
   * by invoking the actual Playwright locator API.
   */
  private async countPlaywrightLocator(
    page: Page,
    loc: LocatorResult,
    _timeout: number,
  ): Promise<number> {
    const val = loc.value;

    // Parse getByRole('button', { name: 'Submit' })
    const roleMatch = val.match(/^getByRole\('([^']+)'(?:\s*,\s*\{\s*name:\s*'([^']*)'\s*\})?\)$/);
    if (roleMatch) {
      const role = roleMatch[1];
      const name = roleMatch[2];
      const locator = name
        ? page.getByRole(role as any, { name })
        : page.getByRole(role as any);
      return await locator.count();
    }

    // Parse getByText('...')
    const textMatch = val.match(/^getByText\('([^']*)'\)$/);
    if (textMatch) {
      return await page.getByText(textMatch[1]).count();
    }

    // Parse getByLabel('...')
    const labelMatch = val.match(/^getByLabel\('([^']*)'\)$/);
    if (labelMatch) {
      return await page.getByLabel(labelMatch[1]).count();
    }

    // Parse getByPlaceholder('...')
    const phMatch = val.match(/^getByPlaceholder\('([^']*)'\)$/);
    if (phMatch) {
      return await page.getByPlaceholder(phMatch[1]).count();
    }

    // Parse getByTestId('...')
    const tidMatch = val.match(/^getByTestId\('([^']*)'\)$/);
    if (tidMatch) {
      return await page.getByTestId(tidMatch[1]).count();
    }

    // Shadow-piercing selector (Playwright >> combinator)
    if (loc.strategy === 'shadowPiercingCss' && loc.framework === 'playwright' && val.includes(' >> ')) {
      return await page.locator(val).count();
    }

    // JavaScript querySelector chain — execute it directly in the page
    if (loc.strategy === 'shadowPiercingCss' && loc.framework === 'javascript' && val.startsWith('document.querySelector')) {
      const result = await page.evaluate(`(() => {
        try {
          const el = ${val};
          return el ? 1 : 0;
        } catch(e) { return 0; }
      })()`);
      return result as number;
    }

    // Generic Playwright CSS selector (no getBy prefix)
    if (loc.framework === 'playwright' && !val.startsWith('getBy')) {
      return await page.locator(val).count();
    }

    return -1; // Could not parse
  }
}
