// ============================================================
// Frame selector
// Build a stable selector for an <iframe> element as seen from its
// parent frame, preferring id / name / title / src over position.
// ============================================================

import { Frame } from 'playwright';
import { isGeneratedId } from '../util/stability';
import { escapeCssAttr } from '../util/stability';

interface FrameElementInfo {
  tag: string;
  id: string;
  name: string;
  title: string;
  src: string;
  index: number;
}

/**
 * Selector (relative to `parent`) that identifies `child`'s iframe element.
 * Falls back to a positional `nth=` selector when no attribute is unique.
 */
export async function buildFrameSelector(parent: Frame, child: Frame): Promise<string> {
  const handle = await child.frameElement();
  try {
    const info = await handle.evaluate((el: any): FrameElementInfo => {
      const doc = el.ownerDocument;
      const tag = el.tagName.toLowerCase();
      return {
        tag,
        id: el.getAttribute('id') || '',
        name: el.getAttribute('name') || '',
        title: el.getAttribute('title') || '',
        src: el.getAttribute('src') || '',
        index: Array.from(doc.querySelectorAll(tag)).indexOf(el),
      };
    });

    const candidates: string[] = [];
    if (info.id && !isGeneratedId(info.id)) candidates.push(`${info.tag}#${info.id.replace(/([^\w-])/g, '\\$1')}`);
    if (info.name) candidates.push(`${info.tag}[name="${escapeCssAttr(info.name)}"]`);
    if (info.title) candidates.push(`${info.tag}[title="${escapeCssAttr(info.title)}"]`);
    if (info.src && !info.src.startsWith('about:') && !info.src.startsWith('data:') && info.src.length < 120) {
      // Drop the query string — it commonly carries session tokens
      const stable = info.src.split('?')[0].split('#')[0];
      if (stable) candidates.push(`${info.tag}[src*="${escapeCssAttr(stable)}"]`);
    }

    for (const sel of candidates) {
      try {
        if ((await parent.locator(sel).count()) === 1) return sel;
      } catch {
        // invalid selector — try the next candidate
      }
    }

    return `${info.tag} >> nth=${Math.max(0, info.index)}`;
  } finally {
    await handle.dispose();
  }
}
