// ============================================================
// Frame helpers
// Render a frame-relative locator together with the iframe chain
// it lives in, so it can be pasted straight into a test.
// ============================================================

import { LocatorResult } from '../types';

/**
 * Playwright expression prefix for a frame path, e.g.
 * `frameLocator('iframe#a').frameLocator('iframe[name="b"]')`.
 */
export function playwrightFramePrefix(framePath: string[]): string {
  return framePath
    .map((sel) => `frameLocator(${JSON.stringify(sel)})`)
    .join('.');
}

/**
 * Return a human-ready locator expression including its frame chain.
 * Locators outside any iframe are returned unchanged.
 *
 * Playwright locators become `page.frameLocator('…').getByRole(…)`;
 * for other frameworks the frame chain is shown as a leading comment,
 * since each framework switches frames differently.
 */
export function formatWithFrames(loc: LocatorResult): string {
  const path = loc.framePath;
  if (!path || path.length === 0) return loc.value;

  if (loc.framework === 'playwright') {
    const rest = loc.value.startsWith('getBy') ? loc.value : `locator(${JSON.stringify(loc.value)})`;
    return `page.${playwrightFramePrefix(path)}.${rest}`;
  }
  return `/* in iframe: ${path.join(' > ')} */ ${loc.value}`;
}
