// ============================================================
// Aria Label Locator Strategy
// Generates locators based on aria-label, aria-labelledby.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';

export class AriaLabelStrategy implements ILocatorStrategy {
  name: LocatorStrategy = 'ariaLabel';

  generate(element: DiscoveredElement): LocatorResult[] {
    const results: LocatorResult[] = [];

    const ariaLabel = element.attributes['aria-label'];
    if (ariaLabel) {
      // Playwright
      results.push({
        strategy: 'ariaLabel',
        value: `getByLabel('${this.escapeQuotes(ariaLabel)}')`,
        framework: 'playwright',
        score: 0,
        scoreReason: '',
      });

      // CSS
      results.push({
        strategy: 'ariaLabel',
        value: `[aria-label="${ariaLabel}"]`,
        framework: 'css',
        score: 0,
        scoreReason: '',
      });

      // Selenium
      results.push({
        strategy: 'ariaLabel',
        value: `[aria-label="${ariaLabel}"]`,
        framework: 'selenium',
        score: 0,
        scoreReason: '',
      });
    }

    return results;
  }

  private escapeQuotes(s: string): string {
    return s.replace(/'/g, "\\'");
  }
}
