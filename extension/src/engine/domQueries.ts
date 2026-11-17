// ============================================================
// In-page locator queries
// Re-implements, inside a web page, how Playwright resolves the
// locators this project generates (getByRole, getByText, getByLabel,
// getByPlaceholder, getByTestId, locator('css'), `a >> b` chains and
// scoped locators), so the browser extension can validate them without
// Playwright. Matching follows Playwright's rules for open shadow DOM:
// queries pierce open shadow roots; text and names are case-insensitive
// substring matches on whitespace-normalised text.
// ============================================================

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const lower = (s: string): string => norm(s).toLowerCase();

const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

/** Roles whose accessible name may come from their content (ARIA "name from content"). */
const NAME_FROM_CONTENT = new Set([
  'button', 'link', 'heading', 'checkbox', 'radio', 'option', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'switch', 'treeitem', 'gridcell', 'cell', 'columnheader', 'rowheader', 'tooltip',
]);

const INPUT_ROLES: Record<string, string> = {
  button: 'button', submit: 'button', reset: 'button', image: 'button',
  checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox',
  // not an ARIA role, but Playwright (which the locators target) exposes password fields as textboxes
  password: 'textbox',
};

/** Caches that make repeated queries over one unchanging page cheap. */
export class QueryContext {
  private text = new WeakMap<Node, string>();
  private lowered = new WeakMap<Node, string>();
  private name = new WeakMap<Element, string>();
  private role = new WeakMap<Element, string | null>();
  private hidden = new WeakMap<Element, boolean>();
  private all = new WeakMap<ParentNode, Element[]>();
  private shadowRoots = new WeakMap<ParentNode, ShadowRoot[]>();

