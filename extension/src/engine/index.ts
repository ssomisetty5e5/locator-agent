// ============================================================
// In-page engine
// The same discover → generate → validate → rank pipeline as the
// Playwright agent, running inside a web page for the browser extension.
// ============================================================

import { traverse, ancestorProbe } from 'virtual:page-scripts';
import { ElementDiscoverer } from '../../../src/discoverer';
import { parseAncestors } from '../../../src/discoverer/ancestorProbe';
import { parseTraversalResult } from '../../../src/traverser/shadowDomTraverser';
import { ElementAnalyzer, ElementDriver } from '../../../src/core/elementAnalyzer';
import { generatePageObject, LANGUAGES, PageObjectLanguage, toPlaywrightExpression } from '../../../src/pageobject';
import { suggestImprovements, developerNote, developerReport } from '../../../src/suggest/improvements';
import { DiscoveredElement, ElementAnalysis, PageAnalysis } from '../../../src/types';
import { DomValidator } from './domValidator';
import { frameSelectorFor } from './frames';

export interface AnalyzeOptions {
  includeNonInteractive?: boolean;
  maxElements?: number;
  /** Called after each element, so a UI can show progress. */
  onProgress?: (done: number, total: number) => void;
}

/** Let the page paint and respond; long analyses would otherwise freeze the tab. */
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const SLICE_MS = 40;

type NodeWindow = Window & { __laNodes?: Element[] };

const discoverer = new ElementDiscoverer();
const analyzer = new ElementAnalyzer();

function driverFor(doc: Document): ElementDriver {
  const validator = new DomValidator(doc);
  const win = doc.defaultView as Window;
  return {
    validate: (locators, nodeIndex) => validator.validate(locators, nodeIndex),
    probeAncestors: async (nodeIndex) => parseAncestors(ancestorProbe(doc, win, nodeIndex)),
  };
}

/** Locators for every interactive element of the document (open shadow roots included). */
export async function analyzePage(doc: Document = document, options: AnalyzeOptions = {}): Promise<PageAnalysis> {
  const win = doc.defaultView as Window;
  const traversal = parseTraversalResult(traverse(doc, win));
  const elements = discoverer.discover(traversal.nodes, options.includeNonInteractive ?? false, options.maxElements ?? 200);
  const driver = driverFor(doc);

  const analyses: ElementAnalysis[] = [];
  let sliceStart = Date.now();
  for (const el of elements) {
    analyses.push(await analyzer.analyze(el, driver));
    options.onProgress?.(analyses.length, elements.length);
    if (Date.now() - sliceStart > SLICE_MS) {
      await yieldToBrowser();
      sliceStart = Date.now();
    }
  }

  return {
    source: win.location.href,
    timestamp: new Date().toISOString(),
    pageTitle: traversal.title,
    totalDomElements: traversal.totalElements,
    interactiveElementsFound: elements.length,
    shadowRootsPierced: traversal.shadowRootCount,
    framesAnalyzed: 1,
    elements: analyses,
  };
}

/**
 * Locators for one element (works for any element in the main document or a
 * same-origin iframe). Returns null if the element isn't part of the page body
 * (for example `<html>` itself, or a node inside a closed shadow root).
 */
export async function analyzeElement(target: Element): Promise<ElementAnalysis | null> {
  const doc = target.ownerDocument;
  const win = doc.defaultView as NodeWindow | null;
  if (!win) return null;

  const traversal = parseTraversalResult(traverse(doc, win));
  const index = win.__laNodes ? win.__laNodes.indexOf(target) : -1;
  if (index < 0) return null;

  const [element] = discoverer.discover([traversal.nodes[index]], true, 1);
  const framePath = frameSelectorFor(win);
  if (framePath.length > 0) element.framePath = framePath;
  return analyzer.analyze(element, driverFor(doc));
}

/** The traversed node behind an analysed element, for highlighting it again. */
export function nodeFor(element: DiscoveredElement, doc: Document = document): Element | null {
  const win = doc.defaultView as NodeWindow | null;
  return element.nodeIndex !== undefined && win?.__laNodes ? win.__laNodes[element.nodeIndex] ?? null : null;
}

export { generatePageObject, LANGUAGES, toPlaywrightExpression, suggestImprovements, developerNote, developerReport };
export type { PageObjectLanguage };
