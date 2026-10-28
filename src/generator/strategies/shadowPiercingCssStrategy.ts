// ============================================================
// Shadow-Piercing CSS Locator Strategy
// Generates shadow-piercing CSS selectors using >>> notation.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';
import { isGeneratedId, isGeneratedClass, escapeCssAttr } from '../../util/stability';

export class ShadowPiercingCssStrategy implements ILocatorStrategy {
  name: LocatorStrategy = 'shadowPiercingCss';

  generate(element: DiscoveredElement): LocatorResult[] {
    const results: LocatorResult[] = [];

    // Only relevant for elements inside Shadow DOM
    if (element.shadowDepth === 0 || element.shadowHostChain.length === 0) {
      return results;
    }

    // Build the chain parts: [host1Sel, host2Sel, ..., targetSel]
    const chainParts = this.buildChainParts(element);
    if (!chainParts || chainParts.length < 2) return results;

    // Generate full-chain locators
    this.addLocatorSet(results, chainParts, false);

    // Generate shortened chains starting from each intermediate host.
    // If the chain is [A, B, C, D, target], try:
    //   [B, C, D, target], [C, D, target], [D, target]
    // These shorter variants will be validated for uniqueness later —
    // unique short chains will score higher than the long ones.
    if (chainParts.length > 2) {
      for (let start = 1; start < chainParts.length - 1; start++) {
        const shortened = chainParts.slice(start);
        if (shortened.length >= 2) {
          this.addLocatorSet(results, shortened, true);
        }
      }
    }

    return results;
  }

  /**
   * Add a PW, JS, and CSS locator set for the given chain parts.
   */
  private addLocatorSet(
    results: LocatorResult[],
    parts: string[],
    isShortened: boolean,
  ): void {
    const suffix = isShortened ? ' (short)' : '';

    // 1) Playwright — native shadow piercing with >>
    const playwrightSelector = parts.join(' >> ');
    results.push({
      strategy: 'shadowPiercingCss',
      value: playwrightSelector,
      framework: 'playwright',
      score: 0,
      scoreReason: suffix,
    });

    // 2) JavaScript — querySelector chain that works in Chrome DevTools console
    const jsChain = this.buildJsChain(parts);
    results.push({
      strategy: 'shadowPiercingCss',
      value: jsChain,
      framework: 'javascript',
      score: 0,
      scoreReason: suffix,
    });

    // 3) CSS >>> (deprecated but shown for reference) — only for full chain
    if (!isShortened) {
      const cssPiercing = parts.join(' >>> ');
      results.push({
        strategy: 'shadowPiercingCss',
        value: cssPiercing,
        framework: 'css',
        score: 0,
        scoreReason: '',
      });
    }
  }

  /**
   * Build the array of selectors: [host1, host2, ..., target].
   * Each shadow boundary is a separate step.
   */
  private buildChainParts(element: DiscoveredElement): string[] | null {
    const parts: string[] = [];

    for (const host of element.shadowHostChain) {
      parts.push(host);
    }

    const targetSel = this.buildTargetSelector(element);
    if (!targetSel) return null;

    parts.push(targetSel);
    return parts;
  }

  /**
   * Build a JavaScript querySelector chain that works in Chrome DevTools.
   * Each shadow boundary becomes a .shadowRoot.querySelector() step.
   */
  private buildJsChain(parts: string[]): string {
    if (parts.length === 0) return '';
    if (parts.length === 1) return `document.querySelector('${this.escapeJs(parts[0])}')`;

    // First part: document.querySelector('host1')
    let chain = `document.querySelector('${this.escapeJs(parts[0])}')`;

    // Middle parts: .shadowRoot.querySelector('host2')
    for (let i = 1; i < parts.length; i++) {
      chain += `.shadowRoot.querySelector('${this.escapeJs(parts[i])}')`;
    }

    return chain;
  }

  private escapeJs(s: string): string {
    return s.replace(/'/g, "\\'");
  }

  private buildTargetSelector(element: DiscoveredElement): string | null {
    const tag = element.tag;

    // Prefer specific attributes
    if (element.attributes['id'] && !isGeneratedId(element.attributes['id'])) {
      return `#${this.escapeCssVal(element.attributes['id'])}`;
    }
    if (element.attributes['data-testid']) {
      return `[data-testid="${escapeCssAttr(element.attributes['data-testid'])}"]`;
    }
    if (element.attributes['name']) {
      return `${tag}[name="${escapeCssAttr(element.attributes['name'])}"]`;
    }
    if (element.attributes['aria-label']) {
      return `${tag}[aria-label="${escapeCssAttr(element.attributes['aria-label'])}"]`;
    }
    if (element.attributes['label']) {
      return `${tag}[label="${escapeCssAttr(element.attributes['label'])}"]`;
    }
    if (element.attributes['icon']) {
      return `${tag}[icon="${escapeCssAttr(element.attributes['icon'])}"]`;
    }
    if (element.attributes['role']) {
      return `${tag}[role="${escapeCssAttr(element.attributes['role'])}"]`;
    }

    // Class-based
    const cls = element.attributes['class'];
    if (cls) {
      const classes = cls.split(/\s+/)
        .filter((c) => c.length > 0 && !isGeneratedClass(c))
        .map((c) => this.escapeCssVal(c))
        .slice(0, 2);
      if (classes.length > 0) {
        return `${tag}.${classes.join('.')}`;
      }
    }

    return tag;
  }

  private escapeCssVal(s: string): string {
    return s.replace(/([^\w-])/g, '\\$1');
  }

}
