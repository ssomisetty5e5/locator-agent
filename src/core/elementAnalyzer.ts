// ============================================================
// Element Analyzer
// Turns one discovered element into a validated, ranked analysis.
// Shared by the Playwright-based agent and the browser extension;
// the only thing that differs is how locators are validated and how
// ancestors are inspected, which the caller supplies as a driver.
// ============================================================

import { AncestorInfo, DiscoveredElement, ElementAnalysis, LocatorResult } from '../types';
import { LocatorGenerator } from '../generator';
import { LocatorRanker } from '../ranker';
import { ScopedLocatorGenerator } from '../generator/scopedLocatorGenerator';
import { playwrightMatch } from '../validator/classify';

/** Keep at most this many validated scoped locators per element */
const MAX_SCOPED_RESULTS = 3;

/** How locators are checked against a live page, and how its ancestors are described. */
export interface ElementDriver {
  /** Fill `matchCount` / `isUnique` / `resolvesToTarget` on each locator (mutates in place). */
  validate(locators: LocatorResult[], nodeIndex?: number): Promise<void>;
  /** Describe the element's ancestors, nearest first. May throw if the page can't be inspected. */
  probeAncestors(nodeIndex: number): Promise<AncestorInfo[]>;
}

export class ElementAnalyzer {
  constructor(
    private generator = new LocatorGenerator(),
    private ranker = new LocatorRanker(),
    private scopedGenerator = new ScopedLocatorGenerator(),
  ) {}

  async analyze(el: DiscoveredElement, driver: ElementDriver): Promise<ElementAnalysis> {
    const rawLocators = this.generator.generate(el);

    // Elements inside iframes are validated within their own frame
    if (el.framePath) {
      for (const loc of rawLocators) loc.framePath = el.framePath;
    }

    // Validate uniqueness against the live page
    await driver.validate(rawLocators, el.nodeIndex);

    // Rank (scores now include uniqueness bonuses/penalties)
    let ranked = this.ranker.rank(rawLocators, el);

    // Second pass: if nothing found the element uniquely on its own,
    // try locators scoped to a distinguishing ancestor (row, card, list item…)
    if (this.needsScope(ranked) && el.nodeIndex !== undefined) {
      const scoped = await this.buildScopedLocators(driver, el, rawLocators);
      if (scoped.length > 0) {
        rawLocators.push(...scoped);
        ranked = this.ranker.rank(rawLocators, el);
      }
    }

    const recommended = ranked.length > 0
      ? this.ranker.getBest(ranked)
      : {
          strategy: 'css' as const,
          value: el.tag,
          framework: 'css' as const,
          score: 0,
          scoreReason: 'No locators could be generated',
        };

    return { element: el, locators: ranked, recommended };
  }

  /**
   * True when no Playwright locator (getBy*, CSS, XPath) finds the element both
   * uniquely and without relying on its position (nth-of-type / nth-child / [n]
   * indexes), which break as soon as rows or items are added, removed or reordered.
   * A unique JavaScript or Selenium locator doesn't count: scoped locators exist
   * to give Playwright users something unique to write.
   */
  private needsScope(ranked: LocatorResult[]): boolean {
    return !ranked.some((l) => {
      if (l.framework !== 'playwright' && l.framework !== 'css' && l.framework !== 'xpath') return false;
      const m = playwrightMatch(l);
      return m.count === 1 && m.hitsTarget !== false && !/nth-(of-type|child)|\[\d+\]/.test(l.value);
    });
  }

  /**
   * Generate and validate ancestor-scoped locators for an element; only
   * candidates that match exactly one element, the target, are kept.
   */
  private async buildScopedLocators(
    driver: ElementDriver,
    el: DiscoveredElement,
    baseLocators: LocatorResult[],
  ): Promise<LocatorResult[]> {
    let ancestors: AncestorInfo[] = [];
    try {
      ancestors = await driver.probeAncestors(el.nodeIndex!);
    } catch {
      return [];
    }

    const candidates = this.scopedGenerator.generate(el, baseLocators, ancestors);
    if (candidates.length === 0) return [];

    await driver.validate(candidates, el.nodeIndex);
    return candidates
      .filter((c) => c.matchCount === 1 && c.resolvesToTarget === true)
      .slice(0, MAX_SCOPED_RESULTS);
  }
}
