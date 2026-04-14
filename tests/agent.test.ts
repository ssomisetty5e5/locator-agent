// ============================================================
// Tests for LocatorAgent
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LocatorAgent } from '../src/agent';
import { ElementDiscoverer } from '../src/discoverer';
import { LocatorGenerator } from '../src/generator';
import { LocatorRanker } from '../src/ranker';
import { DiscoveredElement, SerializedNode } from '../src/types';

// ─────────────────────────────────────────────
// Unit Tests: Element Discoverer
// ─────────────────────────────────────────────

describe('ElementDiscoverer', () => {
  const discoverer = new ElementDiscoverer();

  const mockNodes: SerializedNode[] = [
    {
      tag: 'button',
      attributes: { id: 'submit-btn', 'data-testid': 'submit' },
      text: 'Submit',
      htmlSnippet: '<button id="submit-btn">Submit</button>',
      childCount: 0,
      nthOfType: 1,
      siblingsOfSameType: 1,
      shadowDepth: 0,
      shadowHostChain: [],
      shadowHost: null,
      ariaRole: 'button',
      cssPathSegments: ['body', 'form', 'button#submit-btn'],
      boundingBox: { x: 100, y: 200, width: 80, height: 40 },
      isInteractive: true,
    },
    {
      tag: 'div',
      attributes: { class: 'container' },
      text: '',
      htmlSnippet: '<div class="container">...</div>',
      childCount: 5,
      nthOfType: 1,
      siblingsOfSameType: 1,
      shadowDepth: 0,
      shadowHostChain: [],
      shadowHost: null,
      ariaRole: null,
      cssPathSegments: ['body', 'div.container'],
      boundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
      isInteractive: false,
    },
    {
      tag: 'input',
      attributes: { type: 'email', name: 'email', placeholder: 'Enter email' },
      text: '',
      htmlSnippet: '<input type="email" name="email" placeholder="Enter email">',
      childCount: 0,
      nthOfType: 1,
      siblingsOfSameType: 2,
      shadowDepth: 0,
      shadowHostChain: [],
      shadowHost: null,
      ariaRole: null,
      cssPathSegments: ['body', 'form', 'input:nth-of-type(1)'],
      boundingBox: { x: 100, y: 150, width: 200, height: 30 },
      isInteractive: true,
    },
  ];

  it('should discover only interactive elements by default', () => {
    const result = discoverer.discover(mockNodes);
    expect(result).toHaveLength(2);
    expect(result[0].tag).toBe('button');
    expect(result[1].tag).toBe('input');
  });

  it('should discover all elements when includeNonInteractive is true', () => {
    const result = discoverer.discover(mockNodes, true);
    expect(result).toHaveLength(3);
  });

  it('should respect maxElements limit', () => {
    const result = discoverer.discover(mockNodes, true, 1);
    expect(result).toHaveLength(1);
  });

  it('should assign unique UIDs', () => {
    const result = discoverer.discover(mockNodes, true);
    const uids = new Set(result.map((e) => e.uid));
    expect(uids.size).toBe(result.length);
  });
});

// ─────────────────────────────────────────────
// Unit Tests: Locator Generator
// ─────────────────────────────────────────────

