// ============================================================
// Tests: page object generation (naming, expressions, and a
// compile-and-run check of the generated class)
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { chromium, Browser } from 'playwright';
import { LocatorAgent } from '../src/agent';
import { baseName, elementKind, nameElements } from '../src/pageobject/elementNamer';
import { deriveClassName, generatePageObject, toPlaywrightExpression } from '../src/pageobject';
import { DiscoveredElement, ElementAnalysis, LocatorResult, PageAnalysis } from '../src/types';

const el = (over: Partial<DiscoveredElement>): DiscoveredElement => ({
  uid: 'u', tag: 'button', text: '', attributes: {}, shadowDepth: 0, shadowHostChain: [], shadowHost: null,
  ariaRole: null, cssPathSegments: [], isInteractive: true, boundingBox: null, htmlSnippet: '',
  childCount: 0, nthOfType: 1, siblingsOfSameType: 1, ...over,
});

const loc = (over: Partial<LocatorResult>): LocatorResult => ({
  strategy: 'ariaRole', value: "getByRole('button', { name: 'Go' })", framework: 'playwright',
  score: 90, scoreReason: '', matchCount: 1, isUnique: true, resolvesToTarget: true, ...over,
});

const analysisOf = (elements: ElementAnalysis[], over: Partial<PageAnalysis> = {}): PageAnalysis => ({
  source: 'inline-html', timestamp: '', pageTitle: 'Demo', totalDomElements: 0, interactiveElementsFound: elements.length,
  shadowRootsPierced: 0, elements, ...over,
});

const analysis = (element: DiscoveredElement, locators: LocatorResult[]): ElementAnalysis => ({
  element, locators, recommended: locators[0],
});

