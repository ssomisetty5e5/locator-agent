// ============================================================
// Tests: stability heuristics + ranker stability/identity penalties
// ============================================================

import { describe, it, expect } from 'vitest';
import { isGeneratedId, isGeneratedClass, escapeCssAttr, findUnstableTokens } from '../src/util/stability';
import { LocatorRanker } from '../src/ranker';
import { DiscoveredElement, LocatorResult } from '../src/types';

describe('isGeneratedId', () => {
  it.each([
    ':r0:', ':r1a:', 'ember123', 'ng-5', 'react-select-2-input', 'mat-input-4', 'cdk-overlay-12',
    'a1b2c3d4e5f6', '123456', 'radix-:r3:', 'input_4821',
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  ])('flags %s as generated', (id) => {
    expect(isGeneratedId(id)).toBe(true);
  });

  it.each(['login-btn', 'email', 'submit', 'user-form', 'step2', 'h1', 'main-nav'])(
    'keeps %s as stable',
    (id) => {
      expect(isGeneratedId(id)).toBe(false);
    },
  );
});

describe('isGeneratedClass', () => {
  it.each(['css-1x2y3z', 'sc-abcdef', '_a1b2c3', 'ng-tns-c12-4', 'Button_primary__x7Gh2', 'ab12cdef'])(
    'flags %s as generated',
    (c) => {
      expect(isGeneratedClass(c)).toBe(true);
    },
  );

  it.each(['btn', 'primary', 'form-control', 'nav-item', 'is-active'])('keeps %s as stable', (c) => {
    expect(isGeneratedClass(c)).toBe(false);
  });
});

describe('escapeCssAttr', () => {
  it('escapes quotes and backslashes so the selector stays valid', () => {
    expect(escapeCssAttr('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeCssAttr('a\\b')).toBe('a\\\\b');
  });
});

describe('findUnstableTokens', () => {
  it('finds generated ids in css and xpath', () => {
    expect(findUnstableTokens('#mat-input-4')).toHaveLength(1);
    expect(findUnstableTokens('[id="ember123"]')).toHaveLength(1);
    expect(findUnstableTokens("//*[@id='ng-5']")).toHaveLength(1);
  });

  it('finds generated classes', () => {
    expect(findUnstableTokens('button.css-1x2y3z')).toHaveLength(1);
  });

  it('ignores stable selectors', () => {
    expect(findUnstableTokens('#login-btn')).toHaveLength(0);
    expect(findUnstableTokens('button.btn.primary')).toHaveLength(0);
    expect(findUnstableTokens('input[name="user.name"]')).toHaveLength(0);
  });
});

describe('LocatorRanker stability and identity', () => {
  const ranker = new LocatorRanker();
  const element = {
    uid: 'u1', tag: 'button', text: 'Save', attributes: {}, shadowDepth: 0, shadowHostChain: [],
    shadowHost: null, ariaRole: 'button', cssPathSegments: [], isInteractive: true, boundingBox: null,
    htmlSnippet: '', childCount: 0, nthOfType: 1, siblingsOfSameType: 1,
  } as DiscoveredElement;

  const loc = (value: string, extra: Partial<LocatorResult> = {}): LocatorResult => ({
    strategy: 'css', value, framework: 'css', score: 0, scoreReason: '', matchCount: 1, isUnique: true, ...extra,
  });

  it('ranks a stable selector above one built on a generated id', () => {
    const [best] = ranker.rank([loc('#mat-input-4'), loc('#save-btn')], element);
    expect(best.value).toBe('#save-btn');
  });

  it('penalizes a locator that matches a different element than the target', () => {
    const wrong = loc('#other', { resolvesToTarget: false });
    const right = loc('#save', { resolvesToTarget: true });
    const [best, worst] = ranker.rank([wrong, right], element);
    expect(best.value).toBe('#save');
    expect(worst.scoreReason).toContain('different element');
  });
});
