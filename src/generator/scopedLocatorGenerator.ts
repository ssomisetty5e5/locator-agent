// ============================================================
// Scoped Locator Generator
// For elements whose own attributes aren't unique (the "Delete" button
// in every table row), build locators that first narrow to a distinguishing
// ancestor and then find the element inside it:
//   page.locator('tr').filter({ hasText: 'Invoice 1042' }).getByRole('button', { name: 'Delete' })
// Candidates are only proposals; the validator decides which ones are
// unique and really hit the target.
// ============================================================

import { AncestorInfo, DiscoveredElement, LocatorResult } from '../types';
import { escapeCssAttr, isGeneratedId } from '../util/stability';

/** Containers that usually represent a repeated "item": rows, list items, cards, dialogs. */
const CONTAINER_TAGS = new Set([
  'tr', 'li', 'article', 'form', 'dialog', 'fieldset', 'section', 'nav', 'aside',
  'details', 'ul', 'ol', 'table', 'tbody', 'main',
]);

const MAX_TEXTS_PER_SCOPE = 3;
const MAX_INNERS = 3;
const DEFAULT_MAX_CANDIDATES = 18;

export class ScopedLocatorGenerator {
  /**
   * Build scoped locator candidates for `element`.
   *
   * @param baseLocators  The element's own locators (used to describe the target inside the scope)
   * @param ancestors     Nearest-first ancestor info from the page-side probe
   */
  generate(
    element: DiscoveredElement,
    baseLocators: LocatorResult[],
    ancestors: AncestorInfo[],
    maxCandidates = DEFAULT_MAX_CANDIDATES,
  ): LocatorResult[] {
    const inners = this.pickInnerExpressions(baseLocators);
    if (inners.length === 0) return [];

    const scopes = this.buildScopes(ancestors);
    const results: LocatorResult[] = [];
    const seen = new Set<string>();

    // Interleave so every scope gets tried with the best inner first
    // before the cap cuts anything off.
    for (let i = 0; i < inners.length; i++) {
      for (const scope of scopes) {
        const value = this.render(scope.css, scope.hasText, inners[i]);
        if (seen.has(value)) continue;
        seen.add(value);
        results.push({
          strategy: 'scoped',
          value,
          framework: 'playwright',
          score: 0,
          scoreReason: '',
          framePath: element.framePath,
          scope: { css: scope.css, hasText: scope.hasText, inner: inners[i] },
        });
        if (results.length >= maxCandidates) return results;
      }
    }
    return results;
  }

  /** Playwright expressions for the target, in order of robustness. */
  private pickInnerExpressions(base: LocatorResult[]): string[] {
    const order = ['testId', 'ariaRole', 'ariaLabel', 'placeholder', 'text', 'name', 'css'];
    const inners: string[] = [];

    for (const strategy of order) {
      for (const loc of base) {
        if (loc.strategy !== strategy || loc.framework !== 'playwright') continue;
        const usable = loc.value.startsWith('getBy');
        if (!usable) continue;
        if (!inners.includes(loc.value)) inners.push(loc.value);
      }
    }

    // Plain CSS attribute selectors work as inner locators too, e.g. input[name="email"]
    if (inners.length < MAX_INNERS) {
      for (const loc of base) {
        if (loc.strategy !== 'css' || loc.framework !== 'css') continue;
        if (loc.value.includes(' > ') || loc.value.includes(':nth-')) continue; // positional paths aren't scoped-friendly
        if (loc.value.length > 60) continue;
        const expr = `locator(${quote(loc.value)})`;
        if (!inners.includes(expr)) inners.push(expr);
      }
    }
    return inners.slice(0, MAX_INNERS);
  }

  /** Ancestor-based scopes, most stable kinds first. */
  private buildScopes(ancestors: AncestorInfo[]): { css: string; hasText?: string }[] {
    const stable: { css: string; hasText?: string }[] = [];
    const textual: { css: string; hasText?: string }[] = [];

    for (const a of ancestors) {
      // 1) Identified containers: a stable id / test id / aria-label pins one ancestor
      if (a.id && !isGeneratedId(a.id)) {
        stable.push({ css: `#${a.id.replace(/([^\w-])/g, '\\$1')}` });
      }
      if (a.testId) {
        stable.push({ css: `[data-testid="${escapeCssAttr(a.testId)}"]` });
      }
      if (a.ariaLabel) {
        stable.push({ css: `${a.tag}[aria-label="${escapeCssAttr(a.ariaLabel)}"]` });
      }

      // 2) Repeated containers (row, list item, card) narrowed by their own text
      const containerCss = a.role
        ? `[role="${escapeCssAttr(a.role)}"]`
        : CONTAINER_TAGS.has(a.tag) ? a.tag : null;
      if (containerCss) {
        for (const text of a.texts.slice(0, MAX_TEXTS_PER_SCOPE)) {
          textual.push({ css: containerCss, hasText: text });
        }
      }
    }

    return [...stable, ...textual];
  }

  private render(css: string, hasText: string | undefined, inner: string): string {
    const filter = hasText ? `.filter({ hasText: ${quote(hasText)} })` : '';
    return `locator(${quote(css)})${filter}.${inner}`;
  }
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
