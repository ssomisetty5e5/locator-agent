// ============================================================
// Locator improvements
// For an element whose best locator is weak, work out what the
// application could add (a test id, an accessible name, a stable
// id, a key on a repeated row) and what the ideal locator would
// then be. Also formats that as a note a developer can act on.
// Pure functions: no browser or Playwright, so the extension,
// the CLI and the API can all use them.
// ============================================================

import { DiscoveredElement, ElementAnalysis, LocatorResult, PageAnalysis } from '../types';
import { weakReason } from '../cli/ciGate';
import { baseName, elementKind, toWords } from '../pageobject/elementNamer';
import { isGeneratedId } from '../util/stability';

/** Below this score a best locator counts as weak (the UI shows 80+ as green, so 70 is already generous). */
export const WEAK_SCORE = 70;

export type ImprovementKind = 'testId' | 'uniqueTestId' | 'accessibleName' | 'stableId' | 'rowKey';

export interface Improvement {
  kind: ImprovementKind;
  /** What to add to the application's markup, e.g. `data-testid="save-button"` */
  snippet: string;
  /** The Playwright locator tests could use once it is added */
  idealLocator: string;
  /** Why this helps */
  reason: string;
}

export interface LocatorSuggestion {
  /** The recommended locator's score, and why it can't be trusted */
  score: number;
  problem: string;
  improvements: Improvement[];
}

export interface NoteContext {
  pageUrl?: string;
  pageTitle?: string;
}

const ROLE_BY_KIND: Record<string, string> = {
  Button: 'button', Link: 'link', Input: 'textbox', TextArea: 'textbox', Checkbox: 'checkbox',
  Radio: 'radio', Select: 'combobox', Tab: 'tab', MenuItem: 'menuitem', Option: 'option',
};

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Inline code that can't be broken by a backtick or a newline in the value. */
const code = (s: string) => `\`${s.replace(/`/g, "'").replace(/\s+/g, ' ')}\``;

/** A readable kebab-case test id for an element: "Save" button -> save-button. */
export function suggestedTestId(el: DiscoveredElement): string {
  let words = toWords(baseName(el));
  const kind = elementKind(el).toLowerCase();
  const tag = el.tag.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const joined = words.join('');
  // No label to name it by (icon-only control): lead with the component it lives in
  if ((words.length === 0 || joined === kind || joined === tag) && el.shadowHost) {
    words = [...toWords(el.shadowHost), ...words];
  }
  return words.slice(0, 6).join('-') || el.tag;
}

function hasAccessibleName(el: DiscoveredElement): boolean {
  const a = el.attributes;
  return Boolean(
    el.text?.trim() || a['aria-label'] || a['aria-labelledby'] || a['title'] || a['alt'] ||
    a['placeholder'] || (el.tag === 'input' && a['value']),
  );
}

function improvementsFor(a: ElementAnalysis, testId: string): Improvement[] {
  const el = a.element;
  const rec = a.recommended;
  const attrs = el.attributes;
  const out: Improvement[] = [];

  // Repeated item found only through its text: give the row/card a stable key
  if (rec.scope) {
    out.push({
      kind: 'rowKey',
      snippet: `data-testid="row-<record id>" on the repeated <${rec.scope.css.replace(/[^\w-].*$/, '') || 'container'}>`,
      idealLocator: `page.getByTestId('row-<record id>').${rec.scope.inner}`,
      reason: 'This element repeats, so it is found through the text of its row, which changes with the data. A key that is stable per record keeps it findable.',
    });
  }

  if (!attrs['data-testid']) {
    out.push({
      kind: 'testId',
      snippet: `data-testid="${testId}"`,
      idealLocator: `page.getByTestId(${q(testId)})`,
      reason: el.shadowDepth > 0
        ? 'A dedicated test attribute is the most stable hook. Put it on the element inside the component, not only on its host.'
        : 'A dedicated test attribute is the most stable hook: it survives changes to text, layout and language.',
    });
  } else if (a.locators.some((l) => l.strategy === 'testId' && (l.matchCount ?? 1) > 1)) {
    out.push({
      kind: 'uniqueTestId',
      snippet: `data-testid="${attrs['data-testid']}" is used by more than one element: make each value unique`,
      idealLocator: `page.getByTestId(${q(attrs['data-testid'])})`,
      reason: 'A test id only helps when it identifies a single element.',
    });
  }

  const role = el.ariaRole || ROLE_BY_KIND[elementKind(el)];
  if (el.isInteractive && role && !hasAccessibleName(el)) {
    const label = '<what this control does>';
    out.push({
      kind: 'accessibleName',
      snippet: `aria-label="${label}"`,
      idealLocator: `page.getByRole(${q(role)}, { name: ${q(label)} })`,
      reason: 'The control has no text or label, so neither people using a screen reader nor tests can tell what it is.',
    });
  }

  if (attrs['id'] && isGeneratedId(attrs['id'])) {
    out.push({
      kind: 'stableId',
      snippet: `id="${testId}" (replacing the generated id "${attrs['id']}")`,
      idealLocator: `page.locator('#${testId}')`,
      reason: 'The current id looks machine-generated, so it can change between builds.',
    });
  }
  return out;
}

/**
 * What to change in the application so this element gets a reliable locator,
 * or null when its best locator is already trustworthy.
 */
export function suggestImprovements(a: ElementAnalysis, threshold = WEAK_SCORE): LocatorSuggestion | null {
  const problem = weakReason(a.recommended, threshold);
  if (!problem) return null;
  return {
    score: a.recommended.score,
    problem: a.recommended.scoreReason ? `${problem}. ${a.recommended.scoreReason}` : problem,
    improvements: improvementsFor(a, suggestedTestId(a.element)),
  };
}

