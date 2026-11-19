// ============================================================
// CI gate: flag elements whose best locator is not trustworthy enough
// ============================================================

import { LocatorResult, PageAnalysis } from '../types';

export interface WeakElement {
  /** 1-based position in the analysis */
  index: number;
  tag: string;
  text: string;
  locator: string;
  score: number;
  reason: string;
}

/**
 * Why a recommended locator can't be trusted, or '' when it can: it scores below
 * `threshold`, or was proven not to find exactly the target element (no match,
 * several matches, or the wrong one).
 */
export function weakReason(rec: LocatorResult, threshold: number): string {
  if (rec.score < threshold) return `score ${rec.score} is below ${threshold}`;
  if (rec.matchCount !== undefined && rec.matchCount !== 1) {
    return rec.matchCount === 0 ? 'matches nothing' : `matches ${rec.matchCount} elements`;
  }
  if (rec.resolvesToTarget === false) return 'matches a different element';
  return '';
}

/** Elements whose recommended locator is weak by `weakReason`. */
export function findWeakElements(analysis: PageAnalysis, threshold: number): WeakElement[] {
  const weak: WeakElement[] = [];
  analysis.elements.forEach((a, i) => {
    const rec = a.recommended;
    const reason = weakReason(rec, threshold);
    if (reason) {
      weak.push({
        index: i + 1,
        tag: a.element.tag,
        text: (a.element.text || '').slice(0, 40),
        locator: rec.value,
        score: rec.score,
        reason,
      });
    }
  });
  return weak;
}
