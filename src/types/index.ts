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

  /**
   * Selectors of the iframes containing this node, outermost first
   * (e.g. ['iframe#checkout', 'iframe[name="card"]']). Empty/absent for the main document.
   */
  framePath?: string[];
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

  /** Iframe selectors from the main document to this element's frame (absent = main document) */
  framePath?: string[];
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
  | 'scoped'
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

  /**
   * Iframes the locator is relative to, outermost first. The locator `value`
   * is written relative to the innermost frame; use `formatWithFrames()` to
   * get a Playwright expression that includes the `frameLocator(...)` chain.
   */
  framePath?: string[];

  /**
   * Set on `scoped` locators: the element is found inside a distinguishing
   * ancestor. `value` is the readable chain; this is the structured form the
   * validator uses to build the real Playwright locator.
   */
  scope?: ScopeSpec;

  /**
   * Set on locators translated by a framework adapter: the `strategy::framework::value`
   * key of the locator they were derived from. Lets the validator copy the source's
   * match count when the translated form can't be executed directly.
   */
  derivedFrom?: string;
}

/**
 * Structured description of a scoped locator:
 * `page.locator(css)[.filter({ hasText })].<inner>`.
 */
export interface ScopeSpec {
  /** CSS selector of the ancestor container, e.g. `tr` or `[data-testid="card-7"]` */
  css: string;
  /** Optional text that distinguishes this ancestor from its siblings */
  hasText?: string;
  /** Playwright expression for the target relative to the ancestor, e.g. `getByRole('button', { name: 'Delete' })` */
  inner: string;
}

/**
 * What the page-side probe reports about one ancestor of an element.
 */
export interface AncestorInfo {
  tag: string;
  id: string;
  testId: string;
  ariaLabel: string;
  role: string;
  /** Short, distinct text snippets inside the ancestor but outside the target */
  texts: string[];
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

  /** Number of frames (main document + iframes) that were analyzed */
  framesAnalyzed?: number;

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

  /** Path to a Playwright storageState JSON file (cookies/localStorage) to reuse a logged-in session */
  storageState?: string;

  /**
   * Network policy for everything the page loads (navigation, redirects, subresources).
   * When `allowPrivateNetwork` is false, traffic goes through a filtering proxy that
   * refuses loopback/private/link-local addresses. Set by the API server.
   */
  networkPolicy?: { allowPrivateNetwork: boolean; allowedTargets?: string[] };
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

  /** Number of frames analyzed (main document + iframes) */
  framesAnalyzed?: number;
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
