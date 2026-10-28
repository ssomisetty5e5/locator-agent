// ============================================================
// WebdriverIO Framework Adapter
// Translates already-generated css/xpath/playwright locators into
// WebdriverIO's `$()` selector syntax (CSS, XPath, deep/shadow-piercing,
// accessibility "aria/" name selectors, and "=" / "*=" text selectors).
//
// This is the pattern to follow for adding future frameworks (Cypress,
// TestCafe, Puppeteer, etc.): implement IFrameworkAdapter in a new file
// and register it in ./index.ts — no changes needed to the strategies.
// ============================================================

import { DiscoveredElement, IFrameworkAdapter, LocatorResult } from '../../types';

export class WebdriverIOAdapter implements IFrameworkAdapter {
  framework: 'webdriverio' = 'webdriverio';

  adapt(locator: LocatorResult, _element: DiscoveredElement): LocatorResult | LocatorResult[] | null {
    // Scoped locators are chained Playwright expressions with no `$()` equivalent
    if (locator.strategy === 'scoped') return null;

    switch (locator.framework) {
      case 'css':
        return this.fromCss(locator);
      case 'xpath':
        return this.fromXPath(locator);
      case 'playwright':
        return this.fromPlaywright(locator);
      default:
        return null;
    }
  }

  private fromCss(locator: LocatorResult): LocatorResult | null {
    // WDIO's deep-selector combinator for shadow DOM piercing uses the
    // same `>>>` syntax as the CSS shadow-piercing strategy already emits.
    return this.wrap(locator, `$('${this.escapeSingleQuotes(locator.value)}')`);
  }

  private fromXPath(locator: LocatorResult): LocatorResult | null {
    // WDIO auto-detects XPath when the selector starts with "/" or "(".
    // Use double quotes unless the expression itself contains one.
    const quoted = locator.value.includes('"')
      ? `'${this.escapeSingleQuotes(locator.value)}'`
      : `"${locator.value}"`;
    return this.wrap(locator, `$(${quoted})`);
  }

  private fromPlaywright(locator: LocatorResult): LocatorResult | null {
    const value = locator.value;

    // getByRole('role', { name: 'Name' }) → aria/Name (falls back to [role="x"])
    const roleMatch = value.match(/^getByRole\('([^']+)'(?:\s*,\s*\{\s*name:\s*'([^']*)'\s*\})?\)$/);
    if (roleMatch) {
      const [, role, name] = roleMatch;
      return this.wrap(
        locator,
        name ? `$('aria/${this.escapeSingleQuotes(name)}')` : `$('[role="${role}"]')`,
      );
    }

    // getByText('Text') → =Text (exact match)
    const textMatch = value.match(/^getByText\('([^']*)'\)$/);
    if (textMatch) {
      return this.wrap(locator, `$('=${this.escapeSingleQuotes(textMatch[1])}')`);
    }

    // getByLabel('Label') → aria/Label
    const labelMatch = value.match(/^getByLabel\('([^']*)'\)$/);
    if (labelMatch) {
      return this.wrap(locator, `$('aria/${this.escapeSingleQuotes(labelMatch[1])}')`);
    }

    // getByPlaceholder('Text') → [placeholder="Text"]
    const phMatch = value.match(/^getByPlaceholder\('([^']*)'\)$/);
    if (phMatch) {
      return this.wrap(locator, `$('[placeholder="${phMatch[1]}"]')`);
    }

    // Shadow-piercing chain rendered with Playwright's " >> " separator →
    // WDIO deep selector uses " >>> " between the same parts.
    if (locator.strategy === 'shadowPiercingCss' && value.includes(' >> ')) {
      return this.wrap(locator, `$('${value.split(' >> ').join(' >>> ')}')`);
    }

    // Anything else under the 'playwright' framework that isn't a getBy*
    // call is already a plain CSS selector (e.g. IdStrategy's `#id`).
    if (!value.startsWith('getBy')) {
      return this.wrap(locator, `$('${this.escapeSingleQuotes(value)}')`);
    }

    return null;
  }

  private wrap(locator: LocatorResult, value: string): LocatorResult {
    return {
      ...locator,
      framework: 'webdriverio',
      value,
    };
  }

  private escapeSingleQuotes(s: string): string {
    return s.replace(/'/g, "\\'");
  }
}
