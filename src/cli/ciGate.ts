// ============================================================
// CI gate: flag elements whose best locator is not trustworthy enough
// ============================================================

import { PageAnalysis } from '../types';

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
 * Elements whose recommended locator scores below `threshold`, or was proven
 * not to find exactly the target element (no match, several matches, or the wrong one).
 */
export function findWeakElements(analysis: PageAnalysis, threshold: number): WeakElement[] {
  const weak: WeakElement[] = [];
  analysis.elements.forEach((a, i) => {
    const rec = a.recommended;
    let reason = '';
    if (rec.score < threshold) {
      reason = `score ${rec.score} is below ${threshold}`;
    } else if (rec.matchCount !== undefined && rec.matchCount !== 1) {
      reason = rec.matchCount === 0 ? 'matches nothing' : `matches ${rec.matchCount} elements`;
    } else if (rec.resolvesToTarget === false) {
      reason = 'matches a different element';
    }
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
