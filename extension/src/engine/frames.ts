// ============================================================
// Iframe paths for the extension: the chain of iframe selectors that
// leads from the top document to a same-origin frame, outermost first.
// Mirrors src/loader/frameSelector.ts (id, name, title, src, then position)
// so page objects built from the extension match the Playwright ones.
// ============================================================

import { escapeCssAttr, isGeneratedId } from '../../../src/util/stability';

/** Selector (relative to its parent document) that identifies this iframe element. */
function selectorFor(frame: Element): string {
  const doc = frame.ownerDocument;
  const tag = frame.tagName.toLowerCase();
  const id = frame.getAttribute('id') || '';
  const name = frame.getAttribute('name') || '';
  const title = frame.getAttribute('title') || '';
  const src = frame.getAttribute('src') || '';

  const candidates: string[] = [];
  if (id && !isGeneratedId(id)) candidates.push(`${tag}#${id.replace(/([^\w-])/g, '\\$1')}`);
  if (name) candidates.push(`${tag}[name="${escapeCssAttr(name)}"]`);
  if (title) candidates.push(`${tag}[title="${escapeCssAttr(title)}"]`);
  if (src && !src.startsWith('about:') && !src.startsWith('data:') && src.length < 120) {
    // Drop the query string: it commonly carries session tokens
    const stable = src.split('?')[0].split('#')[0];
    if (stable) candidates.push(`${tag}[src*="${escapeCssAttr(stable)}"]`);
  }

  for (const sel of candidates) {
    try {
      if (doc.querySelectorAll(sel).length === 1) return sel;
    } catch {
      // invalid selector: try the next candidate
    }
  }
  const index = Array.from(doc.querySelectorAll(tag)).indexOf(frame);
  return `${tag} >> nth=${Math.max(0, index)}`;
}

/** Selectors of the iframes containing `win`, outermost first; empty for the top window. */
export function frameSelectorFor(win: Window): string[] {
  const path: string[] = [];
  try {
    for (let w: Window = win; w !== w.parent; w = w.parent) {
      const frame = w.frameElement;
      if (!frame) break; // cross-origin parent: can't describe the rest
      path.unshift(selectorFor(frame));
    }
  } catch {
    // reading a cross-origin frame element throws; keep what we have
  }
  return path;
}