  /** Every element under `root`, descending into open shadow roots (root itself excluded). */
  elements(root: ParentNode): Element[] {
    const cached = this.all.get(root);
    if (cached) return cached;
    const out: Element[] = [];
    const walk = (node: ParentNode) => {
      for (const el of Array.from(node.querySelectorAll('*'))) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    if ((root as Element).shadowRoot) walk((root as Element).shadowRoot as ShadowRoot);
    this.all.set(root, out);
    return out;
  }

  /** Visible text of a node, including open shadow content and button-like input values. */
  textOf(node: Node): string {
    const cached = this.text.get(node);
    if (cached !== undefined) return cached;
    let s = '';
    if (node.nodeType === 3) {
      s = node.nodeValue || '';
    } else if (node.nodeType === 1) {
      const el = node as Element;
      if (SKIP_TEXT.has(el.tagName)) {
        s = '';
      } else if (el.tagName === 'INPUT') {
        const type = (el as HTMLInputElement).type;
        s = type === 'button' || type === 'submit' || type === 'reset' ? (el as HTMLInputElement).value : '';
      } else {
        if (el.shadowRoot) for (const c of Array.from(el.shadowRoot.childNodes)) s += this.textOf(c);
        for (const c of Array.from(el.childNodes)) s += this.textOf(c);
      }
    }
    this.text.set(node, s);
    return s;
  }

  /** `textOf`, whitespace-normalised and lower-cased (what text matching compares). */
  lowerText(node: Node): string {
    let s = this.lowered.get(node);
    if (s === undefined) {
      s = lower(this.textOf(node));
      this.lowered.set(node, s);
    }
    return s;
  }

  // ── CSS ───────────────────────────────────────────────────

  /** `querySelectorAll` that also searches open shadow roots (Playwright's CSS engine does). */
  cssDeep(root: ParentNode, selector: string): Element[] {
    const out = new Set<Element>();
    root.querySelectorAll(selector).forEach((e) => out.add(e));
    for (const shadow of this.shadowRootsUnder(root)) shadow.querySelectorAll(selector).forEach((e) => out.add(e));
    return [...out];
  }

  /** Open shadow roots at any depth under `root` (plus the root's own, when it is a host); cached. */
  private shadowRootsUnder(root: ParentNode): ShadowRoot[] {
    const cached = this.shadowRoots.get(root);
    if (cached) return cached;
    const out: ShadowRoot[] = [];
    const visit = (node: ParentNode) => {
      for (const el of Array.from(node.querySelectorAll('*'))) {
        if (el.shadowRoot) {
          out.push(el.shadowRoot);
          visit(el.shadowRoot);
        }
      }
    };
    const own = (root as Element).shadowRoot;
    if (own) {
      out.push(own);
      visit(own);
    }
    visit(root);
    this.shadowRoots.set(root, out);
    return out;
  }

  /** `a >> b >> c`: each part is searched inside the matches of the previous one. */
  chain(root: ParentNode, selector: string): Element[] {
    let scopes: ParentNode[] = [root];
    let found: Element[] = [];
    for (const part of selector.split(' >> ')) {
      const next = new Set<Element>();
      for (const scope of scopes) for (const e of this.cssDeep(scope, part.trim())) next.add(e);
      found = [...next];
      scopes = found;
    }
    return found;
  }

  // ── Roles and names ───────────────────────────────────────

  roleOf(el: Element): string | null {
    if (this.role.has(el)) return this.role.get(el)!;
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    const role = explicit || implicitRole(el);
    this.role.set(el, role);
    return role;
  }

  isHidden(el: Element): boolean {
    const cached = this.hidden.get(el);
    if (cached !== undefined) return cached;
    let hidden = false;
    // aria-hidden anywhere up the tree (crossing shadow boundaries)
    for (let n: Node | null = el; n; n = n.parentNode || (n as ShadowRoot).host || null) {
      if (n.nodeType === 1 && (n as Element).getAttribute('aria-hidden') === 'true') { hidden = true; break; }
    }
    if (!hidden) {
      const cv = (el as any).checkVisibility;
      if (typeof cv === 'function') {
        hidden = !cv.call(el, { checkVisibilityCSS: true, visibilityProperty: true });
      }
    }
    this.hidden.set(el, hidden);
    return hidden;
  }

  /** Simplified accessible-name computation (aria-labelledby, aria-label, labels, alt, content, title). */
  nameOf(el: Element): string {
    const cached = this.name.get(el);
    if (cached !== undefined) return cached;
    const name = norm(this.computeName(el));
    this.name.set(el, name);
    return name;
  }

  private computeName(el: Element): string {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const parts = labelledby.split(/\s+/).map((id) => {
        const ref = root.getElementById ? root.getElementById(id) : null;
        return ref ? (ref.getAttribute('aria-label') || this.textOf(ref)) : '';
      });
      const joined = norm(parts.join(' '));
      if (joined) return joined;
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && norm(ariaLabel)) return ariaLabel;

    const tag = el.tagName.toLowerCase();
    const type = ((el as HTMLInputElement).type || '').toLowerCase();

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        const t = norm(Array.from(labels).map((l) => this.textOf(l)).join(' '));
        if (t) return t;
      }
      if (tag === 'input') {
        if (type === 'button' || type === 'submit' || type === 'reset') {
          const v = (el as HTMLInputElement).value;
          if (v) return v;
          return type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '';
        }
        if (type === 'image') return el.getAttribute('alt') || el.getAttribute('title') || 'Submit';
      }
      return el.getAttribute('title') || el.getAttribute('placeholder') || '';
    }

    if (tag === 'img' || tag === 'area') return el.getAttribute('alt') || el.getAttribute('title') || '';
    if (tag === 'fieldset') {
      const legend = el.querySelector(':scope > legend');
      if (legend) return this.textOf(legend);
    }
    if (tag === 'table') {
      const caption = el.querySelector(':scope > caption');
      if (caption) return this.textOf(caption);
    }

    const role = this.roleOf(el);
    if (role && NAME_FROM_CONTENT.has(role)) {
      const content = norm(this.contentName(el));
      if (content) return content;
    }
    return el.getAttribute('title') || '';
  }

  /** Name from content: text, plus alt text of images and labels of nested controls. */
  private contentName(el: Element): string {
    let s = '';
    const visit = (parent: Element) => {
      const children: Node[] = [
        ...(parent.shadowRoot ? Array.from(parent.shadowRoot.childNodes) : []),
        ...Array.from(parent.childNodes),
      ];
      for (const c of children) {
        if (c.nodeType === 3) {
          s += c.nodeValue || '';
        } else if (c.nodeType === 1) {
          const ce = c as Element;
          if (SKIP_TEXT.has(ce.tagName) || ce.getAttribute('aria-hidden') === 'true') continue;
          const label = ce.getAttribute('aria-label');
          if (label) s += ` ${label} `;
          else if (ce.tagName === 'IMG') s += ` ${ce.getAttribute('alt') || ''} `;
          else if (ce.tagName === 'INPUT') s += ` ${this.textOf(ce)} `;
          else { s += ' '; visit(ce); s += ' '; }
        }
      }
    };
    visit(el);
    return s;
  }

  // ── Playwright-style queries over a search scope ──────────

  byRole(scope: ParentNode, role: string, name?: string): Element[] {
    const needle = name === undefined ? null : lower(name);
    return this.elements(scope).filter((el) => {
      if (this.roleOf(el) !== role || this.isHidden(el)) return false;
      return needle === null || lower(this.nameOf(el)).includes(needle);
    });
  }

  /** The smallest elements whose text contains `text`. */
  byText(scope: ParentNode, text: string): Element[] {
    const needle = lower(text);
    const matches = (el: Element) => this.lowerText(el).includes(needle);
    return this.elements(scope).filter((el) => {
      if (SKIP_TEXT.has(el.tagName) || !matches(el)) return false;
      const kids = [...Array.from(el.children), ...(el.shadowRoot ? Array.from(el.shadowRoot.children) : [])];
      return !kids.some(matches);
    });
  }

  byLabel(scope: ParentNode, text: string): Element[] {
    const needle = lower(text);
    return this.elements(scope).filter((el) => {
      const aria = el.getAttribute('aria-label');
      if (aria && lower(aria).includes(needle)) return true;
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const root = el.getRootNode() as Document | ShadowRoot;
        const t = by.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : null))
          .filter(Boolean).map((r) => this.textOf(r as Element)).join(' ');
        if (lower(t).includes(needle)) return true;
      }
      const labels = (el as HTMLInputElement).labels;
      return !!labels && Array.from(labels).some((l) => this.lowerText(l).includes(needle));
    });
  }

  byPlaceholder(scope: ParentNode, text: string): Element[] {
    const needle = lower(text);
    return this.elements(scope).filter((el) => {
      const p = el.getAttribute('placeholder');
      return !!p && lower(p).includes(needle);
    });
  }

  byTestId(scope: ParentNode, id: string): Element[] {
    return this.elements(scope).filter((el) => el.getAttribute('data-testid') === id);
  }

  /** `hasText` filter: element text contains the text (case-insensitive). */
  filterHasText(els: Element[], text: string): Element[] {
    const needle = lower(text);
    return els.filter((el) => this.lowerText(el).includes(needle));
  }

  /**
   * Evaluate one generated Playwright expression (`getByRole('button', { name: 'Go' })`,
   * `locator('input[name="q"]')`, …) inside every search scope. Returns null for
   * expressions this engine doesn't understand.
   */
  evalExpression(scopes: ParentNode[], expr: string): Element[] | null {
    const each = (fn: (scope: ParentNode) => Element[]) => {
      const out = new Set<Element>();
      for (const s of scopes) for (const e of fn(s)) out.add(e);
      return [...out];
    };

    const css = expr.match(/^locator\('((?:\\.|[^'\\])*)'\)$/);
    if (css) {
      const sel = css[1].replace(/\\(.)/g, '$1');
      return each((s) => this.cssDeep(s, sel));
    }
    const role = expr.match(/^getByRole\('([^']+)'(?:\s*,\s*\{\s*name:\s*'([^']*)'\s*\})?\)$/);
    if (role) return each((s) => this.byRole(s, role[1], role[2]));
    const text = expr.match(/^getByText\('([^']*)'\)$/);
    if (text) return each((s) => this.byText(s, text[1]));
    const label = expr.match(/^getByLabel\('([^']*)'\)$/);
    if (label) return each((s) => this.byLabel(s, label[1]));
    const ph = expr.match(/^getByPlaceholder\('([^']*)'\)$/);
    if (ph) return each((s) => this.byPlaceholder(s, ph[1]));
    const tid = expr.match(/^getByTestId\('([^']*)'\)$/);
    if (tid) return each((s) => this.byTestId(s, tid[1]));
    return null;
  }

  /**
   * Resolve a generated JavaScript chain such as
   * `document.querySelector('a').shadowRoot.querySelector('b')` without eval
   * (extension pages and many sites forbid it). Returns the final element or null.
   */
  jsChain(doc: Document, chain: string): Element | null {
    let rest = chain.trim();
    if (!rest.startsWith('document')) return null;
    rest = rest.slice('document'.length);
    let current: ParentNode | null = doc;
    const query = /^\.querySelector\('((?:\\.|[^'\\])*)'\)/;
    while (rest.length > 0) {
      if (rest.startsWith('.shadowRoot')) {
        current = (current as Element)?.shadowRoot ?? null;
        rest = rest.slice('.shadowRoot'.length);
      } else {
        const m = rest.match(query);
        if (!m || !current) return null;
        current = current.querySelector(m[1].replace(/\\(.)/g, '$1'));
        rest = rest.slice(m[0].length);
      }
      if (!current) return null;
    }
    return current as Element;
  }
}

/** Implicit ARIA role of an element, from its tag and attributes. */
function implicitRole(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a': case 'area': return el.hasAttribute('href') ? 'link' : null;
    case 'button': return 'button';
    case 'input': {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (type === 'text' && el.hasAttribute('list')) return 'combobox';
      return INPUT_ROLES[type] ?? null;
    }
    case 'textarea': return 'textbox';
    case 'select': return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
    case 'option': return 'option';
    case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
    case 'ul': case 'ol': return 'list';
    case 'li': return 'listitem';
    case 'table': return 'table';
    case 'tr': return 'row';
    case 'td': return 'cell';
    case 'th': return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
    case 'nav': return 'navigation';
    case 'main': return 'main';
    case 'aside': return 'complementary';
    case 'article': return 'article';
    case 'dialog': return 'dialog';
    case 'form': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'form' : null;
    case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
    case 'fieldset': case 'details': return 'group';
    case 'progress': return 'progressbar';
    case 'meter': return 'meter';
    case 'output': return 'status';
    case 'hr': return 'separator';
    default: return null;
  }
}
