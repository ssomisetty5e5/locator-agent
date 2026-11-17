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
import { extractQueryableSelector, propagateDerived } from './classify';

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
    // `pierce` marks Playwright CSS, whose own count already searches open shadow roots
    const cssSelectors: { index: number; selector: string; pierce: boolean }[] = [];
    const xpathSelectors: { index: number; expr: string }[] = [];
    const playwrightLocators: { index: number; locator: LocatorResult }[] = [];

    for (let i = 0; i < locators.length; i++) {
      const loc = locators[i];
      const parsed = extractQueryableSelector(loc);
      if (!parsed) {
        // Can't validate this one (e.g. CSS >>> notation) — skip
        continue;
      }
      if (parsed.type === 'css' || parsed.type === 'css-deep') {
        cssSelectors.push({ index: i, selector: parsed.value, pierce: parsed.type === 'css-deep' });
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
            const cssPierce = ${JSON.stringify(cssSelectors.map(s => s.pierce))};
            const xpathExprs = ${JSON.stringify(xpathSelectors.map(s => s.expr))};
            const targetIdx = ${targetIndex ?? -1};
            const target = targetIdx >= 0 && window.__laNodes ? window.__laNodes[targetIdx] : null;
            const results = [];

            // Open shadow roots reachable from the document (what Playwright's CSS engine also searches)
            let shadowRoots = null;
            const getShadowRoots = () => {
              if (shadowRoots) return shadowRoots;
              shadowRoots = [];
              const visit = (root) => {
                for (const el of root.querySelectorAll('*')) {
                  if (el.shadowRoot) { shadowRoots.push(el.shadowRoot); visit(el.shadowRoot); }
                }
              };
              visit(document);
              return shadowRoots;
            };
            const queryDeep = (sel) => {
              const out = new Set(document.querySelectorAll(sel));
              for (const root of getShadowRoots()) root.querySelectorAll(sel).forEach((e) => out.add(e));
              return out;
            };

            // CSS: [count, hitsTarget, deepCount, deepHitsTarget]
            for (let i = 0; i < cssSels.length; i++) {
              const sel = cssSels[i];
              try {
                const matches = cssPierce[i] ? null : document.querySelectorAll(sel);
                const deep = queryDeep(sel);
                const hasTarget = target ? deep.has(target) : null;
                results.push(matches
                  ? [matches.length, target ? Array.prototype.includes.call(matches, target) : null, deep.size, hasTarget]
                  : [deep.size, hasTarget, deep.size, hasTarget]);
              } catch(e) {
                results.push([-1, null, -1, null]);
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
        ) as [number, boolean | null, number?, (boolean | null)?][];

        // Map results back
        let ri = 0;
        for (const cs of cssSelectors) {
          const [count, hit, deepCount, deepHit] = counts[ri++];
          if (count >= 0) {
            locators[cs.index].matchCount = count;
            locators[cs.index].isUnique = count === 1;
            if (hit !== null) locators[cs.index].resolvesToTarget = hit;
            if (deepCount !== undefined && deepCount >= 0) {
              locators[cs.index].deepMatchCount = deepCount;
              if (deepHit !== null && deepHit !== undefined) locators[cs.index].deepResolvesToTarget = deepHit;
            }
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

    // Translated locators that couldn't be run directly inherit their source's result
    propagateDerived(locators);
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
