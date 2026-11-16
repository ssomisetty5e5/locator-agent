// ============================================================
// Locator Agent - Main Orchestrator
// Ties together: Loader → Traverser → Discoverer → Generator → Ranker
// ============================================================

import { PageLoader } from './loader';
import { ElementDiscoverer } from './discoverer';
import { LocatorValidator } from './validator';
import { generatePageObject, GeneratedPageObject, PageObjectOptions, LANGUAGES } from './pageobject';
import { ElementAnalyzer, ElementDriver } from './core/elementAnalyzer';
import { getAncestorProbeScript, parseAncestors } from './discoverer/ancestorProbe';
import type { Page, Frame } from 'playwright';
import { AgentInput, PageAnalysis, ElementAnalysis } from './types';

export class LocatorAgent {
  private loader: PageLoader;
  private discoverer: ElementDiscoverer;
  private validator: LocatorValidator;
  private analyzer: ElementAnalyzer;

  constructor() {
    this.loader = new PageLoader();
    this.discoverer = new ElementDiscoverer();
    this.validator = new LocatorValidator();
    this.analyzer = new ElementAnalyzer();
  }

  /**
   * Analyze a page and return locators for all discovered elements.
   * Validates each locator against the live page for uniqueness.
   */
  async analyze(input: AgentInput): Promise<PageAnalysis> {
    const loaded = await this.loader.loadWithPage(input);

    try {
      // Step 1: Discover interactive elements
      const elements = this.discoverer.discover(
        loaded.nodes,
        input.includeNonInteractive ?? false,
        input.maxElements ?? 200,
      );

      // Step 2: Generate, validate, and rank locators for each element
      const elementAnalyses: ElementAnalysis[] = [];
      for (const el of elements) {
        // Elements inside iframes are validated within their own frame
        const context = loaded.getContext(el.framePath);
        elementAnalyses.push(await this.analyzer.analyze(el, this.driverFor(context)));
      }

      return {
        source: loaded.source,
        timestamp: new Date().toISOString(),
        pageTitle: loaded.title,
        totalDomElements: loaded.totalDomElements,
        interactiveElementsFound: elements.length,
        shadowRootsPierced: loaded.shadowRootsPierced,
        framesAnalyzed: loaded.framesAnalyzed,
        elements: elementAnalyses,
      };
    } finally {
      await loaded.cleanup();
    }
  }

  /**
   * Analyze a page and turn the result into a Playwright page object (TypeScript, Python or Java).
   */
  async generatePageObject(input: AgentInput, options: PageObjectOptions = {}): Promise<GeneratedPageObject> {
    // Fail before the (slow) page analysis when the request can't succeed
    if (options.language && !LANGUAGES.includes(options.language)) {
      throw new Error(`Unsupported language "${options.language}". Use one of: ${LANGUAGES.join(', ')}`);
    }
    const analysis = await this.analyze(input);
    return generatePageObject(analysis, options);
  }

  /** Validate and probe through a Playwright page or frame. */
  private driverFor(context: Page | Frame): ElementDriver {
    return {
      validate: (locators, nodeIndex) => this.validator.validate(context, locators, undefined, nodeIndex),
      probeAncestors: async (nodeIndex) => parseAncestors(await context.evaluate(getAncestorProbeScript(nodeIndex))),
    };
  }

  /**
   * Gracefully shut down the agent (close browser etc).
   */
  async shutdown(): Promise<void> {
    await this.loader.close();
  }
}
