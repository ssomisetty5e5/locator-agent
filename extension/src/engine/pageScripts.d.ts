// Page-side scripts compiled into real functions at build time by
// scripts/build-extension.js (so the extension never needs eval).
declare module 'virtual:page-scripts' {
  /** Walk `document`, piercing open shadow roots; stores node handles on `window.__laNodes`. */
  export function traverse(document: Document, window: Window): any;
  /** Describe the ancestors of the node at `window.__laNodes[nodeIndex]`. */
  export function ancestorProbe(document: Document, window: Window, nodeIndex: number): any;
}
