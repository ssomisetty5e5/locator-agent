// ============================================================
// Ancestor Probe
// Page-side script that describes the ancestors of an already-traversed
// element (looked up via window.__laNodes), so a scoped locator can be
// built when the element's own attributes aren't unique.
// Run lazily, only for elements that need it.
// ============================================================

import { AncestorInfo } from '../types';

const MAX_LEVELS = 6;
const MAX_TEXT_NODES = 200;

/**
 * Script (string, evaluated in the element's frame) returning AncestorInfo[]
 * from the nearest ancestor outward. Stops at the shadow-root / document edge.
 */
export function getAncestorProbeScript(nodeIndex: number): string {
  return `(() => {
    const target = window.__laNodes && window.__laNodes[${nodeIndex}];
    if (!target) return [];
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const out = [];
    let el = target.parentElement;
    let levels = 0;
    while (el && levels < ${MAX_LEVELS} && el !== document.body && el !== document.documentElement) {
      levels++;
      const texts = [];
      const seen = new Set();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      let visited = 0;
      while ((node = walker.nextNode()) && texts.length < 6 && visited++ < ${MAX_TEXT_NODES}) {
        if (target.contains(node)) continue;
        const pt = node.parentElement ? node.parentElement.tagName : '';
        if (pt === 'SCRIPT' || pt === 'STYLE') continue;
        const t = norm(node.textContent);
        if (t.length < 2 || t.length > 50 || seen.has(t)) continue;
        seen.add(t);
        texts.push(t);
      }
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute('id') || '',
        testId: el.getAttribute('data-testid') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        role: el.getAttribute('role') || '',
        texts,
      });
      el = el.parentElement;
    }
    return out;
  })()`;
}

export function parseAncestors(raw: unknown): AncestorInfo[] {
  return Array.isArray(raw) ? (raw as AncestorInfo[]) : [];
}
