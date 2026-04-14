// ============================================================
// Text Locator Strategy
// Generates locators based on visible text content.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';

export class TextStrategy implements ILocatorStrategy {
  name: LocatorStrategy = 'text';

  generate(element: DiscoveredElement): LocatorResult[] {
    const results: LocatorResult[] = [];
    const text = element.text?.trim();

    if (!text || text.length === 0 || text.length > 80) return results;

    // Playwright getByText
    results.push({
      strategy: 'text',
      value: `getByText('${this.escapeQuotes(text)}')`,
      framework: 'playwright',
      score: 0,
      scoreReason: '',
    });

    // XPath text-based
    results.push({
      strategy: 'text',
      value: `//${element.tag}[normalize-space(text())='${this.escapeXPath(text)}']`,
      framework: 'xpath',
      score: 0,
      scoreReason: '',
    });

    // If it's a link, provide link text
    if (element.tag === 'a') {
      results.push({
        strategy: 'text',
        value: text,
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

  private escapeXPath(s: string): string {
    return s.replace(/'/g, "\\'");
  }
}
