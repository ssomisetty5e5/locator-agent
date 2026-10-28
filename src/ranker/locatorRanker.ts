// ============================================================
// Locator Ranker
// Scores and ranks locators based on robustness heuristics.
// ============================================================

import { LocatorResult, DiscoveredElement, LocatorStrategy } from '../types';
import { findUnstableTokens } from '../util/stability';

/**
 * Base scores per strategy (higher = more robust & stable).
 */
const STRATEGY_BASE_SCORES: Record<LocatorStrategy, number> = {
  testId: 95,
  ariaRole: 90,
  ariaLabel: 85,
  text: 70,
  id: 80,
  css: 55,
  shadowPiercingCss: 50,
  xpath: 40,
  scoped: 78,
  name: 65,
  placeholder: 75,
};

export class LocatorRanker {
  /**
   * Score and sort locators for an element. Returns them sorted by
   * descending score. Each locator's score and scoreReason are filled in.
   */
  rank(locators: LocatorResult[], element: DiscoveredElement): LocatorResult[] {
    const scored = locators.map((loc) => this.scoreLocator(loc, element));
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Get the single best locator from a list.
   */
  getBest(locators: LocatorResult[]): LocatorResult {
    if (locators.length === 0) {
      throw new Error('No locators to rank');
    }
    return locators[0]; // Already sorted by rank()
  }

  private scoreLocator(locator: LocatorResult, element: DiscoveredElement): LocatorResult {
    let score = STRATEGY_BASE_SCORES[locator.strategy] ?? 30;
    const reasons: string[] = [`base(${locator.strategy}): ${score}`];

    // --- Bonuses ---

    // Bonus for semantic selectors
    if (locator.strategy === 'testId') {
      score += 5;
      reasons.push('+5 dedicated test attribute');
    }

    // Bonus for short, readable locators
    if (locator.value.length < 40) {
      score += 3;
      reasons.push('+3 short & readable');
    }

    // Bonus for Playwright-native locators
    if (locator.framework === 'playwright' && locator.value.startsWith('getBy')) {
      score += 3;
      reasons.push('+3 Playwright semantic API');
    }

    // Bonus for WebdriverIO semantic selectors (aria/name or text match)
    if (locator.framework === 'webdriverio' && /^\$\((['"])(aria\/|=|\*=)/.test(locator.value)) {
      score += 3;
      reasons.push('+3 WebdriverIO semantic selector');
    }

    // Bonus for JavaScript shadow-piercing (works in DevTools + Selenium)
    if (locator.framework === 'javascript' && locator.strategy === 'shadowPiercingCss') {
      score += 5;
      reasons.push('+5 JS shadow-pierce (DevTools compatible)');
    }

    // Bonus for short shadow-piercing chains (fewer host levels = more robust)
    if (locator.strategy === 'shadowPiercingCss') {
      let chainLevels = 0;
      if (locator.framework === 'playwright' && locator.value.includes(' >> ')) {
        chainLevels = locator.value.split(' >> ').length;
      } else if (locator.framework === 'javascript' && locator.value.includes('.shadowRoot.querySelector')) {
        chainLevels = (locator.value.match(/\.shadowRoot\.querySelector/g) || []).length + 1;
      } else if (locator.framework === 'css' && locator.value.includes(' >>> ')) {
        chainLevels = locator.value.split(' >>> ').length;
      } else if (locator.framework === 'webdriverio' && locator.value.includes(' >>> ')) {
        chainLevels = locator.value.split(' >>> ').length;
      }
      if (chainLevels > 0 && chainLevels <= 2) {
        score += 15;
        reasons.push(`+15 minimal shadow chain (${chainLevels} levels)`);
      } else if (chainLevels > 0 && chainLevels <= 4) {
        const bonus = (5 - chainLevels) * 5; // 3 levels=+10, 4 levels=+5
        score += bonus;
        reasons.push(`+${bonus} short shadow chain (${chainLevels} levels)`);
      } else if (chainLevels > 6) {
        const penalty = Math.min(20, (chainLevels - 5) * 4);
        score -= penalty;
        reasons.push(`-${penalty} deep shadow chain (${chainLevels} levels)`);
      }
    }

    // --- Penalties ---

    // Penalty for long selectors
    if (locator.value.length > 100) {
      const penalty = Math.min(20, Math.floor((locator.value.length - 100) / 10));
      score -= penalty;
      reasons.push(`-${penalty} long selector (${locator.value.length} chars)`);
    }

    // Penalty for positional/index-based selectors
    if (locator.value.includes('nth-of-type') || locator.value.includes('nth-child')) {
      score -= 10;
      reasons.push('-10 positional selector');
    }
    if (/\[\d+\]/.test(locator.value) && locator.strategy === 'xpath') {
      score -= 8;
      reasons.push('-8 XPath positional index');
    }

    // Penalty for deep nesting (CSS child combinator `>`, but NOT Playwright `>>`)
    const selectorForNesting = locator.value.replace(/>>/g, ''); // strip PW >> before counting
    const depth = (selectorForNesting.match(/\s*>\s*/g) || []).length;
    if (depth > 3) {
      const penalty = Math.min(15, (depth - 3) * 3);
      score -= penalty;
      reasons.push(`-${penalty} deep nesting (${depth} levels)`);
    }

    // Penalty for shadow DOM depth
    if (element.shadowDepth > 0 && locator.strategy !== 'shadowPiercingCss') {
      // Non-shadow-piercing selectors need extra consideration in shadow DOM
      score -= 5;
      reasons.push('-5 inside Shadow DOM without piercing');
    }

    // Penalty for generic tag-only selectors
    if (/^(div|span|p|section|article)$/.test(locator.value)) {
      score -= 30;
      reasons.push('-30 too generic (tag only)');
    }

    // Penalty for XPath starting with absolute path
    if (locator.strategy === 'xpath' && locator.value.startsWith('/html')) {
      score -= 20;
      reasons.push('-20 absolute XPath');
    }

    // ── Uniqueness (populated by LocatorValidator, if run) ───
    if (locator.matchCount !== undefined) {
      if (locator.matchCount === 1) {
        // Unique — strong bonus
        score += 20;
        reasons.push('+20 unique (1 match)');
      } else if (locator.matchCount === 0) {
        // Matches nothing — severe penalty
        score -= 50;
        reasons.push(`-50 matches 0 elements`);
      } else {
        // Multiple matches — heavy penalty (non-unique locators are unreliable)
        const penalty = Math.min(45, 25 + Math.floor(Math.log2(locator.matchCount) * 5));
        score -= penalty;
        reasons.push(`-${penalty} not unique (${locator.matchCount} matches)`);
      }
    } else {
      // Could not validate uniqueness — mild penalty (prefer validated locators)
      score -= 5;
      reasons.push('-5 uniqueness unverified');
    }

    // ── Identity: does it find *this* element? ───
    if (locator.resolvesToTarget === false && (locator.matchCount ?? 0) > 0) {
      score -= 40;
      reasons.push('-40 matches a different element than the target');
    }

    // ── Stability: ids/classes that look auto-generated ───
    // Skip aria/text-style locators: their value is a label, not a selector.
    if (!/^getBy/.test(locator.value) && locator.strategy !== 'scoped') {
      const unstable = findUnstableTokens(locator.value);
      if (unstable.length > 0) {
        const penalty = Math.min(30, 15 * unstable.length);
        score -= penalty;
        reasons.push(`-${penalty} unstable: ${unstable.slice(0, 2).join(', ')}`);
      }
    }

    // Clamp between 0 and 100
    score = Math.max(0, Math.min(100, score));

    return {
      ...locator,
      score,
      scoreReason: reasons.join('; '),
    };
  }
}
