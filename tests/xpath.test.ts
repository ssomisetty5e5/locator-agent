// ============================================================
// Tests: XPath locators resolve and quote correctly
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LocatorAgent } from '../src/agent';
import { xpathLiteral } from '../src/util/stability';

describe('xpathLiteral', () => {
  it('uses single quotes by default', () => {
    expect(xpathLiteral('abc')).toBe("'abc'");
  });
  it('switches to double quotes when the value has an apostrophe', () => {
    expect(xpathLiteral("Don't")).toBe('"Don\'t"');
  });
  it('uses concat() when the value has both quote kinds', () => {
    expect(xpathLiteral(`a'b"c`)).toBe(`concat('a', "'", 'b"c')`);
  });
});

describe('XPath locators on real pages', () => {
  let agent: LocatorAgent;
  beforeAll(() => { agent = new LocatorAgent(); });
  afterAll(async () => { await agent.shutdown(); });

  it('absolute XPath is anchored at /html and hits the target', async () => {
    const html = `<html><body><ul>
      <li><button>Go</button></li>
      <li><button>Go</button></li>
    </ul></body></html>`;

    const result = await agent.analyze({ html });
    const buttons = result.elements.filter((e) => e.element.tag === 'button');
    expect(buttons).toHaveLength(2);

    for (const b of buttons) {
      const abs = b.locators.find((l) => l.strategy === 'xpath' && l.value.startsWith('/html/body'));
      expect(abs).toBeDefined();
      expect(abs!.matchCount).toBe(1);
      expect(abs!.resolvesToTarget).toBe(true);
    }
  }, 60_000);

  it('quotes text containing an apostrophe so the XPath is valid', async () => {
    const html = `<html><body><button>Don't save</button><button>Save</button></body></html>`;
    const result = await agent.analyze({ html });
    const btn = result.elements.find((e) => e.element.text === "Don't save")!;

    const byText = btn.locators.find((l) => l.strategy === 'xpath' && l.value.includes('normalize-space()='));
    expect(byText).toBeDefined();
    expect(byText!.matchCount).toBe(1);
    expect(byText!.resolvesToTarget).toBe(true);
  }, 60_000);

  it('does not emit a positional XPath for elements inside shadow DOM', async () => {
    const html = `<html><body><my-el id="h"></my-el><script>
      document.getElementById('h').attachShadow({ mode: 'open' }).innerHTML = '<button data-testid="sb">S</button>';
    </script></body></html>`;
    const result = await agent.analyze({ html });
    const btn = result.elements.find((e) => e.element.attributes['data-testid'] === 'sb')!;
    expect(btn.locators.some((l) => l.strategy === 'xpath' && l.value.startsWith('/html'))).toBe(false);
  }, 60_000);
});
