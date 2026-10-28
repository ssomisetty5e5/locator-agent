// ============================================================
// Locator Agent - Main Orchestrator
// Ties together: Loader → Traverser → Discoverer → Generator → Ranker
// ============================================================

import { PageLoader } from './loader';
import { ElementDiscoverer } from './discoverer';
import { LocatorGenerator } from './generator';
import { LocatorRanker } from './ranker';
import { LocatorValidator } from './validator';
import {
  AgentInput,
  PageAnalysis,
  ElementAnalysis,
  DiscoveredElement,
} from './types';

export class LocatorAgent {
  private loader: PageLoader;
  private discoverer: ElementDiscoverer;
  private generator: LocatorGenerator;
  private ranker: LocatorRanker;
  private validator: LocatorValidator;

  constructor() {
    this.loader = new PageLoader();
    this.discoverer = new ElementDiscoverer();
    this.generator = new LocatorGenerator();
    this.ranker = new LocatorRanker();
    this.validator = new LocatorValidator();
  }

  /**
   * Analyze a page and return locators for all discovered elements.
   * Validates each locator against the live page for uniqueness.
   */
  async analyze(input: AgentInput): Promise<PageAnalysis> {
    const startTime = Date.now();

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
        const rawLocators = this.generator.generate(el);

        // Elements inside iframes are validated within their own frame
        if (el.framePath) {
          for (const loc of rawLocators) loc.framePath = el.framePath;
        }

        // Validate uniqueness against the live page
        await this.validator.validate(loaded.getContext(el.framePath), rawLocators, undefined, el.nodeIndex);

        // Rank (scores now include uniqueness bonuses/penalties)
        const ranked = this.ranker.rank(rawLocators, el);

        const recommended = ranked.length > 0
          ? this.ranker.getBest(ranked)
          : {
              strategy: 'css' as const,
              value: el.tag,
              framework: 'css' as const,
              score: 0,
              scoreReason: 'No locators could be generated',
            };

        elementAnalyses.push({ element: el, locators: ranked, recommended });
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
   * Gracefully shut down the agent (close browser etc).
   */
  async shutdown(): Promise<void> {
    await this.loader.close();
  }
}
