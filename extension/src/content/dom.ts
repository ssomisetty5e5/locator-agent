// Small DOM helpers for the panel. All page-derived text goes through
// textContent, never innerHTML, so a hostile page can't inject markup.

type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;

/** Create an element: `h('button', { class: 'btn', onclick: fn }, 'Label')`. */
export function h(tag: string, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2), value);
    else if (value === true) el.setAttribute(name, '');
    else if (typeof value === 'string') el.setAttribute(name, value);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Copy text to the clipboard; falls back to execCommand where the async API is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.documentElement.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    area.remove();
    return ok;
  }
}

/** Download text as a file. */
export function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = h('a', { href: url, download: filename }) as HTMLAnchorElement;
  document.documentElement.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** An element's rectangle in top-window coordinates, adding the offsets of any same-origin iframes around it. */
export function rectInTop(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  let x = r.left;
  let y = r.top;
  try {
    for (let w: Window | null = el.ownerDocument.defaultView; w && w !== w.parent; w = w.parent) {
      const frame = w.frameElement;
      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      x += fr.left + frame.clientLeft;
      y += fr.top + frame.clientTop;
    }
  } catch {
    // cross-origin parent: leave the offset as is
  }
  return { x, y, w: r.width, h: r.height };
}
