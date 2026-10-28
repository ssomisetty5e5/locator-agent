// ============================================================
// Stability heuristics
// Shared checks for auto-generated ids / classes and selector
// escaping, so every strategy and the ranker agree on what counts
// as "unstable".
// ============================================================

/**
 * True when an id looks machine-generated (framework counters, hashes,
 * UUIDs) and is therefore likely to change between builds or renders.
 */
export function isGeneratedId(id: string): boolean {
  if (!id) return false;
  // React useId: ":r0:", ":r1a:"
  if (/^:r[0-9a-z]+:$/.test(id)) return true;
  // Random hex / hash ids
  if (/^[a-f0-9]{8,}$/i.test(id)) return true;
  // UUIDs, with or without a prefix
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(id)) return true;
  // Framework prefixes
  if (/^(ember|ng-|react-|__next|radix-|headlessui-|mui-|rc[-_]|:r)/i.test(id)) return true;
  // Angular Material / CDK counters: mat-input-4, cdk-overlay-12, mat-mdc-select-3
  if (/^(mat|cdk)(-[a-z]+)*-\d+$/i.test(id)) return true;
  // Trailing counters: input_12, field-4567, ext-gen1234
  if (/^[a-z][a-z-_]*[-_]?\d{3,}$/i.test(id)) return true;
  // Pure numeric
  if (/^\d+$/.test(id)) return true;
  return false;
}

/**
 * True when a class name looks generated (CSS modules, styled-components,
 * emotion, hashed utility output).
 */
export function isGeneratedClass(cls: string): boolean {
  if (!cls) return false;
  if (/^[a-z]{1,3}[0-9a-f]{4,}/i.test(cls)) return true;
  if (/^css-[a-z0-9]+$/i.test(cls)) return true;
  if (/^sc-[a-z0-9]+$/i.test(cls)) return true;
  if (/^_[a-z0-9]{5,}$/i.test(cls)) return true;
  if (/^[A-Z][a-zA-Z]+-[a-zA-Z]+-[a-z0-9]{5,}$/.test(cls)) return true;
  // CSS-modules style: Button_primary__x7Gh2
  if (/__[a-zA-Z0-9_-]{4,}$/.test(cls) && /[0-9]/.test(cls.split('__').pop() || '')) return true;
  // Angular view-encapsulation: ng-tns-c123-4, _ngcontent-abc-c12
  if (/^(ng-tns|_ngcontent|_nghost|ng-star-inserted)/.test(cls)) return true;
  return false;
}

/**
 * Escape a string for use inside a double-quoted CSS attribute value,
 * e.g. `[name="..."]`.
 */
export function escapeCssAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
}

/**
 * Inspect a locator's text for embedded unstable ids or classes, such as
 * `#mat-input-4`, `[id="ember123"]`, `.css-1x2y3z` or an XPath `@id='ng-5'`.
 * Returns human-readable descriptions of each unstable token found.
 */
export function findUnstableTokens(selector: string): string[] {
  const found: string[] = [];

  const ids = new Set<string>();
  for (const m of selector.matchAll(/#((?:\\.|[\w-])+)/g)) ids.add(m[1].replace(/\\/g, ''));
  for (const m of selector.matchAll(/\[id\s*=\s*["']([^"']+)["']\]/g)) ids.add(m[1]);
  for (const m of selector.matchAll(/@id\s*=\s*["']([^"']+)["']/g)) ids.add(m[1]);
  for (const id of ids) {
    if (isGeneratedId(id)) found.push(`generated id "${id}"`);
  }

  // Class tokens: ".foo" not part of a number or attribute value
  const withoutAttrs = selector.replace(/\[[^\]]*\]/g, '').replace(/(["']).*?\1/g, '');
  for (const m of withoutAttrs.matchAll(/\.((?:\\.|[\w-])+)/g)) {
    const cls = m[1].replace(/\\/g, '');
    if (isGeneratedClass(cls)) found.push(`generated class "${cls}"`);
  }

  return found;
}
