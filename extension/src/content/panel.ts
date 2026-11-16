// ============================================================
// The LocatorAgent panel
// A floating panel (inside a shadow root, so page styles can't touch it)
// with two tools: pick one element, or analyse
// the whole page and generate a page object.
// ============================================================

import { analyzeElement, analyzePage, generatePageObject, LANGUAGES, nodeFor, toPlaywrightExpression } from '../engine';
import type { PageObjectLanguage } from '../engine';
import type { DiscoveredElement, ElementAnalysis, LocatorResult, PageAnalysis } from '../../../src/types';
import { Picker } from './picker';
import { CSS } from './styles';
import { copyText, download, h, rectInTop } from './dom';

const FRAMEWORK_LABEL: Record<string, string> = {
  playwright: 'Playwright', selenium: 'Selenium', css: 'CSS', xpath: 'XPath',
  javascript: 'JS', webdriverio: 'WebdriverIO', generic: 'Other',
};

const FILE_EXTENSION: Record<PageObjectLanguage, string> = { typescript: 'ts', python: 'py', java: 'java' };

const scoreClass = (score: number) => (score >= 80 ? 's-hi' : score >= 55 ? 's-mid' : 's-lo');

/** How well a locator pins down the element, as a short badge. */
function matchBadge(l: LocatorResult): { text: string; cls: string; title: string } {
  if (l.matchCount === undefined) return { text: '–', cls: 'm-none', title: 'Could not be checked on this page' };
  if (l.matchCount === 0) return { text: '✗ 0', cls: 'm-bad', title: 'Matches nothing' };
  if (l.resolvesToTarget === false) return { text: '✗ wrong', cls: 'm-bad', title: 'Matches a different element' };
  if (l.matchCount === 1) return { text: '✓ 1', cls: 'm-ok', title: 'Matches exactly this element' };
  return { text: `⚠ ${l.matchCount}`, cls: 'm-warn', title: `Matches ${l.matchCount} elements` };
}

/** What to put on the clipboard for a locator (Playwright ones as full `page.…` expressions). */
function copyValue(l: LocatorResult): string {
  return (l.framework === 'playwright' && toPlaywrightExpression(l)) || l.value;
}

function labelOf(el: DiscoveredElement): string {
  const a = el.attributes;
  return (el.text || a['aria-label'] || a['placeholder'] || a['name'] || a['id'] || a['title'] || '').slice(0, 40);
}

export class Panel {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private panel: HTMLElement;
  private statusEl: HTMLElement;
  private bodyEl: HTMLElement;
  private hl: HTMLElement;
  private pickBtn: HTMLButtonElement;
  private analyzeBtn: HTMLButtonElement;
  private maxSelect: HTMLSelectElement;
  private picker: Picker;
  private hlTimer = 0;
  private busy = false;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'locator-agent-root';
    // Open, so browser-automation tests (and assistive tools) can reach the controls
    this.shadow = this.host.attachShadow({ mode: 'open' });

    this.pickBtn = h('button', { class: 'btn primary', onclick: () => this.togglePick() }, '🎯 Pick element') as HTMLButtonElement;
    this.analyzeBtn = h('button', { class: 'btn', onclick: () => this.runAnalysis() }, '🔍 Analyze page') as HTMLButtonElement;
    this.maxSelect = h('select', { title: 'Maximum elements to analyze' },
      ...[50, 100, 200].map((n) => h('option', n === 100 ? { value: String(n), selected: true } : { value: String(n) }, `up to ${n}`)),
    ) as HTMLSelectElement;
    this.statusEl = h('div', { class: 'status', role: 'status' });
    this.bodyEl = h('div', { class: 'body' });
    this.hl = h('div', { class: 'hl' });

    this.panel = h('div', { class: 'panel' },
      h('div', { class: 'hdr' },
        h('h1', {}, '🎯 LocatorAgent'),
        h('button', { class: 'x', title: 'Close (Alt+L)', onclick: () => this.hide() }, '×'),
      ),
      h('div', { class: 'bar' }, this.pickBtn, this.analyzeBtn, this.maxSelect),
      this.statusEl,
      this.bodyEl,
    );

    this.shadow.append(h('style', {}, CSS), this.hl, this.panel);

