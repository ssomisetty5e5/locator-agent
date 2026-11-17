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
 * from the nearest ancestor outward. Climbs out of open shadow roots through
 * their hosts (so a component's tag can scope its inner elements), and reads
 * each ancestor's text across shadow boundaries, as Playwright's text matching does.
 */
export function getAncestorProbeScript(nodeIndex: number): string {
  return `(() => {
    const target = window.__laNodes && window.__laNodes[${nodeIndex}];
    if (!target) return [];
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const parentOf = (n) => {
      if (n.parentElement) return n.parentElement;
      const root = n.getRootNode && n.getRootNode();
      return root && root.host ? root.host : null;
    };
    const out = [];
    let el = parentOf(target);
    let levels = 0;
    while (el && levels < ${MAX_LEVELS} && el !== document.body && el !== document.documentElement) {
      levels++;
      const texts = [];
      const seen = new Set();
      let visited = 0;
      // depth-first over light children and shadow content, skipping the target itself
      const stack = [el];
      while (stack.length > 0 && texts.length < 6 && visited < ${MAX_TEXT_NODES}) {
        const node = stack.pop();
        if (node === target) continue;
        if (node.nodeType === 3) {
          visited++;
          const pt = node.parentElement ? node.parentElement.tagName : '';
          if (pt === 'SCRIPT' || pt === 'STYLE') continue;
          const t = norm(node.textContent);
          if (t.length < 2 || t.length > 50 || seen.has(t)) continue;
          seen.add(t);
          texts.push(t);
          continue;
        }
        if (node.nodeType !== 1 && node.nodeType !== 11) continue;
        const kids = Array.from(node.childNodes);
        // pushed in reverse so they are visited in document order; shadow content first
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        if (node.shadowRoot) stack.push(node.shadowRoot);
      }
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute('id') || '',
        testId: el.getAttribute('data-testid') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        role: el.getAttribute('role') || '',
        texts,
      });
      el = parentOf(el);
    }
    return out;
  })()`;
}

export function parseAncestors(raw: unknown): AncestorInfo[] {
  return Array.isArray(raw) ? (raw as AncestorInfo[]) : [];
}
