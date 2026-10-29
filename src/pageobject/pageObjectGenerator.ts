// ============================================================
// Page Object Generator
// Turns a PageAnalysis into a ready-to-use Playwright page object
// (TypeScript, Python or Java): one named Locator property per element, using the best
// validated locator, with iframe chains included.
// ============================================================

import { ElementAnalysis, LocatorResult, PageAnalysis } from '../types';
import { playwrightFramePrefix } from '../util/frames';
import { nameElements, toPascal, toWords } from './elementNamer';
import {
  LANGUAGES,
  PageObjectLanguage,
  propertyName,
  renderPageObject,
  translateExpression,
} from './renderers';

export interface PageObjectOptions {
  /** Output language (default 'typescript') */
  language?: PageObjectLanguage;
  /** Java only: package declaration for the generated class */
  javaPackage?: string;
  /** Class name; derived from the page title/URL when omitted */
  className?: string;
  /** TypeScript only: module to import `Page` and `Locator` types from (default '@playwright/test') */
  importFrom?: string;
  /** Skip elements whose best locator scores below this (default 0) */
  minScore?: number;
  /** Omit the goto() method even for URL sources */
  noGoto?: boolean;
}

export interface GeneratedElement {
  /** Property name in the target language (snake_case for Python) */
  name: string;
  /** Playwright TypeScript expression, rooted at `page` (language-neutral form) */
  expression: string;
  /** The same locator written in the target language */
  code: string;
  score: number;
  /** True when the locator matched exactly the target element during analysis */
  verified: boolean;
  framePath?: string[];
}

export interface GeneratedPageObject {
  className: string;
  language: PageObjectLanguage;
  code: string;
  elements: GeneratedElement[];
  /** Elements left out (no Playwright-expressible locator, or below minScore) */
  skipped: number;
}

/** How many score points a descriptive locator may trail a bare role locator and still win. */
const BARE_ROLE_MARGIN = 25;

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

  const verifiedList = candidates.filter((c) => c.loc.matchCount === 1 && c.loc.resolvesToTarget !== false);
  if (verifiedList.length > 0) {
    // A name-less role locator ("the only textbox") is unique today but silently
    // stops being unique when another such control is added. Prefer a descriptive
    // verified locator (placeholder, label, test id…) when one scores comparably.
    const isBareRole = (c: { loc: LocatorResult }) => /^getByRole\('[^']+'\)$/.test(c.loc.value);
    let best = verifiedList[0];
    if (isBareRole(best)) {
      const alternative = verifiedList.find((c) => !isBareRole(c) && c.loc.score >= best.loc.score - BARE_ROLE_MARGIN);
      if (alternative) best = alternative;
    }
    return { ...best, verified: true };
  }
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
  const language: PageObjectLanguage = options.language ?? 'typescript';
  if (!LANGUAGES.includes(language)) {
    throw new Error(`Unsupported language "${language}". Use one of: ${LANGUAGES.join(', ')}`);
  }

  const className = sanitizeClassName(options.className ?? deriveClassName(analysis));
  const importFrom = options.importFrom ?? '@playwright/test';
  const minScore = options.minScore ?? 0;

  // Pick locators first: names for duplicates depend on the chosen locator's scope.
  const picked: { analysis: ElementAnalysis; expression: string; code: string; verified: boolean }[] = [];
  const seenExpressions = new Set<string>();
  let skipped = 0;

  for (const a of analysis.elements) {
    const choice = pickLocator(a);
    if (!choice || choice.loc.score < minScore) { skipped++; continue; }
    if (seenExpressions.has(choice.expression)) { skipped++; continue; } // same locator, same element

    // Must be expressible in the target language (Python/Java cover a subset of what TS can chain)
    const translated = translateExpression(choice.expression, language);
    if (!translated) { skipped++; continue; }

    seenExpressions.add(choice.expression);
    picked.push({
      analysis: { ...a, recommended: choice.loc },
      expression: choice.expression,
      code: translated.code,
      verified: choice.verified,
    });
  }

  // Names follow the target language's conventions (snake_case in Python) and stay unique
  const baseNames = nameElements(picked.map((p) => p.analysis));
  const used = new Set<string>();
  const names = baseNames.map((n) => {
    const converted = propertyName(n, language);
    let unique = converted;
    for (let i = 2; used.has(unique); i++) unique = `${converted}${language === 'python' ? '_' : ''}${i}`;
    used.add(unique);
    return unique;
  });

  const elements: GeneratedElement[] = picked.map((p, i) => ({
    name: names[i],
    expression: p.expression,
    code: p.code,
    score: p.analysis.recommended.score,
    verified: p.verified,
    framePath: p.analysis.recommended.framePath,
  }));

  const code = renderPageObject(language, {
    className,
    title: analysis.pageTitle || '',
    source: analysis.source,
    goto: /^https?:\/\//.test(analysis.source) && !options.noGoto,
    importFrom,
    javaPackage: options.javaPackage,
    elements: elements.map((e) => ({ name: e.name, expression: e.expression, verified: e.verified })),
  });

  return { className, language, code, elements, skipped };
}