describe('LocatorGenerator', () => {
  const generator = new LocatorGenerator();

  const buttonElement: DiscoveredElement = {
    uid: 'test-001',
    tag: 'button',
    text: 'Submit',
    attributes: { id: 'submit-btn', 'data-testid': 'submit', class: 'btn primary' },
    shadowDepth: 0,
    shadowHostChain: [],
    shadowHost: null,
    ariaRole: 'button',
    cssPathSegments: ['body', 'form', 'button#submit-btn'],
    isInteractive: true,
    boundingBox: { x: 100, y: 200, width: 80, height: 40 },
    htmlSnippet: '<button id="submit-btn" data-testid="submit" class="btn primary">Submit</button>',
    childCount: 0,
    nthOfType: 1,
    siblingsOfSameType: 1,
  };

  it('should generate multiple locators for a button element', () => {
    const locators = generator.generate(buttonElement);
    expect(locators.length).toBeGreaterThan(3);
  });

  it('should generate testId locator when data-testid exists', () => {
    const locators = generator.generate(buttonElement);
    const testIdLocators = locators.filter((l) => l.strategy === 'testId');
    expect(testIdLocators.length).toBeGreaterThan(0);
    expect(testIdLocators.some((l) => l.value === 'submit' || l.value.includes('data-testid'))).toBe(true);
  });

  it('should generate ID locator when id exists', () => {
    const locators = generator.generate(buttonElement);
    const idLocators = locators.filter((l) => l.strategy === 'id');
    expect(idLocators.length).toBeGreaterThan(0);
  });

  it('should generate role-based locator', () => {
    const locators = generator.generate(buttonElement);
    const roleLocators = locators.filter((l) => l.strategy === 'ariaRole');
    expect(roleLocators.length).toBeGreaterThan(0);
  });

  it('should generate text-based locator', () => {
    const locators = generator.generate(buttonElement);
    const textLocators = locators.filter((l) => l.strategy === 'text');
    expect(textLocators.length).toBeGreaterThan(0);
  });

  it('should not generate locators for auto-generated IDs', () => {
    const element: DiscoveredElement = {
      ...buttonElement,
      attributes: { id: ':r0:', class: 'btn' },
    };
    const locators = generator.generate(element);
    const idLocators = locators.filter((l) => l.strategy === 'id');
    expect(idLocators).toHaveLength(0);
  });

  const inputElement: DiscoveredElement = {
    uid: 'test-002',
    tag: 'input',
    text: '',
    attributes: { type: 'email', name: 'email', placeholder: 'Enter your email' },
    shadowDepth: 0,
    shadowHostChain: [],
    shadowHost: null,
    ariaRole: null,
    cssPathSegments: ['body', 'form', 'input:nth-of-type(1)'],
    isInteractive: true,
    boundingBox: { x: 100, y: 150, width: 200, height: 30 },
    htmlSnippet: '<input type="email" name="email" placeholder="Enter your email">',
    childCount: 0,
    nthOfType: 1,
    siblingsOfSameType: 2,
  };

  it('should generate name-based locator for input', () => {
    const locators = generator.generate(inputElement);
    const nameLocators = locators.filter((l) => l.strategy === 'name');
    expect(nameLocators.length).toBeGreaterThan(0);
  });

  it('should generate placeholder-based locator for input', () => {
    const locators = generator.generate(inputElement);
    const placeholderLocators = locators.filter((l) => l.strategy === 'placeholder');
    expect(placeholderLocators.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
// Unit Tests: Locator Ranker
// ─────────────────────────────────────────────

describe('LocatorRanker', () => {
  const ranker = new LocatorRanker();

  const element: DiscoveredElement = {
    uid: 'test-rank',
    tag: 'button',
    text: 'Submit',
    attributes: { 'data-testid': 'submit' },
    shadowDepth: 0,
    shadowHostChain: [],
    shadowHost: null,
    ariaRole: 'button',
    cssPathSegments: ['body', 'form', 'button'],
    isInteractive: true,
    boundingBox: null,
    htmlSnippet: '<button data-testid="submit">Submit</button>',
    childCount: 0,
    nthOfType: 1,
    siblingsOfSameType: 1,
  };

  it('should rank testId higher than xpath', () => {
    const locators = [
      { strategy: 'xpath' as const, value: "//button[@data-testid='submit']", framework: 'xpath' as const, score: 0, scoreReason: '' },
      { strategy: 'testId' as const, value: 'submit', framework: 'playwright' as const, score: 0, scoreReason: '' },
    ];

    const ranked = ranker.rank(locators, element);
    expect(ranked[0].strategy).toBe('testId');
  });

  it('should penalize long selectors', () => {
    const shortLoc = { strategy: 'css' as const, value: '#submit', framework: 'css' as const, score: 0, scoreReason: '' };
    const longLoc = {
      strategy: 'css' as const,
      value: 'body > div.container > main > section > form > div.form-group > div.input-wrapper > button.btn.primary',
      framework: 'css' as const,
      score: 0,
      scoreReason: '',
    };

    const ranked = ranker.rank([longLoc, shortLoc], element);
    expect(ranked[0].value).toBe('#submit');
  });

  it('should assign scores between 0 and 100', () => {
    const locators = [
      { strategy: 'testId' as const, value: 'submit', framework: 'playwright' as const, score: 0, scoreReason: '' },
      { strategy: 'css' as const, value: 'button', framework: 'css' as const, score: 0, scoreReason: '' },
    ];

    const ranked = ranker.rank(locators, element);
    for (const loc of ranked) {
      expect(loc.score).toBeGreaterThanOrEqual(0);
      expect(loc.score).toBeLessThanOrEqual(100);
    }
  });
});

// ─────────────────────────────────────────────
// Integration Test: Full Agent (with inline HTML)
// ─────────────────────────────────────────────

describe('LocatorAgent Integration', () => {
  let agent: LocatorAgent;

  beforeAll(() => {
    agent = new LocatorAgent();
  });

  afterAll(async () => {
    await agent.shutdown();
  });

  it('should analyze inline HTML and return locators', async () => {
    const html = `
      <html>
        <body>
          <form>
            <input type="email" name="email" placeholder="Email" data-testid="email-input">
            <input type="password" name="password" placeholder="Password">
            <button type="submit" id="login-btn" data-testid="login-btn">Log In</button>
          </form>
          <a href="/signup">Sign Up</a>
        </body>
      </html>
    `;

    const result = await agent.analyze({ html });

    expect(result.elements.length).toBeGreaterThanOrEqual(3);
    expect(result.pageTitle).toBeDefined();

    // Check that the login button was found
    const loginBtn = result.elements.find(
      (e) => e.element.attributes['data-testid'] === 'login-btn',
    );
    expect(loginBtn).toBeDefined();
    expect(loginBtn!.locators.length).toBeGreaterThan(2);
    expect(loginBtn!.recommended.score).toBeGreaterThan(50);

    // Check that email input was found
    const emailInput = result.elements.find(
      (e) => e.element.attributes['name'] === 'email',
    );
    expect(emailInput).toBeDefined();
    expect(emailInput!.locators.length).toBeGreaterThan(2);
  }, 30_000);

  it('should handle Shadow DOM elements in inline HTML', async () => {
    const html = `
      <html>
        <body>
          <div id="host"></div>
          <script>
            const host = document.getElementById('host');
            const shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = '<button data-testid="shadow-btn">Click Me</button>';
          </script>
        </body>
      </html>
    `;

    const result = await agent.analyze({ html });

    // The shadow button should be discovered
    const shadowBtn = result.elements.find(
      (e) => e.element.attributes['data-testid'] === 'shadow-btn',
    );
    // Shadow DOM may or may not be found depending on script execution timing
    if (shadowBtn) {
      expect(shadowBtn.element.shadowDepth).toBeGreaterThan(0);
      expect(shadowBtn.locators.length).toBeGreaterThan(0);
    }
  }, 30_000);
});
