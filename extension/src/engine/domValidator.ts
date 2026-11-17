// ============================================================
// DOM Validator
// Browser-side counterpart of LocatorValidator: checks, inside the
// page itself, how many elements each generated locator matches and
// whether they include the element it was generated for.
// ============================================================

import { LocatorResult } from '../../../src/types';
import { extractQueryableSelector, propagateDerived } from '../../../src/validator/classify';
import { QueryContext } from './domQueries';

export class DomValidator {
  private ctx = new QueryContext();

  constructor(private doc: Document) {}

  /** Fill `matchCount`, `isUnique` and `resolvesToTarget` on each locator (mutates in place). */
  async validate(locators: LocatorResult[], targetIndex?: number): Promise<void> {
    const win = this.doc.defaultView as (Window & { __laNodes?: Element[] }) | null;
    const target = targetIndex !== undefined && win?.__laNodes ? win.__laNodes[targetIndex] : null;

    for (const loc of locators) {
      const parsed = extractQueryableSelector(loc);
      if (!parsed) continue;

      let matches: Element[] | null = null;
      // A chain that doesn't resolve is simply "no match": it says nothing about the target
      let chainBroken = false;
      try {
        switch (parsed.type) {
          case 'css': {
            matches = Array.from(this.doc.querySelectorAll(parsed.value));
            // Playwright's locator('css') also searches open shadow roots
            const deep = this.ctx.cssDeep(this.doc, parsed.value);
            loc.deepMatchCount = deep.length;
            if (target) loc.deepResolvesToTarget = deep.includes(target);
            break;
          }
          case 'css-deep':
            matches = this.ctx.cssDeep(this.doc, parsed.value);
            loc.deepMatchCount = matches.length;
            if (target) loc.deepResolvesToTarget = matches.includes(target);
            break;
          case 'xpath':
            matches = this.xpath(parsed.value);
            break;
          case 'playwright':
            matches = this.ctx.evalExpression([this.doc], parsed.value);
            break;
          case 'playwright-locator':
            matches = this.playwrightLocator(loc);
            break;
          case 'js-chain': {
            const el = this.ctx.jsChain(this.doc, parsed.value);
            matches = el ? [el] : [];
            chainBroken = !el;
            break;
          }
        }
      } catch {
        matches = null; // invalid selector or expression: leave unvalidated
      }
      if (!matches) continue;

      loc.matchCount = matches.length;
      loc.isUnique = matches.length === 1;
      if (target && !chainBroken) loc.resolvesToTarget = matches.includes(target);
    }

    propagateDerived(locators);
  }

  private xpath(expr: string): Element[] {
    const snap = this.doc.evaluate(expr, this.doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const out: Element[] = [];
    for (let i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i) as Element);
    return out;
  }

  /** Scoped locators and Playwright `a >> b` chains. */
  private playwrightLocator(loc: LocatorResult): Element[] | null {
    if (loc.scope) {
      let scopes = this.ctx.cssDeep(this.doc, loc.scope.css);
      if (loc.scope.hasText) scopes = this.ctx.filterHasText(scopes, loc.scope.hasText);
      return this.ctx.evalExpression(scopes, loc.scope.inner);
    }
    return this.ctx.chain(this.doc, loc.value);
  }
}
