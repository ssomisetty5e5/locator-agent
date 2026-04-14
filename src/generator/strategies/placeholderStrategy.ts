// ============================================================
// Placeholder Locator Strategy
// Generates locators based on placeholder attribute.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';

export class PlaceholderStrategy implements ILocatorStrategy {
  name: LocatorStrategy = 'placeholder';

  generate(element: DiscoveredElement): LocatorResult[] {
    const results: LocatorResult[] = [];
    const placeholder = element.attributes['placeholder'];

    if (!placeholder) return results;

    // Playwright getByPlaceholder
    results.push({
      strategy: 'placeholder',
      value: `getByPlaceholder('${this.escapeQuotes(placeholder)}')`,
      framework: 'playwright',
      score: 0,
      scoreReason: '',
    });

    // CSS
    results.push({
      strategy: 'placeholder',
      value: `${element.tag}[placeholder="${placeholder}"]`,
      framework: 'css',
      score: 0,
      scoreReason: '',
    });

    return results;
  }

  private escapeQuotes(s: string): string {
    return s.replace(/'/g, "\\'");
  }
}
