// ============================================================
// Shadow DOM Traverser
// Recursively walks the DOM including all Shadow DOM boundaries.
// Runs inside the browser context via page.evaluate().
// ============================================================

import { SerializedNode } from '../types';

/**
 * Browser-side script that recursively traverses the entire DOM,
 * piercing every Shadow DOM boundary, and returns serialized nodes.
 *
 * This function is meant to be passed to page.evaluate().
 */
export function getBrowserTraversalScript(): string {
  return `
    (() => {
      const INTERACTIVE_TAGS = new Set([
        'a', 'button', 'input', 'select', 'textarea', 'details',
        'summary', 'label', 'option', 'fieldset', 'output', 'meter',
        'progress', 'dialog', 'menu', 'menuitem'
      ]);

      const INTERACTIVE_ROLES = new Set([
        'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
        'listbox', 'option', 'menuitem', 'tab', 'tabpanel', 'switch',
        'slider', 'spinbutton', 'searchbox', 'menu', 'menubar',
        'navigation', 'dialog', 'alertdialog', 'tree', 'treeitem',
        'grid', 'gridcell', 'row', 'columnheader', 'rowheader'
      ]);

      const MAX_ELEMENTS = 10000;
      const MAX_DEPTH = 60;
      const MAX_SHADOW_DEPTH = 15;

      const results = [];
      let shadowRootCount = 0;
      let totalElements = 0;
      const visited = new WeakSet();

      function getAttributes(el) {
        const attrs = {};
        for (const attr of el.attributes || []) {
          attrs[attr.name] = attr.value;
        }
        return attrs;
      }

      function getTextContent(el) {
        let text = '';
        for (const child of el.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            text += child.textContent;
          }
        }
        return text.trim().substring(0, 100);
      }

      function getAriaRole(el) {
        return el.getAttribute('role') || el.ariaRoleDescription || null;
      }

      function isInteractive(el, tag) {
        if (INTERACTIVE_TAGS.has(tag)) return true;
        const role = getAriaRole(el);
        if (role && INTERACTIVE_ROLES.has(role)) return true;
        if (el.getAttribute('tabindex') !== null) return true;
        if (el.getAttribute('onclick') !== null) return true;
        if (el.getAttribute('contenteditable') === 'true') return true;
        if (el.hasAttribute('data-testid')) return true;
        return false;
      }

      function getNthOfType(el) {
        const tag = el.tagName;
        const parent = el.parentElement || (el.getRootNode && el.getRootNode().host ? el.getRootNode() : null);
        if (!parent) return { nthOfType: 1, siblingsOfSameType: 1 };

        const children = parent.children || [];
        let index = 0;
        let count = 0;
        for (const child of children) {
          if (child.tagName === tag) {
            count++;
            if (child === el) index = count;
          }
        }
        return { nthOfType: index || 1, siblingsOfSameType: count || 1 };
      }

      function getCssSegment(el) {
        const tag = el.tagName.toLowerCase();
        const id = el.id;
        if (id) return tag + '#' + CSS.escape(id);

        const classes = Array.from(el.classList || [])
          .filter(c => !c.match(/^[a-z]{1,3}[0-9a-f]{4,}/i))
          .slice(0, 3);
        if (classes.length > 0) return tag + '.' + classes.map(c => CSS.escape(c)).join('.');

        const { nthOfType, siblingsOfSameType } = getNthOfType(el);
        if (siblingsOfSameType > 1) return tag + ':nth-of-type(' + nthOfType + ')';
        return tag;
      }

      /**
       * Build a qualified selector for a shadow host element —
       * includes key attributes to distinguish it from siblings of
       * the same custom element tag.
       */
      function getHostSelector(el) {
        const tag = el.tagName.toLowerCase();
        const id = el.id;
        if (id && !id.match(/^[a-f0-9]{8,}$/i) && !id.match(/^:r[0-9a-z]+:$/)) {
          return tag + '#' + CSS.escape(id);
        }
        // Prefer distinguishing attributes used on Polymer/Lit custom elements
        const qualifiers = [];
        const keyAttrs = ['name', 'data-testid', 'label', 'icon', 'page', 'role', 'aria-label'];
        for (const attr of keyAttrs) {
          const v = el.getAttribute(attr);
          if (v) {
            qualifiers.push('[' + attr + '="' + v.replace(/"/g, '\\\\"') + '"]');
            break; // one distinguishing attr is usually enough
          }
        }
        if (qualifiers.length > 0) return tag + qualifiers.join('');
        // Fallback: classes
        const classes = Array.from(el.classList || [])
          .filter(c => !c.match(/^[a-z]{1,3}[0-9a-f]{4,}/i))
          .slice(0, 2);
        if (classes.length > 0) return tag + '.' + classes.map(c => CSS.escape(c)).join('.');
        return tag;
      }

      function getBoundingBox(el) {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return null;
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        } catch { return null; }
      }

      // ── Iterative traversal using an explicit stack ──
      // Each stack entry: { node, shadowDepth, shadowHostChain, cssPath, depth }
      const stack = [];

      // Seed: all direct children of document.body
      if (document.body) {
        const bodyChildren = document.body.children;
        // Push in reverse so first child is processed first
        for (let i = bodyChildren.length - 1; i >= 0; i--) {
          stack.push({
            el: bodyChildren[i],
            shadowDepth: 0,
            shadowHostChain: [],
            cssPath: ['body'],
            depth: 1
          });
        }
      }

      while (stack.length > 0 && results.length < MAX_ELEMENTS) {
        const item = stack.pop();
        const child = item.el;

        // Guard: skip if already visited (handles cycles), too deep, or not an element
        if (!child || !child.tagName) continue;
        if (visited.has(child)) continue;
        visited.add(child);
        if (item.depth > MAX_DEPTH) continue;
        if (item.shadowDepth > MAX_SHADOW_DEPTH) continue;

        totalElements++;
        const tag = child.tagName.toLowerCase();
        const segment = getCssSegment(child);
        // Limit cssPath length to prevent huge arrays
        const currentCssPath = item.cssPath.length < 20
          ? [...item.cssPath, segment]
          : [...item.cssPath.slice(-10), segment];

        const attrs = getAttributes(child);
        const text = getTextContent(child);
        const role = getAriaRole(child);
        const interactive = isInteractive(child, tag);
        const { nthOfType, siblingsOfSameType } = getNthOfType(child);
        const bbox = getBoundingBox(child);

        let htmlSnippet = '';
        try {
          htmlSnippet = child.outerHTML.substring(0, 200);
        } catch {}

        const serialized = {
          tag,
          attributes: attrs,
          text,
          htmlSnippet,
          childCount: child.children ? child.children.length : 0,
          nthOfType,
          siblingsOfSameType,
          shadowDepth: item.shadowDepth,
          shadowHostChain: item.shadowHostChain.slice(0, 10),
          shadowHost: item.shadowHostChain.length > 0
            ? item.shadowHostChain[item.shadowHostChain.length - 1]
            : null,
          ariaRole: role,
          cssPathSegments: currentCssPath,
          boundingBox: bbox,
          isInteractive: interactive
        };

        results.push(serialized);

        // ── Push children onto the stack ──

        // 1) Shadow root children first (they'll be processed after light DOM children)
        if (child.shadowRoot) {
          shadowRootCount++;
          const hostSel = getHostSelector(child);
          const shadowChildren = child.shadowRoot.children || [];
          for (let i = shadowChildren.length - 1; i >= 0; i--) {
            stack.push({
              el: shadowChildren[i],
              shadowDepth: item.shadowDepth + 1,
              shadowHostChain: [...item.shadowHostChain, hostSel].slice(0, 10),
              cssPath: currentCssPath,
              depth: item.depth + 1
            });
          }
        }

        // 2) Light DOM children
        const lightChildren = child.children || [];
        for (let i = lightChildren.length - 1; i >= 0; i--) {
          stack.push({
            el: lightChildren[i],
            shadowDepth: item.shadowDepth,
            shadowHostChain: item.shadowHostChain,
            cssPath: currentCssPath,
            depth: item.depth + 1
          });
        }
      }

      return {
        nodes: results,
        totalElements,
        shadowRootCount,
        title: document.title || ''
      };
    })()
  `;
}

/**
 * Parse the raw traversal result into typed SerializedNode array.
 */
export function parseTraversalResult(raw: any): {
  nodes: SerializedNode[];
  totalElements: number;
  shadowRootCount: number;
  title: string;
} {
  return {
    nodes: (raw.nodes || []) as SerializedNode[],
    totalElements: raw.totalElements || 0,
    shadowRootCount: raw.shadowRootCount || 0,
    title: raw.title || '',
  };
}
