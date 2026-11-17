// ============================================================
// Integration tests: locators are checked against the live page,
// including Shadow DOM and "right element, not just any element".
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LocatorAgent } from '../src/agent';

describe('Live validation', () => {
  let agent: LocatorAgent;

  beforeAll(() => {
    agent = new LocatorAgent();
  });

  afterAll(async () => {
    await agent.shutdown();
  });

  it('verifies shadow-piercing locators resolve to the target element', async () => {
    const html = `
      <html><body>
        <my-card id="card"></my-card>
        <script>
          const shadow = document.getElementById('card').attachShadow({ mode: 'open' });
          shadow.innerHTML = '<button data-testid="shadow-btn">Click Me</button>';
        </script>
      </body></html>`;

    const result = await agent.analyze({ html });
    const btn = result.elements.find((e) => e.element.attributes['data-testid'] === 'shadow-btn');

    expect(btn).toBeDefined();
    expect(btn!.element.shadowDepth).toBeGreaterThan(0);

    const shadowLocators = btn!.locators.filter((l) => l.strategy === 'shadowPiercingCss' && l.framework === 'playwright');
    expect(shadowLocators.length).toBeGreaterThan(0);
    for (const l of shadowLocators) {
      expect(l.matchCount).toBe(1);
      expect(l.resolvesToTarget).toBe(true);
    }
  }, 30_000);

  it('counts plain CSS both ways: querySelectorAll, and Playwright\'s shadow-piercing locator()', async () => {
    const html = `
      <html><body>
        <button class="go">Top</button>
        <my-card id="card"></my-card>
        <script>
          const shadow = document.getElementById('card').attachShadow({ mode: 'open' });
          shadow.innerHTML = '<button class="go">Inside</button><button class="only-inside">Only</button>';
        </script>
      </body></html>`;

    const result = await agent.analyze({ html });
    const css = (e: (typeof result.elements)[number], value: string) =>
      e.locators.find((l) => l.framework === 'css' && l.value === value);

    const inside = result.elements.find((e) => e.element.text === 'Inside')!;
    const only = result.elements.find((e) => e.element.text === 'Only')!;
    const top = result.elements.find((e) => e.element.text === 'Top')!;

    // button.go: one in the top-level document, two once shadow roots are searched
    const goTop = css(top, 'button.go');
    expect(goTop).toBeDefined();
    expect(goTop!.matchCount).toBe(1);
    expect(goTop!.deepMatchCount).toBe(2);
    expect(goTop!.deepResolvesToTarget).toBe(true);

    // button.only-inside: invisible to querySelectorAll, found by Playwright
    const onlyInside = css(only, 'button.only-inside');
    expect(onlyInside).toBeDefined();
    expect(onlyInside!.matchCount).toBe(0);
    expect(onlyInside!.deepMatchCount).toBe(1);
    expect(onlyInside!.deepResolvesToTarget).toBe(true);

    expect(css(inside, 'button.go')?.deepMatchCount).toBe(2);
  }, 30_000);

  it('treats a Playwright CSS selector as shadow-piercing', async () => {
    const html = `
      <html><body>
        <my-card id="card"></my-card>
        <script>
          const shadow = document.getElementById('card').attachShadow({ mode: 'open' });
          shadow.innerHTML = '<input id="deep-input" />';
        </script>
      </body></html>`;
    const { chromium } = await import('playwright');
    const { LocatorValidator } = await import('../src/validator/locatorValidator');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      const locators = [
        { strategy: 'css', framework: 'playwright', value: '#deep-input', score: 50, scoreReason: '' },
        { strategy: 'css', framework: 'css', value: '#deep-input', score: 50, scoreReason: '' },
      ] as import('../src/types').LocatorResult[];
      await new LocatorValidator().validate(page, locators);
      expect(locators[0].matchCount).toBe(1); // page.locator('#deep-input') finds it
      expect(locators[1].matchCount).toBe(0); // document.querySelectorAll does not
      expect(locators[1].deepMatchCount).toBe(1);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it('flags non-unique locators and recommends a unique one', async () => {
    const html = `
      <html><body>
        <button class="btn">Save</button>
        <button class="btn" data-testid="cancel">Cancel</button>
      </body></html>`;

    const result = await agent.analyze({ html });
    const cancel = result.elements.find((e) => e.element.attributes['data-testid'] === 'cancel');
    expect(cancel).toBeDefined();

    const sharedClass = cancel!.locators.find((l) => l.value === 'button.btn');
    expect(sharedClass?.matchCount).toBe(2);
    expect(sharedClass?.resolvesToTarget).toBe(true);

    expect(cancel!.recommended.matchCount).toBe(1);
    expect(cancel!.recommended.resolvesToTarget).toBe(true);
  }, 30_000);

  it('does not recommend ids that look auto-generated', async () => {
    const html = `
      <html><body>
        <input id="mat-input-4" name="email" placeholder="Email">
      </body></html>`;

    const result = await agent.analyze({ html });
    const input = result.elements.find((e) => e.element.attributes['name'] === 'email');
    expect(input).toBeDefined();
    expect(input!.locators.some((l) => l.strategy === 'id')).toBe(false);
    expect(input!.recommended.value).not.toContain('mat-input-4');
  }, 30_000);

  it('handles attribute values containing quotes without breaking the selector', async () => {
    const html = `
      <html><body>
        <input name='say "hi"' placeholder="Msg">
      </body></html>`;

    const result = await agent.analyze({ html });
    const input = result.elements.find((e) => e.element.tag === 'input');
    expect(input).toBeDefined();

    const byName = input!.locators.find((l) => l.strategy === 'css' && l.value.includes('[name='));
    expect(byName).toBeDefined();
    expect(byName!.matchCount).toBe(1);
    expect(byName!.resolvesToTarget).toBe(true);
  }, 30_000);
});
