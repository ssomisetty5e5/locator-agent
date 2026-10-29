// ============================================================
// Tests: CI gate and package manifest
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { findWeakElements } from '../src/cli/ciGate';
import { DiscoveredElement, ElementAnalysis, LocatorResult, PageAnalysis } from '../src/types';

const el = (tag: string, text = ''): DiscoveredElement => ({
  uid: 'u', tag, text, attributes: {}, shadowDepth: 0, shadowHostChain: [], shadowHost: null, ariaRole: null,
  cssPathSegments: [], isInteractive: true, boundingBox: null, htmlSnippet: '', childCount: 0, nthOfType: 1, siblingsOfSameType: 1,
});
const loc = (over: Partial<LocatorResult>): LocatorResult => ({
  strategy: 'id', value: '#x', framework: 'css', score: 90, scoreReason: '', matchCount: 1, isUnique: true, resolvesToTarget: true, ...over,
});
const ea = (tag: string, l: LocatorResult): ElementAnalysis => ({ element: el(tag, 'Go'), locators: [l], recommended: l });
const analysis = (elements: ElementAnalysis[]): PageAnalysis => ({
  source: 's', timestamp: '', pageTitle: '', totalDomElements: 0, interactiveElementsFound: elements.length, shadowRootsPierced: 0, elements,
});

describe('findWeakElements', () => {
  it('passes elements with a strong, unique, correct locator', () => {
    expect(findWeakElements(analysis([ea('button', loc({}))]), 80)).toEqual([]);
  });

  it('flags low scores, ambiguous, missing and wrong-element locators', () => {
    const weak = findWeakElements(
      analysis([
        ea('a', loc({ score: 50 })),
        ea('b', loc({ matchCount: 3 })),
        ea('c', loc({ matchCount: 0 })),
        ea('d', loc({ resolvesToTarget: false })),
        ea('e', loc({})),
      ]),
      80,
    );
    expect(weak.map((w) => [w.index, w.reason])).toEqual([
      [1, 'score 50 is below 80'],
      [2, 'matches 3 elements'],
      [3, 'matches nothing'],
      [4, 'matches a different element'],
    ]);
  });

  it('treats a locator that was never validated as acceptable when the score is high enough', () => {
    expect(findWeakElements(analysis([ea('a', loc({ matchCount: undefined, resolvesToTarget: undefined }))]), 80)).toEqual([]);
  });
});

describe('package manifest', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

  it('points bin, main and types at files the build produces', () => {
    const srcFor = (p: string) => path.join(__dirname, '..', p.replace(/^dist\//, 'src/').replace(/\.(d\.ts|js)$/, '.ts'));
    for (const p of [pkg.main, pkg.types, pkg.bin['locator-agent']]) {
      expect(fs.existsSync(srcFor(p)), p).toBe(true);
    }
    // main must be the library, not the CLI (requiring the CLI would parse argv)
    expect(pkg.main).not.toContain('cli');
  });

  it('publishes only built output, the UI assets and the README', () => {
    expect(pkg.files).toEqual(['dist', '!dist/**/*.map', 'public', 'README.md']);
  });
});
