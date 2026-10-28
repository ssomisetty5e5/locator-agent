// ============================================================
// CSS Locator Strategy
// Generates CSS selectors from element attributes and path.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';
import { isGeneratedClass, escapeCssAttr } from '../../util/stability';

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
      selectors.push(`${tag}[name="${escapeCssAttr(element.attributes['name'])}"]`);
    }

    // placeholder attribute
    if (element.attributes['placeholder']) {
      selectors.push(`${tag}[placeholder="${escapeCssAttr(element.attributes['placeholder'])}"]`);
    }

    // type attribute for inputs
    if (tag === 'input' && element.attributes['type']) {
      const type = element.attributes['type'];
      if (element.attributes['name']) {
        selectors.push(`input[type="${escapeCssAttr(type)}"][name="${escapeCssAttr(element.attributes['name'])}"]`);
      }
      if (element.attributes['placeholder']) {
        selectors.push(`input[type="${escapeCssAttr(type)}"][placeholder="${escapeCssAttr(element.attributes['placeholder'])}"]`);
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
          selectors.push(`a[href$="${escapeCssAttr(lastPart)}"]`);
        }
        if (href.length < 80) {
          selectors.push(`a[href="${escapeCssAttr(href)}"]`);
        }
      }
    }

    // title attribute
    if (element.attributes['title']) {
      selectors.push(`${tag}[title="${escapeCssAttr(element.attributes['title'])}"]`);
    }

    // value for buttons/inputs with static values
    if (element.attributes['value'] && (tag === 'input' || tag === 'button')) {
      const type = element.attributes['type'];
      if (type === 'submit' || type === 'button' || type === 'reset') {
        selectors.push(`${tag}[value="${escapeCssAttr(element.attributes['value'])}"]`);
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
      .filter((c) => !isGeneratedClass(c))
      .slice(0, 3);
  }

  private escapeCss(s: string): string {
    return s.replace(/([^\w-])/g, '\\$1');
  }
}