function describeElement(el: DiscoveredElement): string {
  const label = (el.text || el.attributes['aria-label'] || el.attributes['placeholder'] || el.attributes['name'] || '').trim();
  return `${code(`<${el.tag}>`)}${label ? ` "${clip(label, 40)}"` : ''}`;
}

function describeLocation(el: DiscoveredElement): string {
  const parts: string[] = [];
  if (el.shadowDepth > 0) {
    const hosts = el.shadowHostChain.slice(-3).map((h) => `<${h}>`).join(' › ');
    parts.push(`inside Shadow DOM, depth ${el.shadowDepth} (…${hosts})`);
  }
  if (el.framePath?.length) parts.push(`inside iframe ${code(el.framePath.join(' › '))}`);
  return parts.join('; ');
}

function currentLocatorLine(rec: LocatorResult): string {
  const matches = rec.matchCount === undefined ? 'not checked' : `${rec.matchCount} match${rec.matchCount === 1 ? '' : 'es'}`;
  return `${code(clip(rec.value, 110))} (score ${rec.score}, ${matches})`;
}

/** A short note for one element that a developer can act on, or '' when its locator is fine. */
export function developerNote(a: ElementAnalysis, ctx: NoteContext = {}, threshold = WEAK_SCORE): string {
  const s = suggestImprovements(a, threshold);
  if (!s || s.improvements.length === 0) return '';
  const where = describeLocation(a.element);
  const lines = [
    '**Locator improvement request**',
    ...(ctx.pageUrl ? [`- Page: ${ctx.pageTitle ? `${ctx.pageTitle} — ` : ''}${ctx.pageUrl}`] : []),
    `- Element: ${describeElement(a.element)}${where ? `, ${where}` : ''}`,
    `- Best locator today: ${currentLocatorLine(a.recommended)}`,
    `- Problem: ${s.problem}`,
    '- Please add:',
    ...s.improvements.map((i) => `  - ${code(i.snippet)}. ${i.reason}`),
    `- Tests could then use: ${code(s.improvements[0].idealLocator)}`,
  ];
  return lines.join('\n');
}

export interface DeveloperReport {
  markdown: string;
  /** Elements with a weak best locator that have a suggestion */
  weak: number;
  total: number;
}

/**
 * A Markdown report of every element whose best locator is weak, worst first,
 * with what to add to each. Suggested test ids are made unique across the page.
 */
export function developerReport(
  analysis: PageAnalysis,
  opts: { threshold?: number; max?: number } = {},
): DeveloperReport {
  const threshold = opts.threshold ?? WEAK_SCORE;
  const max = opts.max ?? 100;

  const weak = analysis.elements
    .filter((a) => weakReason(a.recommended, threshold))
    .sort((x, y) => x.recommended.score - y.recommended.score);

  const used = new Set(
    analysis.elements.map((a) => a.element.attributes['data-testid']).filter((v): v is string => Boolean(v)),
  );
  const entries: { a: ElementAnalysis; items: Improvement[]; problem: string }[] = [];
  for (const a of weak) {
    let name = suggestedTestId(a.element);
    for (let n = 2; used.has(name); n++) name = `${suggestedTestId(a.element)}-${n}`;
    const items = improvementsFor(a, name);
    if (items.length === 0) continue;
    if (items.some((i) => i.kind === 'testId')) used.add(name);
    entries.push({ a, items, problem: weakReason(a.recommended, threshold) });
  }

  const count = (kind: ImprovementKind) => entries.filter((e) => e.items.some((i) => i.kind === kind)).length;
  const shown = entries.slice(0, max);
  const title = analysis.pageTitle || analysis.source;
  const md: string[] = [
    `# Locator improvement request: ${title}`,
    '',
    `- Page: ${analysis.source}`,
    `- Analyzed: ${analysis.timestamp}`,
    `- Result: **${entries.length} of ${analysis.elements.length}** analyzed elements have no reliable locator (score below ${threshold}, or not unique).`,
    '',
    'Automated tests find elements by stable attributes. Where the page offers none, the test tool falls back to long structural paths or visible text, which break when the layout or wording changes. Adding the attributes below gives each element a short, stable locator.',
    '',
    '## Summary',
    '',
    `- ${count('testId')} elements need a \`data-testid\``,
    `- ${count('accessibleName')} controls need an accessible name (\`aria-label\` or visible label)`,
    `- ${count('stableId')} have a generated id that should be replaced`,
    `- ${count('rowKey')} repeated items need a stable key on their row or card`,
    '',
    'The suggested values are starting points. Use your team’s naming convention, and keep each `data-testid` unique on the page.',
    '',
    '## Elements',
  ];
  shown.forEach(({ a, items, problem }, i) => {
    const where = describeLocation(a.element);
    md.push(
      '',
      `### ${i + 1}. ${describeElement(a.element)}`,
      ...(where ? [`- Where: ${where}`] : []),
      `- Best locator today: ${currentLocatorLine(a.recommended)} — ${problem}`,
      '- Please add:',
      ...items.map((it) => `  - ${code(it.snippet)}`),
      `- Tests could then use: ${code(items[0].idealLocator)}`,
    );
  });
  if (entries.length > shown.length) {
    md.push('', `…and ${entries.length - shown.length} more (lowest scores are listed first).`);
  }
  return { markdown: `${md.join('\n')}\n`, weak: entries.length, total: analysis.elements.length };
}
