// ============================================================
// Locator Generator
// Orchestrates all locator strategies to produce locators
// for a given DiscoveredElement.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, IFrameworkAdapter } from '../types';
import {
  TestIdStrategy,
  AriaRoleStrategy,
  AriaLabelStrategy,
  TextStrategy,
  IdStrategy,
  CssStrategy,
  ShadowPiercingCssStrategy,
  XPathStrategy,
  NameStrategy,
  PlaceholderStrategy,
} from './strategies';
import { WebdriverIOAdapter } from './adapters';

export class LocatorGenerator {
  private strategies: ILocatorStrategy[];
  private adapters: IFrameworkAdapter[];

  constructor() {
    this.strategies = [
      new TestIdStrategy(),
      new AriaRoleStrategy(),
      new AriaLabelStrategy(),
      new TextStrategy(),
      new IdStrategy(),
      new CssStrategy(),
      new ShadowPiercingCssStrategy(),
      new XPathStrategy(),
      new NameStrategy(),
      new PlaceholderStrategy(),
    ];

    // Framework adapters translate the base locators above into other
    // frameworks' syntax. Add a new framework by writing one adapter and
    // registering it here — no strategy files need to change.
    this.adapters = [new WebdriverIOAdapter()];
  }

  /**
   * Generate all possible locators for a single element.
   */
  generate(element: DiscoveredElement): LocatorResult[] {
    const baseLocators: LocatorResult[] = [];

    for (const strategy of this.strategies) {
      try {
        const locators = strategy.generate(element);
        baseLocators.push(...locators);
      } catch (err) {
        // Skip failing strategy, don't crash
        console.warn(`Strategy ${strategy.name} failed for element ${element.uid}:`, err);
      }
    }

    // Run every base locator through each registered framework adapter to
    // produce additional framework-specific variants.
    const adaptedLocators: LocatorResult[] = [];
    for (const adapter of this.adapters) {
      for (const loc of baseLocators) {
        try {
          const result = adapter.adapt(loc, element);
          if (!result) continue;
          adaptedLocators.push(...(Array.isArray(result) ? result : [result]));
        } catch (err) {
          console.warn(`Adapter ${adapter.framework} failed for element ${element.uid}:`, err);
        }
      }
    }

    // Deduplicate by strategy + framework + value
    const seen = new Set<string>();
    return [...baseLocators, ...adaptedLocators].filter((loc) => {
      const key = `${loc.strategy}::${loc.framework}::${loc.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
