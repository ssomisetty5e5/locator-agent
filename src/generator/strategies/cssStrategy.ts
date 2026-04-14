// ============================================================
// CSS Locator Strategy
// Generates CSS selectors from element attributes and path.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';

export class CssStrategy implements ILocatorStrategy {
  name: LocatorStrategy = 'css';

  generate(element: DiscoveredElement): LocatorResult[] {
    const results: LocatorResult[] = [];

    // Attribute-based CSS selectors
    const attrSelectors = this.generateAttributeSelectors(element);
    for (const sel of attrSelectors) {
      results.push({
        strategy: 'css',
        value: sel,
        framework: 'css',
        score: 0,
        scoreReason: '',
      });
    }

    // Full CSS path from traverser
    if (element.cssPathSegments.length > 0) {
      const fullPath = element.cssPathSegments.join(' > ');
      // Only use if it's reasonably short
      if (fullPath.length < 200) {
        results.push({
          strategy: 'css',
          value: fullPath,
          framework: 'css',
          score: 0,
          scoreReason: '',
        });
      }
    }

    return results;
  }

  private generateAttributeSelectors(element: DiscoveredElement): string[] {
    const selectors: string[] = [];
    const tag = element.tag;

    // name attribute
    if (element.attributes['name']) {
      selectors.push(`${tag}[name="${element.attributes['name']}"]`);
    }

    // placeholder attribute
    if (element.attributes['placeholder']) {
      selectors.push(`${tag}[placeholder="${element.attributes['placeholder']}"]`);
    }

    // type attribute for inputs
    if (tag === 'input' && element.attributes['type']) {
      const type = element.attributes['type'];
      if (element.attributes['name']) {
        selectors.push(`input[type="${type}"][name="${element.attributes['name']}"]`);
      }
      if (element.attributes['placeholder']) {
        selectors.push(`input[type="${type}"][placeholder="${element.attributes['placeholder']}"]`);
      }
    }

    // href for links
    if (tag === 'a' && element.attributes['href']) {
      const href = element.attributes['href'];
      if (!href.startsWith('javascript:') && href !== '#') {
        // Use ends-with for cleaner selectors
        const parts = href.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.length > 0 && lastPart.length < 50) {
          selectors.push(`a[href$="${lastPart}"]`);
        }
        if (href.length < 80) {
          selectors.push(`a[href="${href}"]`);
        }
      }
    }

    // title attribute
    if (element.attributes['title']) {
      selectors.push(`${tag}[title="${element.attributes['title']}"]`);
    }

    // value for buttons/inputs with static values
    if (element.attributes['value'] && (tag === 'input' || tag === 'button')) {
      const type = element.attributes['type'];
      if (type === 'submit' || type === 'button' || type === 'reset') {
        selectors.push(`${tag}[value="${element.attributes['value']}"]`);
      }
    }

    // class-based selector (only meaningful classes)
    const classes = this.getMeaningfulClasses(element);
    if (classes.length > 0) {
      const classSel = `${tag}.${classes.map((c) => this.escapeCss(c)).join('.')}`;
      if (classSel.length < 100) {
        selectors.push(classSel);
      }
    }

    return selectors;
  }

  private getMeaningfulClasses(element: DiscoveredElement): string[] {
    const classAttr = element.attributes['class'] || '';
    if (!classAttr) return [];

    return classAttr
      .split(/\s+/)
      .filter((c) => c.length > 0)
      .filter((c) => !this.isGeneratedClass(c))
      .slice(0, 3);
  }

  private isGeneratedClass(cls: string): boolean {
    // Skip hash/auto-generated classes (CSS modules, styled-components, etc.)
    if (/^[a-z]{1,3}[0-9a-f]{4,}/i.test(cls)) return true;
    if (/^css-[a-z0-9]+$/i.test(cls)) return true;
    if (/^sc-[a-z]+$/i.test(cls)) return true;
    if (/^_[a-z0-9]{5,}$/i.test(cls)) return true;
    if (/^[A-Z][a-zA-Z]+-[a-zA-Z]+-[a-z0-9]{5,}$/.test(cls)) return true;
    return false;
  }

  private escapeCss(s: string): string {
    return s.replace(/([^\w-])/g, '\\$1');
  }
}
