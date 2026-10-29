// ============================================================
// Tests: multi-language page objects (TypeScript / Python / Java)
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { LocatorAgent } from '../src/agent';
import { parseExpression } from '../src/pageobject/expression';
import { toSnakeCase, translateExpression, renderPageObject, RenderContext } from '../src/pageobject/renderers';
import { generatePageObject } from '../src/pageobject';
import { ElementAnalysis, LocatorResult, PageAnalysis, DiscoveredElement } from '../src/types';

const FULL = `page.frameLocator("iframe#a").locator('tr').filter({ hasText: 'Invoice 1042' }).getByRole('button', { name: 'Delete' })`;

describe('parseExpression', () => {
  it('parses the chains the generators emit', () => {
    expect(parseExpression(FULL)).toEqual([
      { method: 'frameLocator', args: ['iframe#a'] },
      { method: 'locator', args: ['tr'] },
      { method: 'filter', args: [{ hasText: 'Invoice 1042' }] },
      { method: 'getByRole', args: ['button', { name: 'Delete' }] },
    ]);
  });

  it('handles escapes and calls without options', () => {
    expect(parseExpression("page.getByText('It\\'s')")).toEqual([{ method: 'getByText', args: ["It's"] }]);
    expect(parseExpression("page.getByRole('link')")).toEqual([{ method: 'getByRole', args: ['link'] }]);
  });

  it.each([
    'getByRole("x")', // not rooted at page
    "page.getByText('unterminated)", // bad string
    "page.getByText('a') extra", // trailing junk
    'page.getByText(foo)', // non-literal argument
    'page.', // empty chain
  ])('returns null for %s', (bad) => {
    expect(parseExpression(bad)).toBeNull();
  });
});

describe('translateExpression', () => {
  it('translates to Python', () => {
    expect(translateExpression(FULL, 'python')!.code).toBe(
      'page.frame_locator("iframe#a").locator("tr").filter(has_text="Invoice 1042").get_by_role("button", name="Delete")',
    );
    expect(translateExpression("page.getByPlaceholder('Email')", 'python')!.code).toBe('page.get_by_placeholder("Email")');
    expect(translateExpression("page.getByTestId('x')", 'python')!.code).toBe('page.get_by_test_id("x")');
  });

  it('translates to Java with the right options class for each receiver', () => {
    const java = translateExpression(FULL, 'java')!;
    expect(java.code).toBe(
      'page.frameLocator("iframe#a").locator("tr").filter(new Locator.FilterOptions().setHasText("Invoice 1042")).getByRole(AriaRole.BUTTON, new Locator.GetByRoleOptions().setName("Delete"))',
    );
    expect([...java.imports]).toContain('com.microsoft.playwright.options.AriaRole');

    // getByRole straight off the page uses Page.GetByRoleOptions; off a frame, FrameLocator.GetByRoleOptions
    expect(translateExpression("page.getByRole('link', { name: 'Go' })", 'java')!.code).toBe(
      'page.getByRole(AriaRole.LINK, new Page.GetByRoleOptions().setName("Go"))',
    );
    const inFrame = translateExpression("page.frameLocator(\"iframe#a\").getByRole('link', { name: 'Go' })", 'java')!;
    expect(inFrame.code).toContain('new FrameLocator.GetByRoleOptions()');
    expect([...inFrame.imports]).toContain('com.microsoft.playwright.FrameLocator');
  });

  it("falls back to the role selector engine for roles missing from Java's AriaRole", () => {
    expect(translateExpression("page.getByRole('made-up', { name: 'X' })", 'java')!.code).toBe(
      'page.locator("role=made-up[name=\\"X\\"]")',
    );
  });

  it('escapes quotes safely', () => {
    expect(translateExpression("page.getByText('say \"hi\"')", 'python')!.code).toBe('page.get_by_text("say \\"hi\\"")');
    expect(translateExpression("page.getByText('say \"hi\"')", 'java')!.code).toBe('page.getByText("say \\"hi\\"")');
  });

  it('refuses expressions it cannot translate', () => {
    expect(translateExpression('page.nth(2)', 'python')).toBeNull();
    expect(translateExpression('not an expression', 'java')).toBeNull();
  });
});

describe('toSnakeCase', () => {
  it('converts and guards keywords', () => {
    expect(toSnakeCase('emailAddressInput')).toBe('email_address_input');
    expect(toSnakeCase('deleteButtonInvoice1001')).toBe('delete_button_invoice1001');
    expect(toSnakeCase('import')).toBe('import_');
    expect(toSnakeCase('page')).toBe('page_');
  });
});

