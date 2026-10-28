// ============================================================
// Locator Agent - Main Orchestrator
// Ties together: Loader → Traverser → Discoverer → Generator → Ranker
// ============================================================

import { PageLoader } from './loader';
import { ElementDiscoverer } from './discoverer';
import { LocatorGenerator } from './generator';
import { LocatorRanker } from './ranker';
import { LocatorValidator } from './validator';
import { generatePageObject, GeneratedPageObject, PageObjectOptions } from './pageobject';
import { ScopedLocatorGenerator } from './generator/scopedLocatorGenerator';
import { getAncestorProbeScript, parseAncestors } from './discoverer/ancestorProbe';
import type { Page, Frame } from 'playwright';
import {
  AgentInput,
  PageAnalysis,
  ElementAnalysis,
  DiscoveredElement,
  LocatorResult,
  AncestorInfo,
} from './types';

/** Keep at most this many validated scoped locators per element */
const MAX_SCOPED_RESULTS = 3;

export class LocatorAgent {
  private loader: PageLoader;
  private discoverer: ElementDiscoverer;
  private generator: LocatorGenerator;
  private ranker: LocatorRanker;
  private validator: LocatorValidator;
  private scopedGenerator: ScopedLocatorGenerator;

  constructor() {
    this.loader = new PageLoader();
    this.discoverer = new ElementDiscoverer();
    this.generator = new LocatorGenerator();
    this.ranker = new LocatorRanker();
    this.validator = new LocatorValidator();
    this.scopedGenerator = new ScopedLocatorGenerator();
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
        const context = loaded.getContext(el.framePath);
        await this.validator.validate(context, rawLocators, undefined, el.nodeIndex);

        // Rank (scores now include uniqueness bonuses/penalties)
        let ranked = this.ranker.rank(rawLocators, el);

        // Second pass: if nothing found the element uniquely on its own,
        // try locators scoped to a distinguishing ancestor (row, card, list item…)
        if (this.needsScope(ranked) && el.nodeIndex !== undefined) {
          const scoped = await this.buildScopedLocators(context, el, rawLocators);
          if (scoped.length > 0) {
            rawLocators.push(...scoped);
            ranked = this.ranker.rank(rawLocators, el);
          }
        }

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
   * Analyze a page and turn the result into a Playwright (TypeScript) page object.
   */
  async generatePageObject(input: AgentInput, options: PageObjectOptions = {}): Promise<GeneratedPageObject> {
    const analysis = await this.analyze(input);
    return generatePageObject(analysis, options);
  }

  /**
   * True when no locator finds the element both uniquely and without relying
   * on its position (nth-of-type / nth-child / [n] indexes), which break as
   * soon as rows or items are added, removed or reordered.
   */
  private needsScope(ranked: LocatorResult[]): boolean {
    return !ranked.some(
      (l) =>
        l.matchCount === 1 &&
        l.resolvesToTarget !== false &&
        !/nth-(of-type|child)|\[\d+\]/.test(l.value),
    );
  }

  /**
   * Generate and validate ancestor-scoped locators for an element; only
   * candidates that match exactly one element, the target, are kept.
   */
  private async buildScopedLocators(
    context: Page | Frame,
    el: DiscoveredElement,
    baseLocators: LocatorResult[],
  ): Promise<LocatorResult[]> {
    let ancestors: AncestorInfo[] = [];
    try {
      ancestors = parseAncestors(await context.evaluate(getAncestorProbeScript(el.nodeIndex!)));
    } catch {
      return [];
    }

    const candidates = this.scopedGenerator.generate(el, baseLocators, ancestors);
    if (candidates.length === 0) return [];

    await this.validator.validate(context, candidates, undefined, el.nodeIndex);
    return candidates
      .filter((c) => c.matchCount === 1 && c.resolvesToTarget === true)
      .slice(0, MAX_SCOPED_RESULTS);
  }

  /**
   * Gracefully shut down the agent (close browser etc).
   */
  async shutdown(): Promise<void> {
    await this.loader.close();
  }
}
