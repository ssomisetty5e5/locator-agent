// ============================================================
// LocatorAgent - Shared Type Definitions
// ============================================================

/**
 * Bounding box for an element on the page.
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Serialized DOM node returned from the browser context.
 * This is the raw data collected by the Shadow DOM traverser.
 */
export interface SerializedNode {
  tag: string;
  attributes: Record<string, string>;
  text: string;
  htmlSnippet: string;
  childCount: number;
  nthOfType: number;
  siblingsOfSameType: number;
  shadowDepth: number;
  shadowHostChain: string[];
  shadowHost: string | null;
  ariaRole: string | null;
  cssPathSegments: string[];
  boundingBox: BoundingBox | null;
  isInteractive: boolean;

  /** Index of this node in the page-side `window.__laNodes` array (set by the traverser) */
  nodeIndex?: number;
}

/**
 * Represents a single element discovered in the DOM (including Shadow DOM).
 */
export interface DiscoveredElement {
  /** Unique identifier for this element in the analysis */
  uid: string;

  /** HTML tag name (lowercase) */
  tag: string;

  /** Text content (trimmed, max 100 chars) */
  text: string;

  /** Element attributes as key-value pairs */
  attributes: Record<string, string>;

  /** How many Shadow DOM boundaries deep this element is */
  shadowDepth: number;

  /** Tag names of shadow hosts from root to this element */
  shadowHostChain: string[];

  /** The immediate shadow host tag name, or null if in light DOM */
  shadowHost: string | null;

  /** Computed aria role if available */
  ariaRole: string | null;

  /** CSS path segments from root to element (for building selectors) */
  cssPathSegments: string[];

  /** Whether this element is interactive (button, input, link, etc.) */
  isInteractive: boolean;

  /** The element's bounding box (if available) */
  boundingBox: BoundingBox | null;

  /** Inner HTML snippet (first 200 chars) */
  htmlSnippet: string;

  /** Child count */
  childCount: number;

  /** The element's position among siblings of the same tag */
  nthOfType: number;

  /** Total siblings of the same tag */
  siblingsOfSameType: number;

  /** Index into the page-side `window.__laNodes` array, used to verify locators hit this exact element */
  nodeIndex?: number;
}

/**
 * Locator strategy names.
 */
export type LocatorStrategy =
  | 'testId'
  | 'ariaRole'
  | 'ariaLabel'
  | 'text'
  | 'id'
  | 'css'
  | 'shadowPiercingCss'
  | 'xpath'
  | 'name'
  | 'placeholder';

/**
 * Framework-specific output format.
 */
export type FrameworkFormat = 'playwright' | 'selenium' | 'css' | 'xpath' | 'generic' | 'javascript' | 'webdriverio';

/**
 * A single locator strategy result.
 */
export interface LocatorResult {
  /** Strategy name */
  strategy: LocatorStrategy;

  /** The locator value / expression */
  value: string;

  /** Framework-specific format */
  framework: FrameworkFormat;

  /** Robustness score 0-100 */
  score: number;

  /** Human-readable reason for the score */
  scoreReason: string;

  /** Number of elements this locator matches on the page (set after validation) */
  matchCount?: number;

  /** Whether this locator uniquely identifies exactly one element */
  isUnique?: boolean;

  /**
   * Whether the elements this locator matches include the element it was
   * generated for. Only set when the validator could resolve the target
   * (i.e. the element came from a page traversal). `false` means the
   * locator finds *something else* and must not be trusted.
   */
  resolvesToTarget?: boolean;
}

/**
 * Full analysis result for a single element.
 */
export interface ElementAnalysis {
  /** The discovered element metadata */
  element: DiscoveredElement;

  /** All generated locators, sorted by score (descending) */
  locators: LocatorResult[];

  /** The single best recommended locator */
  recommended: LocatorResult;
}

/**
 * Full page analysis result.
 */
export interface PageAnalysis {
  /** Source URL or file path */
  source: string;

  /** Timestamp of analysis */
  timestamp: string;

  /** Page title */
  pageTitle: string;

  /** Total elements found in DOM (including shadow DOM) */
  totalDomElements: number;

  /** Total interactive elements analyzed */
  interactiveElementsFound: number;

  /** Total shadow roots pierced */
  shadowRootsPierced: number;

  /** Per-element analysis */
  elements: ElementAnalysis[];
}

/**
 * Input configuration for the agent.
 */
export interface AgentInput {
  /** URL to analyze (mutually exclusive with html) */
  url?: string;

  /** Raw HTML string to analyze */
  html?: string;

  /** File path to an HTML/MHTML snapshot */
  filePath?: string;

  /** Whether to include non-interactive elements */
  includeNonInteractive?: boolean;

  /** Maximum number of elements to return */
  maxElements?: number;

  /** Timeout in milliseconds for page load */
  timeout?: number;

  /** Viewport size */
  viewport?: { width: number; height: number };
}

/**
 * Result from the page loader module.
 */
export interface LoadedPage {
  /** Source identifier (URL or file path) */
  source: string;

  /** Page title */
  title: string;

  /** Serialized nodes from DOM traversal */
  nodes: SerializedNode[];

  /** Total DOM elements counted */
  totalDomElements: number;

  /** Number of shadow roots pierced */
  shadowRootsPierced: number;
}

/**
 * Interface for a locator strategy implementation.
 */
export interface ILocatorStrategy {
  /** Strategy name */
  name: LocatorStrategy;

  /** Generate locators for a given element */
  generate(element: DiscoveredElement): LocatorResult[];
}

/**
 * Interface for a framework adapter.
 *
 * Adapters translate already-generated, framework-neutral locator results
 * (css selectors, xpath expressions, or Playwright semantic calls) into a
 * *different* test automation framework's syntax. This lets new frameworks
 * be added as a single new adapter file, without touching any of the
 * existing locator strategies (which stay focused on *finding* good
 * selectors, not on rendering them for every possible framework).
 */
export interface IFrameworkAdapter {
  /** The framework this adapter produces output for */
  framework: FrameworkFormat;

  /**
   * Attempt to translate a single generated locator into this adapter's
   * framework. Return `null` if this locator can't/shouldn't be translated
   * (e.g. a strategy that has no equivalent in the target framework).
   */
  adapt(locator: LocatorResult, element: DiscoveredElement): LocatorResult | LocatorResult[] | null;
}
