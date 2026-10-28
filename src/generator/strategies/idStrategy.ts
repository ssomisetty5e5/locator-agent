// ============================================================
// ID Locator Strategy
// Generates locators based on element id attribute.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';
import { isGeneratedId } from '../../util/stability';

export class IdStrategy implements ILocatorStrategy {
  name: LocatorStrategy = 'id';

  generate(element: DiscoveredElement): LocatorResult[] {
    const results: LocatorResult[] = [];
    const id = element.attributes['id'];

    if (!id) return results;

    // Skip auto-generated IDs (e.g., ":r0:", "react-123", "ember456", random hashes)
    if (isGeneratedId(id)) return results;

    // CSS #id
    results.push({
      strategy: 'id',
      value: `#${this.escapeCss(id)}`,
      framework: 'css',
      score: 0,
      scoreReason: '',
    });

    // Playwright
    results.push({
      strategy: 'id',
      value: `#${this.escapeCss(id)}`,
      framework: 'playwright',
      score: 0,
      scoreReason: '',
    });

    // Selenium By.ID
    results.push({
      strategy: 'id',
      value: id,
      framework: 'selenium',
      score: 0,
      scoreReason: '',
    });

    return results;
  }

  private escapeCss(s: string): string {
    return s.replace(/([^\w-])/g, '\\$1');
  }
}
