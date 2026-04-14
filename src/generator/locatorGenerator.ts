// ============================================================
// Locator Generator
// Orchestrates all locator strategies to produce locators
// for a given DiscoveredElement.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy } from '../types';
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

export class LocatorGenerator {
  private strategies: ILocatorStrategy[];

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
  }

  /**
   * Generate all possible locators for a single element.
   */
  generate(element: DiscoveredElement): LocatorResult[] {
    const allLocators: LocatorResult[] = [];

    for (const strategy of this.strategies) {
      try {
        const locators = strategy.generate(element);
        allLocators.push(...locators);
      } catch (err) {
        // Skip failing strategy, don't crash
        console.warn(`Strategy ${strategy.name} failed for element ${element.uid}:`, err);
      }
    }

    // Deduplicate by value
    const seen = new Set<string>();
    return allLocators.filter((loc) => {
      const key = `${loc.strategy}::${loc.framework}::${loc.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