    this.picker = new Picker({
      isOwn: (t) => t === this.host,
      onHover: (el) => this.highlight(el),
      onPick: (el) => void this.showElement(el),
      onStop: () => this.pickBtn.replaceChildren('🎯 Pick element'),
    });
    // Keep the page out of our way: its "click outside" logic and keyboard shortcuts
    // shouldn't fire because someone clicked or typed in the panel
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'input']) {
      this.host.addEventListener(type, (e) => e.stopPropagation());
    }
    this.showWelcome();
  }

  get visible(): boolean {
    return this.host.isConnected;
  }

  show(): void {
    // Under <html>, not <body>, so the page analysis never sees the panel
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  hide(): void {
    this.picker.stop();
    this.highlight(null);
    this.host.remove();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  // ── Picking ───────────────────────────────────────────────

  private togglePick(): void {
    if (this.picker.isActive) {
      this.picker.stop();
      this.setStatus('');
      return;
    }
    this.picker.start();
    this.pickBtn.replaceChildren('Picking… (Esc to cancel)');
    this.setStatus('Hover over an element and click it. The page will not receive the click.');
  }

  private async showElement(el: Element): Promise<void> {
    await this.guarded('Analyzing element…', async () => {
      const analysis = await analyzeElement(el);
      if (!analysis) {
        this.setStatus("Couldn't analyze that element (it may be in a closed shadow root or outside the page body).", true);
        return;
      }
      this.bodyEl.replaceChildren(this.elementView(analysis, true));
      this.flash(el);
      this.setStatus('');
    });
  }

  // ── Whole-page analysis ───────────────────────────────────

  private async runAnalysis(): Promise<void> {
    this.picker.stop();
    await this.guarded('Analyzing page…', async () => {
      const analysis = await analyzePage(document, {
        maxElements: Number(this.maxSelect.value),
        onProgress: (done, total) => this.setStatus(`Analyzing… ${done}/${total}`),
      });
      this.bodyEl.replaceChildren(this.pageView(analysis));
      this.setStatus('');
    });
  }

  private async guarded(message: string, work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.analyzeBtn.disabled = true;
    this.setStatus(message);
    try {
      await work();
    } catch (err) {
      this.setStatus(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      this.busy = false;
      this.analyzeBtn.disabled = false;
    }
  }

  // ── Views ─────────────────────────────────────────────────

  private showWelcome(): void {
    this.bodyEl.replaceChildren(
      h('p', { class: 'note' }, 'Pick one element to get ranked, validated locators for it, or analyze the whole page and export a page object.'),
      h('p', { class: 'note' }, 'Shadow DOM is handled. Elements inside same-origin iframes can be picked; cross-origin iframes and closed shadow roots can’t be reached.'),
    );
  }

  /** Header, recommended locator and the full locator table for one element. */
  private elementView(a: ElementAnalysis, withRecommended: boolean): HTMLElement {
    const el = a.element;
    const chips = h('div', { class: 'chips' });
    if (el.shadowDepth > 0) chips.append(h('span', { class: 'chip', title: el.shadowHostChain.join(' › ') }, `Shadow DOM depth ${el.shadowDepth}`));
    if (el.framePath?.length) chips.append(h('span', { class: 'chip', title: el.framePath.join(' › ') }, 'Inside iframe'));
    if (el.ariaRole) chips.append(h('span', { class: 'chip' }, `role: ${el.ariaRole}`));

    const view = h('div', {},
      withRecommended && h('div', { class: 'el' }, h('span', { class: 'tag' }, `<${el.tag}>`), ' ', h('span', { class: 'dim' }, labelOf(el))),
      withRecommended && chips,
    );

    if (withRecommended) {
      const best = a.recommended;
      const badge = matchBadge(best);
      view.append(h('div', { class: 'rec' },
        h('div', { class: 'lbl' }, '★ Recommended'),
        h('div', { class: 'code' }, best.value),
        h('div', { class: 'row', style: 'border:0;padding:6px 0 0' },
          h('span', { class: `score ${scoreClass(best.score)}` }, String(best.score)),
          h('span', { class: badge.cls, title: badge.title }, badge.text),
          h('span', { class: 'dim', style: 'flex:1' }, FRAMEWORK_LABEL[best.framework] ?? best.framework),
          this.copyButton(() => copyValue(best)),
        ),
      ));
    }
    view.append(this.locatorTable(a));
    return view;
  }

  private locatorTable(a: ElementAnalysis): HTMLElement {
    const frameworks = ['all', ...Array.from(new Set(a.locators.map((l) => l.framework)))];
    let active = 'all';
    const chips = h('div', { class: 'chips' });
    const rows = h('div', {});

    const draw = () => {
      chips.replaceChildren(...frameworks.map((f) =>
        h('span', { class: `chip btnchip${f === active ? ' on' : ''}`, onclick: () => { active = f; draw(); } },
          f === 'all' ? `All (${a.locators.length})` : FRAMEWORK_LABEL[f] ?? f)));
      rows.replaceChildren(...a.locators
        .filter((l) => active === 'all' || l.framework === active)
        .map((l) => {
          const badge = matchBadge(l);
          return h('div', { class: 'row' },
            h('span', { class: `score ${scoreClass(l.score)}`, title: l.scoreReason }, String(l.score)),
            h('div', { class: 'main' },
              h('div', { class: 'meta' }, `${l.strategy} · ${FRAMEWORK_LABEL[l.framework] ?? l.framework} · `, h('span', { class: badge.cls, title: badge.title }, badge.text)),
              h('div', { class: 'code' }, l.value)),
            this.copyButton(() => copyValue(l)));
        }));
    };
    draw();
    return h('div', {}, h('div', { class: 'dim', style: 'margin-top:10px' }, `All locators (${a.locators.length})`), chips, rows);
  }

  private pageView(analysis: PageAnalysis): HTMLElement {
    const items = analysis.elements.map((a) => this.pageItem(a));
    const filter = h('input', { class: 'filter', placeholder: 'Filter by tag, text, locator…', oninput: () => {
      const q = (filter as HTMLInputElement).value.toLowerCase();
      for (const it of items) it.root.style.display = !q || it.search.includes(q) ? '' : 'none';
    } });

    const frames = document.querySelectorAll('iframe').length;
    return h('div', {},
      h('div', { class: 'chips' },
        h('span', { class: 'chip' }, `${analysis.interactiveElementsFound} interactive`),
        h('span', { class: 'chip' }, `${analysis.shadowRootsPierced} shadow roots`),
        h('span', { class: 'chip' }, `${analysis.totalDomElements} DOM elements`),
      ),
      frames > 0 && h('p', { class: 'note' }, `${frames === 1 ? '1 iframe is' : `${frames} iframes are`} not included here. Use “Pick element” to inspect inside same-origin iframes.`),
      this.pageObjectBox(analysis),
      filter,
      h('div', {}, ...items.map((it) => it.root)),
    );
  }

  private pageItem(a: ElementAnalysis): { root: HTMLElement; search: string } {
    const el = a.element;
    const best = a.recommended;
    const detail = h('div', { class: 'detail' });
    detail.style.display = 'none';
    let built = false;

    const head = h('div', { class: 'head', onclick: () => {
      const open = detail.style.display === 'none';
      if (open && !built) { detail.append(this.locatorTable(a)); built = true; }
      detail.style.display = open ? '' : 'none';
      const node = nodeFor(el);
      if (open && node) { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); this.flash(node); }
    } },
      h('span', { class: `score ${scoreClass(best.score)}` }, String(best.score)),
      h('div', { class: 't' },
        h('div', {}, h('span', { class: 'tag' }, `<${el.tag}>`), ' ', h('span', { class: 'dim' }, labelOf(el))),
        h('div', { class: 'loc' }, best.value)),
      this.copyButton(() => copyValue(best)),
    );

    const search = [el.tag, labelOf(el), ...a.locators.map((l) => l.value)].join(' ').toLowerCase();
    return { root: h('div', { class: 'item' }, head, detail), search };
  }

  private pageObjectBox(analysis: PageAnalysis): HTMLElement {
    const lang = h('select', {}, ...LANGUAGES.map((l) => h('option', { value: l }, l))) as HTMLSelectElement;
    const out = h('div', {});
    const generate = h('button', { class: 'btn', onclick: () => {
      const language = lang.value as PageObjectLanguage;
      const result = generatePageObject(analysis, { language });
      const filename = language === 'python'
        ? `${result.className.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}.py`
        : `${result.className}.${FILE_EXTENSION[language]}`;
      out.replaceChildren(
        h('pre', { class: 'po code' }, result.code),
        h('div', { class: 'row', style: 'border:0;padding:0' },
          h('span', { class: 'dim', style: 'flex:1' }, `${result.elements.length} locators${result.skipped ? ` (${result.skipped} skipped)` : ''}`),
          this.copyButton(() => result.code, 'Copy'),
          h('button', { class: 'copy', onclick: () => download(filename, result.code) }, `Download ${filename}`),
        ),
      );
    } }, 'Page object');
    return h('div', { class: 'item', style: 'padding:10px' },
      h('div', { class: 'row', style: 'border:0;padding:0;align-items:center' },
        h('span', { style: 'flex:1' }, 'Generate a Playwright page object'), lang, generate),
      out);
  }

  // ── Small pieces ──────────────────────────────────────────

  private copyButton(value: () => string, label = 'Copy'): HTMLElement {
    const btn = h('button', { class: 'copy' }, label);
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await copyText(value());
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => { btn.textContent = label; }, 1200);
    });
    return btn;
  }

  private setStatus(text: string, error = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('err', error);
  }

  /** Outline an element in the page; `null` hides the outline. */
  private highlight(el: Element | null): void {
    window.clearTimeout(this.hlTimer);
    if (!el || !el.isConnected) {
      this.hl.style.display = 'none';
      return;
    }
    const r = rectInTop(el);
    Object.assign(this.hl.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  private flash(el: Element): void {
    this.highlight(el);
    this.hlTimer = window.setTimeout(() => this.highlight(null), 1500);
  }
}
