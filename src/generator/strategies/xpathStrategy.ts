// ============================================================
// XPath Locator Strategy
// Generates XPath expressions for elements.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';
import { isGeneratedId, xpathLiteral } from '../../util/stability';

export class XPathStrategy implements ILocatorStrategy {
  name: LocatorStrategy = 'xpath';

  generate(element: DiscoveredElement): LocatorResult[] {
    const results: LocatorResult[] = [];
    const tag = element.tag;

    // Attribute-based XPaths
    if (element.attributes['id'] && !isGeneratedId(element.attributes['id'])) {
      results.push(this.makeResult(`//${tag}[@id=${xpathLiteral(element.attributes['id'])}]`));
    }

    if (element.attributes['name']) {
      results.push(this.makeResult(`//${tag}[@name=${xpathLiteral(element.attributes['name'])}]`));
    }

    if (element.attributes['data-testid']) {
      results.push(this.makeResult(`//${tag}[@data-testid=${xpathLiteral(element.attributes['data-testid'])}]`));
    }

    if (element.attributes['aria-label']) {
      results.push(this.makeResult(`//${tag}[@aria-label=${xpathLiteral(element.attributes['aria-label'])}]`));
    }

    if (element.attributes['placeholder']) {
      results.push(this.makeResult(`//${tag}[@placeholder=${xpathLiteral(element.attributes['placeholder'])}]`));
    }

    // Text-based XPath
    if (element.text && element.text.length > 0 && element.text.length < 60) {
      results.push(
        this.makeResult(`//${tag}[normalize-space()=${xpathLiteral(element.text)}]`),
      );

      // Contains for partial match
      if (element.text.length > 10) {
        const shortText = element.text.substring(0, 30);
        results.push(
          this.makeResult(`//${tag}[contains(text(),${xpathLiteral(shortText)})]`),
        );
      }
    }

    // Positional XPath from CSS segments (converted)
    const positionalXPath = this.buildPositionalXPath(element);
    if (positionalXPath) {
      results.push(this.makeResult(positionalXPath));
    }

    return results;
  }

  private makeResult(value: string): LocatorResult {
    return {
      strategy: 'xpath',
      value,
      framework: 'xpath',
      score: 0,
      scoreReason: '',
    };
  }

  private buildPositionalXPath(element: DiscoveredElement): string | null {
    if (element.cssPathSegments.length === 0) return null;

    // XPath can't cross a shadow boundary, and a path that was truncated by
    // the traverser (no longer starting at <body>) can't be anchored.
    if (element.shadowDepth > 0) return null;
    if (element.cssPathSegments[0] !== 'body') return null;

    // Convert CSS path segments to XPath
    const xpathParts = element.cssPathSegments.map((seg) => {
      // Parse "tag:nth-of-type(n)" patterns
      const nthMatch = seg.match(/^(\w+):nth-of-type\((\d+)\)$/);
      if (nthMatch) {
        return `${nthMatch[1]}[${nthMatch[2]}]`;
      }

      // Parse "tag#id" patterns
      const idMatch = seg.match(/^(\w+)#(.+)$/);
      if (idMatch) {
        return `${idMatch[1]}[@id='${idMatch[2]}']`;
      }

      // Parse "tag.class1.class2" patterns
      const classMatch = seg.match(/^(\w+)\.(.+)$/);
      if (classMatch) {
        const classes = classMatch[2].split('.').map((c) => c.replace(/\\/g, ''));
        const conditions = classes.map((c) => `contains(@class,'${c}')`).join(' and ');
        return `${classMatch[1]}[${conditions}]`;
      }

      return seg;
    });

    const xpath = '/html/' + xpathParts.join('/');
    // Only return if reasonably short
    return xpath.length < 250 ? xpath : null;
  }

}
