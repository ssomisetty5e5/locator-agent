// ============================================================
// Element Namer
// Turns discovered elements into readable, unique, valid
// property names: "Log In" button -> logInButton,
// input[name=email] -> emailInput.
// ============================================================

import { ElementAnalysis, DiscoveredElement } from '../types';
import { isGeneratedId } from '../util/stability';

const MAX_WORDS = 4;

/** Names that would collide with page-object members or JS keywords. */
const RESERVED = new Set([
  'page', 'goto', 'constructor', 'prototype', 'locator', 'class', 'default', 'delete', 'new',
  'function', 'return', 'var', 'let', 'const', 'import', 'export', 'if', 'else', 'for', 'while',
  'switch', 'case', 'this', 'super', 'null', 'true', 'false', 'in', 'of', 'typeof', 'void',
]);

/**
 * Words describing what kind of control this is (used as the name suffix).
 */
export function elementKind(el: DiscoveredElement): string {
  const type = (el.attributes['type'] || '').toLowerCase();
  const role = (el.ariaRole || el.attributes['role'] || '').toLowerCase();

  if (el.tag === 'button' || role === 'button' || (el.tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type))) {
    return 'Button';
  }
  if (el.tag === 'a' || role === 'link') return 'Link';
  if (el.tag === 'select' || role === 'combobox' || role === 'listbox') return 'Select';
  if (el.tag === 'textarea') return 'TextArea';
  if (el.tag === 'input') {
    if (type === 'checkbox' || role === 'checkbox' || role === 'switch') return 'Checkbox';
    if (type === 'radio' || role === 'radio') return 'Radio';
    return 'Input';
  }
  if (role === 'tab') return 'Tab';
  if (role === 'menuitem') return 'MenuItem';
  if (role === 'textbox' || role === 'searchbox') return 'Input';
  if (el.tag === 'label') return 'Label';
  if (el.tag === 'option' || role === 'option') return 'Option';
  if (el.tag === 'summary' || el.tag === 'details') return 'Toggle';
  return 'Element';
}

/** Best human label for the element, or '' when nothing readable exists. */
function labelFor(el: DiscoveredElement): string {
  const a = el.attributes;
  const id = a['id'] && !isGeneratedId(a['id']) ? a['id'] : '';
  const href = a['href'] && !a['href'].startsWith('javascript:') && a['href'] !== '#'
    ? (a['href'].split(/[?#]/)[0].split('/').filter(Boolean).pop() || '')
    : '';

  const candidates = [
    a['aria-label'],
    el.text && el.text.length <= 40 ? el.text : '',
    a['placeholder'],
    a['data-testid'],
    a['name'],
    id,
    a['title'],
    a['value'],
    href,
    a['alt'],
  ];
  return candidates.find((c) => c && c.trim().length > 0)?.trim() ?? '';
}

/** Split into lowercase alphanumeric words, breaking on camelCase and punctuation. */
export function toWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

export function toCamel(words: string[]): string {
  return words.map((w, i) => (i === 0 ? w : cap(w))).join('');
}

export function toPascal(words: string[]): string {
  return words.map(cap).join('');
}

/** Base (not yet de-duplicated) property name for an element. */
export function baseName(el: DiscoveredElement): string {
  const kind = elementKind(el);
  const kindWord = kind === 'Element' ? [] : toWords(kind.replace(/([a-z])([A-Z])/g, '$1 $2'));
  let words = toWords(labelFor(el)).slice(0, MAX_WORDS);

  // "submit-button" + Button -> don't repeat the kind
  const last = words[words.length - 1];
  if (kindWord.length > 0 && last === kindWord[kindWord.length - 1]) {
    words = words.slice(0, -1);
    if (words.length === 0) words = [];
  }

  let name = toCamel([...words, ...kindWord]);
  if (!name) name = kindWord.length > 0 ? toCamel(kindWord) : el.tag.replace(/[^a-z0-9]/gi, '') || 'element';
  if (/^\d/.test(name)) name = `${kind === 'Element' ? 'element' : kind.toLowerCase()}${cap(name)}`;
  if (RESERVED.has(name)) name = `${name}${kind}`;
  return name;
}

/**
 * Assign a unique valid identifier to every element, in order.
 * Duplicates are told apart by the text of their scope ("deleteButtonInvoice1002")
 * when they have one, otherwise by a numeric suffix.
 */
export function nameElements(analyses: ElementAnalysis[]): string[] {
  const bases = analyses.map((a) => baseName(a.element));
  const counts = new Map<string, number>();
  for (const b of bases) counts.set(b, (counts.get(b) ?? 0) + 1);

  const used = new Set<string>();
  const seenIndex = new Map<string, number>();

  return analyses.map((analysis, i) => {
    const base = bases[i];
    let name = base;

    if ((counts.get(base) ?? 0) > 1) {
      const scopeText = analysis.recommended.scope?.hasText;
      const scopeWords = scopeText ? toWords(scopeText).slice(0, 3) : [];
      if (scopeWords.length > 0) {
        name = base + toPascal(scopeWords);
      } else {
        const n = (seenIndex.get(base) ?? 0) + 1;
        seenIndex.set(base, n);
        name = `${base}${n}`;
      }
    }

    let unique = name;
    let suffix = 2;
    while (used.has(unique) || RESERVED.has(unique)) unique = `${name}${suffix++}`;
    used.add(unique);
    return unique;
  });
}