describe('renderPageObject', () => {
  const ctx: RenderContext = {
    className: 'LoginPage',
    title: 'Sign in',
    source: 'https://example.com/login',
    goto: true,
    importFrom: '@playwright/test',
    javaPackage: 'com.acme.pages',
    elements: [
      { name: 'emailInput', expression: "page.getByPlaceholder('Email')", verified: true },
      { name: 'saveButton', expression: "page.getByRole('button', { name: 'Save' })", verified: false },
    ],
  };

  it('renders Python', () => {
    const py = renderPageObject('python', { ...ctx, elements: ctx.elements.map((e) => ({ ...e, name: toSnakeCase(e.name) })) });
    expect(py).toBe(
      [
        'from playwright.sync_api import Locator, Page',
        '',
        '',
        'class LoginPage:',
        '    """Page object for "Sign in".',
        '    Source: https://example.com/login',
        '    Generated by LocatorAgent; locators were validated against the live page.',
        '    """',
        '',
        '    def __init__(self, page: Page) -> None:',
        '        self.page = page',
        '        self.email_input: Locator = page.get_by_placeholder("Email")',
        '        self.save_button: Locator = page.get_by_role("button", name="Save")  # TODO: not verified unique, check before relying on it',
        '',
        '    def goto(self) -> None:',
        '        self.page.goto("https://example.com/login")',
        '',
      ].join('\n'),
    );
  });

  it('renders Java', () => {
    expect(renderPageObject('java', ctx)).toBe(
      [
        'package com.acme.pages;',
        '',
        'import com.microsoft.playwright.Locator;',
        'import com.microsoft.playwright.Page;',
        'import com.microsoft.playwright.options.AriaRole;',
        '',
        '/**',
        ' * Page object for "Sign in".',
        ' * Source: https://example.com/login',
        ' * Generated by LocatorAgent; locators were validated against the live page.',
        ' */',
        'public class LoginPage {',
        '    private final Page page;',
        '    public final Locator emailInput;',
        '    public final Locator saveButton;',
        '',
        '    public LoginPage(Page page) {',
        '        this.page = page;',
        '        this.emailInput = page.getByPlaceholder("Email");',
        '        this.saveButton = page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Save")); // TODO: not verified unique, check before relying on it',
        '    }',
        '',
        '    public void navigate() {',
        '        page.navigate("https://example.com/login");',
        '    }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('keeps hostile titles from breaking comments or docstrings', () => {
    const nasty = { ...ctx, title: 'a */ b """ c \\u0041 d\n e' };
    for (const lang of ['typescript', 'python', 'java'] as const) {
      const out = renderPageObject(lang, nasty);
      expect(out).not.toContain('\\u0041');
      // Only the comment's own terminator may remain (none in Python)
      expect(out.split('*/').length - 1).toBe(lang === 'python' ? 0 : 1);
      // Only the docstring's own open/close pair may remain (Python only)
      expect(out.split('"""').length - 1).toBe(lang === 'python' ? 2 : 0);
    }
  });
});

describe('generatePageObject languages', () => {
  const el = (text: string): DiscoveredElement => ({
    uid: 'u', tag: 'button', text, attributes: {}, shadowDepth: 0, shadowHostChain: [], shadowHost: null, ariaRole: null,
    cssPathSegments: [], isInteractive: true, boundingBox: null, htmlSnippet: '', childCount: 0, nthOfType: 1, siblingsOfSameType: 1,
  });
  const loc = (over: Partial<LocatorResult>): LocatorResult => ({
    strategy: 'ariaRole', value: "getByRole('button', { name: 'Go' })", framework: 'playwright', score: 90, scoreReason: '',
    matchCount: 1, isUnique: true, resolvesToTarget: true, ...over,
  });
  const ea = (text: string, l: LocatorResult): ElementAnalysis => ({ element: el(text), locators: [l], recommended: l });
  const analysis = (elements: ElementAnalysis[]): PageAnalysis => ({
    source: 'inline-html', timestamp: '', pageTitle: 'Demo', totalDomElements: 0, interactiveElementsFound: elements.length,
    shadowRootsPierced: 0, elements,
  });

  it('names Python properties in snake_case and exposes per-language code', () => {
    const out = generatePageObject(analysis([ea('Log In', loc({}))]), { language: 'python' });
    expect(out.language).toBe('python');
    expect(out.elements[0].name).toBe('log_in_button');
    expect(out.elements[0].code).toBe('page.get_by_role("button", name="Go")');
    expect(out.elements[0].expression).toBe("page.getByRole('button', { name: 'Go' })");
    expect(out.code).toContain('self.log_in_button: Locator =');
  });

  it('translates plain css locators for Java', () => {
    const custom = ea('X', loc({ framework: 'css', strategy: 'css', value: 'button.x' }));
    const out = generatePageObject(analysis([custom]), { language: 'java' });
    expect(out.elements).toHaveLength(1);
    expect(out.elements[0].code).toBe('page.locator("button.x")');
  });

  it('rejects unsupported languages before doing any work', async () => {
    expect(() => generatePageObject(analysis([]), { language: 'cobol' as any })).toThrow(/Unsupported language/);
    const agent = new LocatorAgent();
    await expect(
      agent.generatePageObject({ html: '<button>x</button>' }, { language: 'cobol' as any }),
    ).rejects.toThrow(/Unsupported language/);
  });
});

// Optional: compile the generated Java against the real Playwright jar.
// Set LA_PLAYWRIGHT_JAR to the path of playwright-<version>.jar and have javac on PATH.
const jar = process.env.LA_PLAYWRIGHT_JAR;
describe.skipIf(!jar || !fs.existsSync(jar))('generated Java compiles (needs LA_PLAYWRIGHT_JAR + javac)', () => {
  it('compiles with javac', async () => {
    const agent = new LocatorAgent();
    try {
      const html = `<html><head><title>Sign in to Acme</title></head><body>
        <form><input type="email" name="email" placeholder="Email address">
        <button type="submit" id="login-btn">Log In</button><a href="/forgot">Forgot password?</a></form>
        <table><tbody><tr><td>Invoice 1001</td><td><button>Delete</button></td></tr>
        <tr><td>Invoice 1002</td><td><button>Delete</button></td></tr></tbody></table>
        <iframe id="pay" srcdoc="&lt;button&gt;Pay&lt;/button&gt;"></iframe></body></html>`;
      const result = await agent.generatePageObject({ html }, { language: 'java', javaPackage: 'gen' });

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-java-'));
      try {
        fs.mkdirSync(path.join(dir, 'gen'));
        const file = path.join(dir, 'gen', `${result.className}.java`);
        fs.writeFileSync(file, result.code);
        execFileSync('javac', ['-cp', jar!, '-d', path.join(dir, 'out'), file], { stdio: 'pipe' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await agent.shutdown();
    }
  }, 120_000);
});
