// ============================================================
// Name Locator Strategy
// Generates locators based on the name attribute.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';

export class NameStrategy implements ILocatorStrategy {
  name: LocatorStrategy = 'name';

  generate(element: DiscoveredElement): LocatorResult[] {
    const results: LocatorResult[] = [];
    const nameAttr = element.attributes['name'];

    if (!nameAttr) return results;

    // CSS
    results.push({
      strategy: 'name',
      value: `${element.tag}[name="${nameAttr}"]`,
      framework: 'css',
      score: 0,
      scoreReason: '',
    });

    // Selenium By.NAME
    results.push({
      strategy: 'name',
      value: nameAttr,
      framework: 'selenium',
      score: 0,
      scoreReason: '',
    });

    return results;
  }
}
