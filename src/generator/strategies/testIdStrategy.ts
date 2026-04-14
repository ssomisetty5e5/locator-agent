// ============================================================
// Test ID Locator Strategy
// Generates locators based on data-testid attributes.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';

export class TestIdStrategy implements ILocatorStrategy {
  name: LocatorStrategy = 'testId';

  generate(element: DiscoveredElement): LocatorResult[] {
    const results: LocatorResult[] = [];
    const testId =
      element.attributes['data-testid'] ||
      element.attributes['data-test-id'] ||
      element.attributes['data-test'] ||
      element.attributes['data-cy'] ||
      element.attributes['data-qa'];

    if (!testId) return results;

    // Determine which attribute name was found
    const attrName = element.attributes['data-testid']
      ? 'data-testid'
      : element.attributes['data-test-id']
        ? 'data-test-id'
        : element.attributes['data-test']
          ? 'data-test'
          : element.attributes['data-cy']
            ? 'data-cy'
            : 'data-qa';

    // Playwright format
    results.push({
      strategy: 'testId',
      value: testId,
      framework: 'playwright',
      score: 0, // scored by ranker
      scoreReason: '',
    });

    // CSS format
    results.push({
      strategy: 'testId',
      value: `[${attrName}="${testId}"]`,
      framework: 'css',
      score: 0,
      scoreReason: '',
    });

    // Selenium format
    results.push({
      strategy: 'testId',
      value: `[${attrName}="${testId}"]`,
      framework: 'selenium',
      score: 0,
      scoreReason: '',
    });

    return results;
  }
}
