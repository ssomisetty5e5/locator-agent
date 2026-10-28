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
