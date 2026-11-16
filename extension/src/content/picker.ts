// ============================================================
// Element picker
// Hover to highlight, click to choose. Listens in the capture phase on
// the page and on every same-origin iframe, and swallows the click so the
// page doesn't react to it. Open shadow roots are handled through
// composedPath(), which reports the real element under the pointer.
// ============================================================

import { QueryContext } from '../engine/domQueries';

export interface PickerHandlers {
  /** Elements belonging to the panel itself are never picked. */
  isOwn(target: EventTarget): boolean;
  onHover(el: Element | null): void;
  onPick(el: Element): void;
  onStop(): void;
}

const BLOCKED_EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu'];

export class Picker {
  private docs: Document[] = [];
  private active = false;

  constructor(private handlers: PickerHandlers) {}

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.docs = sameOriginDocuments(document);
    for (const doc of this.docs) {
      doc.addEventListener('mousemove', this.onMove, true);
      doc.addEventListener('click', this.onClick, true);
      doc.addEventListener('keydown', this.onKey, true);
      for (const type of BLOCKED_EVENTS) doc.addEventListener(type, this.block, true);
      doc.documentElement.style.cursor = 'crosshair';
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const doc of this.docs) {
      doc.removeEventListener('mousemove', this.onMove, true);
      doc.removeEventListener('click', this.onClick, true);
      doc.removeEventListener('keydown', this.onKey, true);
      for (const type of BLOCKED_EVENTS) doc.removeEventListener(type, this.block, true);
      doc.documentElement.style.cursor = '';
    }
    this.docs = [];
    this.handlers.onHover(null);
    this.handlers.onStop();
  }

  /** The innermost element under the pointer, or null for the panel itself. */
  private target(e: Event): Element | null {
    const path = e.composedPath();
    if (path.some((t) => this.handlers.isOwn(t))) return null;
    const first = path[0] as Node | undefined;
    // nodeType, not instanceof: elements of an iframe belong to that frame's own Element class
    return first && first.nodeType === 1 ? (first as Element) : null;
  }

  private onMove = (e: Event): void => {
    this.handlers.onHover(this.target(e));
  };

  private onClick = (e: Event): void => {
    const el = this.target(e);
    if (!el) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.stop();
    this.handlers.onPick(el);
  };

  private onKey = (e: Event): void => {
    if ((e as KeyboardEvent).key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.stop();
    }
  };

  private block = (e: Event): void => {
    if (this.target(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
}

/** The document plus every same-origin iframe document inside it (shadow roots included). */
function sameOriginDocuments(root: Document): Document[] {
  const docs: Document[] = [root];
  const ctx = new QueryContext();
  for (const el of ctx.elements(root)) {
    if (el.tagName !== 'IFRAME') continue;
    try {
      const inner = (el as HTMLIFrameElement).contentDocument;
      if (inner && inner.documentElement) docs.push(...sameOriginDocuments(inner));
    } catch {
      // cross-origin frame: its own page scripts can't be reached from here
    }
  }
  return docs;
}
