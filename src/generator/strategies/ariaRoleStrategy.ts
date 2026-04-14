// ============================================================
// Aria Role Locator Strategy
// Generates locators based on ARIA roles.
// ============================================================

import { DiscoveredElement, LocatorResult, ILocatorStrategy, LocatorStrategy } from '../../types';

export class AriaRoleStrategy implements ILocatorStrategy {
  name: LocatorStrategy = 'ariaRole';

  generate(element: DiscoveredElement): LocatorResult[] {
    const results: LocatorResult[] = [];
    const role = element.ariaRole || this.inferRole(element);

    if (!role) return results;

    // Build name qualifier for specificity
    const name = element.attributes['aria-label'] || element.text || '';

    // Playwright getByRole
    if (name) {
      results.push({
        strategy: 'ariaRole',
        value: `getByRole('${role}', { name: '${this.escapeQuotes(name)}' })`,
        framework: 'playwright',
        score: 0,
        scoreReason: '',
      });
    } else {
      results.push({
        strategy: 'ariaRole',
        value: `getByRole('${role}')`,
        framework: 'playwright',
        score: 0,
        scoreReason: '',
      });
    }

    // CSS fallback with [role="..."]
    if (element.attributes['role']) {
      results.push({
        strategy: 'ariaRole',
        value: `[role="${role}"]`,
        framework: 'css',
        score: 0,
        scoreReason: '',
      });
    }

    return results;
  }

  private inferRole(element: DiscoveredElement): string | null {
    const roleMap: Record<string, string> = {
      button: 'button',
      a: 'link',
      input: this.inferInputRole(element),
      select: 'combobox',
      textarea: 'textbox',
      nav: 'navigation',
      main: 'main',
      header: 'banner',
      footer: 'contentinfo',
      aside: 'complementary',
      dialog: 'dialog',
      form: 'form',
      img: 'img',
      table: 'table',
      ul: 'list',
      ol: 'list',
      li: 'listitem',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
    };
    return roleMap[element.tag] || null;
  }

  private inferInputRole(element: DiscoveredElement): string {
    const type = (element.attributes['type'] || 'text').toLowerCase();
    const inputRoles: Record<string, string> = {
      text: 'textbox',
      email: 'textbox',
      password: 'textbox',
      search: 'searchbox',
      tel: 'textbox',
      url: 'textbox',
      number: 'spinbutton',
      checkbox: 'checkbox',
      radio: 'radio',
      range: 'slider',
      button: 'button',
      submit: 'button',
      reset: 'button',
    };
    return inputRoles[type] || 'textbox';
  }

  private escapeQuotes(s: string): string {
    return s.replace(/'/g, "\\'");
  }
}