describe('element naming', () => {
  it('names by label and control kind', () => {
    expect(baseName(el({ text: 'Log In' }))).toBe('logInButton');
    expect(baseName(el({ tag: 'input', attributes: { type: 'email', name: 'email' } }))).toBe('emailInput');
    expect(baseName(el({ tag: 'a', text: 'Sign Up', attributes: { href: '/signup' } }))).toBe('signUpLink');
    expect(baseName(el({ tag: 'input', attributes: { type: 'checkbox', id: 'remember-me' } }))).toBe('rememberMeCheckbox');
    expect(baseName(el({ tag: 'select', attributes: { name: 'country' } }))).toBe('countrySelect');
  });

  it("doesn't repeat the kind and never starts with a digit or a reserved word", () => {
    expect(baseName(el({ attributes: { 'data-testid': 'submit-button' } }))).toBe('submitButton');
    expect(baseName(el({ text: '2024 Report' }))).toMatch(/^[a-z]/);
    expect(baseName(el({ tag: 'a', text: 'Page', attributes: { href: '/p' } }))).not.toBe('page');
    expect(baseName(el({ text: 'Delete' }))).toBe('deleteButton');
  });

  it('ignores placeholders that are sample data rather than labels', () => {
    const input = (attributes: Record<string, string>) => baseName(el({ tag: 'input', attributes }));
    expect(input({ type: 'email', id: 'email', name: 'email', placeholder: 'you@example.com' })).toBe('emailInput');
    expect(input({ name: 'site', placeholder: 'https://example.com' })).toBe('siteInput');
    // a real label-style placeholder still wins
    expect(input({ name: 'q', placeholder: 'Search products' })).toBe('searchProductsInput');
  });

  it('classifies kinds', () => {
    expect(elementKind(el({ tag: 'input', attributes: { type: 'submit' } }))).toBe('Button');
    expect(elementKind(el({ tag: 'div', ariaRole: 'tab' }))).toBe('Tab');
    expect(elementKind(el({ tag: 'div' }))).toBe('Element');
  });

  it('makes duplicates unique using scope text, else a counter', () => {
    const scoped = (hasText: string) =>
      analysis(el({ text: 'Delete' }), [loc({ strategy: 'scoped', scope: { css: 'tr', hasText, inner: 'x' } })]);
    const plain = () => analysis(el({ text: 'Save' }), [loc({})]);

    const names = nameElements([scoped('Invoice 1001'), scoped('Invoice 1002'), plain(), plain()]);
    expect(names).toEqual(['deleteButtonInvoice1001', 'deleteButtonInvoice1002', 'saveButton1', 'saveButton2']);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('toPlaywrightExpression', () => {
  it('roots semantic, css and xpath locators at page', () => {
    expect(toPlaywrightExpression(loc({}))).toBe("page.getByRole('button', { name: 'Go' })");
    expect(toPlaywrightExpression(loc({ strategy: 'css', framework: 'css', value: "button[name='a']" })))
      .toBe("page.locator('button[name=\\'a\\']')");
    expect(toPlaywrightExpression(loc({ strategy: 'xpath', framework: 'xpath', value: '//button[1]' })))
      .toBe("page.locator('xpath=//button[1]')");
  });

  it('prefixes iframe chains and keeps scoped chains intact', () => {
    const scoped = loc({
      strategy: 'scoped', value: "locator('li').filter({ hasText: 'A' }).getByRole('button')", framePath: ['iframe#x'],
    });
    expect(toPlaywrightExpression(scoped))
      .toBe(`page.frameLocator("iframe#x").locator('li').filter({ hasText: 'A' }).getByRole('button')`);
  });

  it('rejects locators Playwright cannot run', () => {
    expect(toPlaywrightExpression(loc({ framework: 'selenium', strategy: 'id', value: 'x' }))).toBeNull();
    expect(toPlaywrightExpression(loc({ framework: 'webdriverio', value: "$('a')" }))).toBeNull();
    expect(toPlaywrightExpression(loc({ strategy: 'shadowPiercingCss', framework: 'css', value: 'a >>> b' }))).toBeNull();
    expect(toPlaywrightExpression(loc({ strategy: 'shadowPiercingCss', framework: 'javascript', value: "document.querySelector('a')" }))).toBeNull();
  });
});

describe('generatePageObject', () => {
  it('derives the class name from title, then URL', () => {
    expect(deriveClassName(analysisOf([], { pageTitle: 'Sign in to Acme' }))).toBe('SignInToAcmePage');
    expect(deriveClassName(analysisOf([], { pageTitle: '', source: 'https://example.com/account/settings' }))).toBe('SettingsPage');
    expect(deriveClassName(analysisOf([], { pageTitle: '', source: 'inline-html' }))).toBe('GeneratedPage');
  });

  it('prefers a verified locator over a higher-scored unverified one, and flags unverified ones', () => {
    const e = analysis(el({ text: 'Go' }), [
      loc({ value: "getByRole('button', { name: 'Go' })", score: 95, matchCount: 3, isUnique: false }),
      loc({ strategy: 'css', framework: 'css', value: '#go', score: 70 }),
    ]);
    const out = generatePageObject(analysisOf([e]));
    expect(out.code).toContain("this.goButton = page.locator('#go');");
    expect(out.elements[0].verified).toBe(true);

    const onlyBad = analysis(el({ text: 'Go' }), [loc({ matchCount: 3, isUnique: false })]);
    const bad = generatePageObject(analysisOf([onlyBad]));
    expect(bad.code).toContain('// TODO: not verified unique');
    expect(bad.elements[0].verified).toBe(false);
  });

  it('prefers a descriptive verified locator over a bare role locator, unless it trails by too much', () => {
    const bare = loc({ value: "getByRole('textbox')", score: 92 });
    const placeholder = loc({ strategy: 'placeholder', value: "getByPlaceholder('Email')", score: 80 });
    const weak = loc({ strategy: 'xpath', framework: 'xpath', value: '//input[1]', score: 40 });

    const input = el({ tag: 'input', attributes: { placeholder: 'Email' } });
    const picks = (locators: LocatorResult[]) =>
      generatePageObject(analysisOf([{ element: input, locators, recommended: locators[0] }])).elements[0].expression;

    expect(picks([bare, placeholder])).toBe("page.getByPlaceholder('Email')");
    expect(picks([bare, weak])).toBe("page.getByRole('textbox')");
  });

  it('adds goto() only for URL sources and honours options', () => {
    const e = analysis(el({ text: 'Go' }), [loc({})]);
    const url = generatePageObject(analysisOf([e], { source: 'https://example.com/x?a=1' }), { className: 'My Page!' });
    expect(url.className).toBe('MyPage');
    expect(url.code).toContain("await this.page.goto('https://example.com/x?a=1');");
    expect(url.code).toContain("import type { Page, Locator } from '@playwright/test';");

    expect(generatePageObject(analysisOf([e])).code).not.toContain('goto');
    expect(generatePageObject(analysisOf([e], { source: 'https://example.com' }), { noGoto: true }).code).not.toContain('goto');
    expect(generatePageObject(analysisOf([e]), { importFrom: 'playwright' }).code).toContain("from 'playwright'");
  });

  it('skips elements with no Playwright-expressible locator, low scores and duplicate locators', () => {
    const seleniumOnly = analysis(el({ text: 'A' }), [loc({ framework: 'selenium', strategy: 'id', value: 'a' })]);
    const low = analysis(el({ text: 'B' }), [loc({ score: 10 })]);
    const first = analysis(el({ text: 'C' }), [loc({ value: "getByText('C')" })]);
    const dup = analysis(el({ text: 'C2' }), [loc({ value: "getByText('C')" })]);

    const out = generatePageObject(analysisOf([seleniumOnly, low, first, dup]), { minScore: 50 });
    expect(out.elements.map((x) => x.name)).toEqual(['cButton']);
    expect(out.skipped).toBe(3);
  });
});

describe('generated page object (compile and run)', () => {
  const html = `<html><head><title>Sign in to Acme</title></head><body>
    <form>
      <input type="email" name="email" placeholder="Email address">
      <input type="password" name="password" placeholder="Password">
      <label><input type="checkbox" id="remember-me"> Remember me</label>
      <button type="submit" id="login-btn">Log In</button>
      <a href="/forgot">Forgot password?</a>
    </form>
    <table><tbody>
      <tr><td>Invoice 1001</td><td><button>Delete</button></td></tr>
      <tr><td>Invoice 1002</td><td><button>Delete</button></td></tr>
    </tbody></table>
  </body></html>`;

  const tmpDir = path.join(__dirname, '.tmp-pageobject');
  let agent: LocatorAgent;
  let browser: Browser;

  beforeAll(async () => {
    agent = new LocatorAgent();
    browser = await chromium.launch({ headless: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(async () => {
    await agent.shutdown();
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('type-checks and every property resolves to exactly one element', async () => {
    const result = await agent.generatePageObject({ html }, { importFrom: 'playwright' });
    expect(result.className).toBe('SignInToAcmePage');

    const names = result.elements.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('emailAddressInput');
    expect(names).toContain('logInButton');
    expect(names).toContain('deleteButtonInvoice1001');
    expect(names).toContain('deleteButtonInvoice1002');
    expect(result.elements.every((e) => e.verified)).toBe(true);

    // 1) The generated file must type-check under strict mode
    const file = path.join(tmpDir, 'generated.ts');
    fs.writeFileSync(file, result.code);
    const program = ts.createProgram([file], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10, skipLibCheck: true, types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diagnostics).toEqual([]);

    // 2) ...and behave against the real page
    const js = ts.transpileModule(result.code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod: { exports: Record<string, any> } = { exports: {} };
    new Function('exports', 'module', js)(mod.exports, mod);
    const PageObject = mod.exports[result.className];

    const page = await browser.newPage();
    await page.setContent(html);
    const po = new PageObject(page);

    for (const name of names) {
      expect(await po[name].count(), `${name} should match exactly one element`).toBe(1);
    }

    await po.emailAddressInput.fill('a@b.co');
    expect(await po.emailAddressInput.inputValue()).toBe('a@b.co');
    await po.rememberMeCheckbox.check();
    expect(await po.rememberMeCheckbox.isChecked()).toBe(true);
    expect(await po.deleteButtonInvoice1002.evaluate((b: any) => b.closest('tr').textContent)).toContain('1002');
    await page.close();
  }, 120_000);
});
