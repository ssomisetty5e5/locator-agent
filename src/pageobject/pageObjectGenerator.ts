// ============================================================
// Page Object Generator
// Turns a PageAnalysis into a ready-to-use Playwright (TypeScript)
// page object: one named Locator property per element, using the best
// validated locator, with iframe chains included.
// ============================================================

import { ElementAnalysis, LocatorResult, PageAnalysis } from '../types';
import { playwrightFramePrefix } from '../util/frames';
import { nameElements, toPascal, toWords } from './elementNamer';

export interface PageObjectOptions {
  /** Class name; derived from the page title/URL when omitted */
  className?: string;
  /** Module to import `Page` and `Locator` types from (default '@playwright/test') */
  importFrom?: string;
  /** Skip elements whose best locator scores below this (default 0) */
  minScore?: number;
  /** Omit the goto() method even for URL sources */
  noGoto?: boolean;
}

export interface GeneratedElement {
  name: string;
  /** Playwright expression, rooted at `page` */
  expression: string;
  score: number;
  /** True when the locator matched exactly the target element during analysis */
  verified: boolean;
  framePath?: string[];
}

export interface GeneratedPageObject {
  className: string;
  code: string;
  elements: GeneratedElement[];
  /** Elements left out (no Playwright-expressible locator, or below minScore) */
  skipped: number;
}

/** `'it''s'`-safe single-quoted TS string literal. */
function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/**
 * Playwright expression (rooted at `page`) for a locator, or null when the
 * locator has no direct Playwright equivalent (Selenium, WebdriverIO, JS, `>>>`).
 */
export function toPlaywrightExpression(loc: LocatorResult): string | null {
  const root = loc.framePath && loc.framePath.length > 0
    ? `page.${playwrightFramePrefix(loc.framePath)}`
    : 'page';

  if (loc.framework === 'playwright') {
    if (loc.value.startsWith('getBy') || loc.value.startsWith('locator(')) return `${root}.${loc.value}`;
    return `${root}.locator(${quote(loc.value)})`;
  }
  if (loc.framework === 'css') {
    if (loc.value.includes('>>>')) return null; // deprecated deep combinator, not valid in Playwright
    return `${root}.locator(${quote(loc.value)})`;
  }
  if (loc.framework === 'xpath') {
    return `${root}.locator(${quote('xpath=' + loc.value)})`;
  }
  return null;
}

/** Choose the element's best locator, preferring ones proven to hit exactly the target. */
function pickLocator(analysis: ElementAnalysis): { expression: string; loc: LocatorResult; verified: boolean } | null {
  const candidates = analysis.locators
    .map((loc) => ({ loc, expression: toPlaywrightExpression(loc) }))
    .filter((c): c is { loc: LocatorResult; expression: string } => c.expression !== null);

  const verified = candidates.find((c) => c.loc.matchCount === 1 && c.loc.resolvesToTarget !== false);
  if (verified) return { ...verified, verified: true };
  if (candidates.length > 0) return { ...candidates[0], verified: false };
  return null;
}

/** "Sign in to Acme" -> SignInToAcmePage; falls back to the URL, then "Generated". */
export function deriveClassName(analysis: PageAnalysis): string {
  const fromWords = (text: string) => {
    const words = toWords(text).slice(0, 4);
    return words.length > 0 ? toPascal(words) : '';
  };

  let base = fromWords(analysis.pageTitle || '');
  if (!base && /^https?:\/\//.test(analysis.source)) {
    try {
      const u = new URL(analysis.source);
      base = fromWords(u.pathname.split('/').filter(Boolean).pop() || '') || fromWords(u.hostname.replace(/^www\./, ''));
    } catch {
      // fall through
    }
  }
  if (!base) base = 'Generated';
  if (/^\d/.test(base)) base = `Page${base}`;
  return base.endsWith('Page') ? base : `${base}Page`;
}

function sanitizeClassName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, '');
  if (!cleaned) return 'GeneratedPage';
  return /^\d/.test(cleaned) ? `Page${cleaned}` : cleaned;
}

export function generatePageObject(analysis: PageAnalysis, options: PageObjectOptions = {}): GeneratedPageObject {
  const className = sanitizeClassName(options.className ?? deriveClassName(analysis));
  const importFrom = options.importFrom ?? '@playwright/test';
  const minScore = options.minScore ?? 0;

  // Pick locators first: names for duplicates depend on the chosen locator's scope.
  const picked: { analysis: ElementAnalysis; expression: string; verified: boolean }[] = [];
  const seenExpressions = new Set<string>();
  let skipped = 0;

  for (const a of analysis.elements) {
    const choice = pickLocator(a);
    if (!choice || choice.loc.score < minScore) { skipped++; continue; }
    if (seenExpressions.has(choice.expression)) { skipped++; continue; } // same locator, same element
    seenExpressions.add(choice.expression);
    picked.push({ analysis: { ...a, recommended: choice.loc }, expression: choice.expression, verified: choice.verified });
  }

  const names = nameElements(picked.map((p) => p.analysis));
  const elements: GeneratedElement[] = picked.map((p, i) => ({
    name: names[i],
    expression: p.expression,
    score: p.analysis.recommended.score,
    verified: p.verified,
    framePath: p.analysis.recommended.framePath,
  }));

  const isUrl = /^https?:\/\//.test(analysis.source);
  const lines: string[] = [];
  lines.push(`import type { Page, Locator } from ${quote(importFrom)};`);
  lines.push('');
  lines.push('/**');
  lines.push(` * Page object for ${analysis.pageTitle ? `"${analysis.pageTitle.replace(/\*\//g, '* /')}"` : 'the analyzed page'}.`);
  if (isUrl) lines.push(` * Source: ${analysis.source}`);
  lines.push(' * Generated by LocatorAgent; locators were validated against the live page.');
  lines.push(' */');
  lines.push(`export class ${className} {`);
  lines.push('  readonly page: Page;');
  for (const e of elements) lines.push(`  readonly ${e.name}: Locator;`);
  lines.push('');
  lines.push('  constructor(page: Page) {');
  lines.push('    this.page = page;');
  picked.forEach((p, i) => {
    const note = p.verified ? '' : ' // TODO: not verified unique, check before relying on it';
    lines.push(`    this.${elements[i].name} = ${p.expression};${note}`);
  });
  lines.push('  }');
  if (isUrl && !options.noGoto) {
    lines.push('');
    lines.push('  async goto(): Promise<void> {');
    lines.push(`    await this.page.goto(${quote(analysis.source)});`);
    lines.push('  }');
  }
  lines.push('}');
  lines.push('');

  return { className, code: lines.join('\n'), elements, skipped };
}
