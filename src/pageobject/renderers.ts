// ============================================================
// Language renderers
// Turn the (language-neutral) list of named locator expressions into a
// page object class for TypeScript, Python or Java Playwright.
// ============================================================

import { CallStep, parseExpression } from './expression';

export type PageObjectLanguage = 'typescript' | 'python' | 'java';

export const LANGUAGES: PageObjectLanguage[] = ['typescript', 'python', 'java'];

export interface RenderElement {
  name: string;
  /** Playwright TypeScript expression rooted at `page` */
  expression: string;
  verified: boolean;
}

export interface RenderContext {
  className: string;
  /** Page title, may be empty */
  title: string;
  source: string;
  /** True when `source` is an http(s) URL (a goto method is generated) */
  goto: boolean;
  /** TypeScript only: module to import types from */
  importFrom: string;
  /** Java only: package declaration */
  javaPackage?: string;
  elements: RenderElement[];
}

interface Translation {
  code: string;
  /** Extra imports the translated code needs (Java: AriaRole, FrameLocator) */
  imports: Set<string>;
}

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'self', 'page',
]);

/** Java's AriaRole enum constants (com.microsoft.playwright.options.AriaRole). */
const JAVA_ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox',
  'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory',
  'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img',
  'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph',
  'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar',
  'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript',
  'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree',
  'treegrid', 'treeitem',
]);

/** String literal valid in Python, Java and JS (JSON escapes are a subset of all three). */
const str = (s: string): string => JSON.stringify(s);

const stringArg = (step: CallStep, i = 0): string | null => {
  const a = step.args[i];
  return typeof a === 'string' ? a : null;
};

const objectArg = (step: CallStep, i: number): Record<string, string> | null => {
  const a = step.args[i];
  return a && typeof a === 'object' ? a : null;
};

/** `snake_case` property name for Python; avoids keywords and `page`. */
export function toSnakeCase(name: string): string {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return PYTHON_KEYWORDS.has(snake) ? `${snake}_` : snake;
}

/** Property name in the target language. */
export function propertyName(name: string, language: PageObjectLanguage): string {
  return language === 'python' ? toSnakeCase(name) : name;
}

/**
 * Translate a TypeScript Playwright expression into `language`.
 * Returns null when the expression uses something we can't express there.
 */
export function translateExpression(expression: string, language: PageObjectLanguage): Translation | null {
  if (language === 'typescript') return { code: expression, imports: new Set() };

  const steps = parseExpression(expression);
  if (!steps) return null;

  return language === 'python' ? toPython(steps) : toJava(steps);
}

function toPython(steps: CallStep[]): Translation | null {
  const parts: string[] = [];

  for (const step of steps) {
    const arg0 = stringArg(step);
    switch (step.method) {
      case 'getByRole': {
        if (arg0 === null) return null;
        const opts = objectArg(step, 1);
        const name = opts?.name;
        parts.push(name !== undefined ? `get_by_role(${str(arg0)}, name=${str(name)})` : `get_by_role(${str(arg0)})`);
        break;
      }
      case 'getByText': if (arg0 === null) return null; parts.push(`get_by_text(${str(arg0)})`); break;
      case 'getByLabel': if (arg0 === null) return null; parts.push(`get_by_label(${str(arg0)})`); break;
      case 'getByPlaceholder': if (arg0 === null) return null; parts.push(`get_by_placeholder(${str(arg0)})`); break;
      case 'getByTestId': if (arg0 === null) return null; parts.push(`get_by_test_id(${str(arg0)})`); break;
      case 'locator': if (arg0 === null) return null; parts.push(`locator(${str(arg0)})`); break;
      case 'frameLocator': if (arg0 === null) return null; parts.push(`frame_locator(${str(arg0)})`); break;
      case 'filter': {
        const opts = objectArg(step, 0);
        if (!opts || opts.hasText === undefined) return null;
        parts.push(`filter(has_text=${str(opts.hasText)})`);
        break;
      }
      default:
        return null;
    }
  }
  return { code: `page.${parts.join('.')}`, imports: new Set() };
}

function toJava(steps: CallStep[]): Translation | null {
  const imports = new Set<string>();
  const parts: string[] = [];
  // The receiver's type decides which nested Options class Java needs
  let receiver: 'Page' | 'Locator' | 'FrameLocator' = 'Page';

  for (const step of steps) {
    const arg0 = stringArg(step);
    switch (step.method) {
      case 'getByRole': {
        if (arg0 === null) return null;
        const name = objectArg(step, 1)?.name;
        if (JAVA_ARIA_ROLES.has(arg0)) {
          imports.add('com.microsoft.playwright.options.AriaRole');
          const role = `AriaRole.${arg0.toUpperCase()}`;
          parts.push(
            name !== undefined
              ? `getByRole(${role}, new ${receiver}.GetByRoleOptions().setName(${str(name)}))`
              : `getByRole(${role})`,
          );
        } else {
          // Roles missing from the Java enum still work through the role selector engine
          const selector = name !== undefined ? `role=${arg0}[name=${str(name)}]` : `role=${arg0}`;
          parts.push(`locator(${str(selector)})`);
        }
        receiver = 'Locator';
        break;
      }
      case 'getByText': if (arg0 === null) return null; parts.push(`getByText(${str(arg0)})`); receiver = 'Locator'; break;
      case 'getByLabel': if (arg0 === null) return null; parts.push(`getByLabel(${str(arg0)})`); receiver = 'Locator'; break;
      case 'getByPlaceholder': if (arg0 === null) return null; parts.push(`getByPlaceholder(${str(arg0)})`); receiver = 'Locator'; break;
      case 'getByTestId': if (arg0 === null) return null; parts.push(`getByTestId(${str(arg0)})`); receiver = 'Locator'; break;
      case 'locator': if (arg0 === null) return null; parts.push(`locator(${str(arg0)})`); receiver = 'Locator'; break;
      case 'frameLocator':
        if (arg0 === null) return null;
        parts.push(`frameLocator(${str(arg0)})`);
        receiver = 'FrameLocator';
        break;
      case 'filter': {
        const opts = objectArg(step, 0);
        if (!opts || opts.hasText === undefined) return null;
        parts.push(`filter(new Locator.FilterOptions().setHasText(${str(opts.hasText)}))`);
        receiver = 'Locator';
        break;
      }
      default:
        return null;
    }
  }

  // FrameLocator is only needed by name when a getByRole options class is qualified with it
  if (parts.some((p) => p.includes('FrameLocator.GetByRoleOptions'))) {
    imports.add('com.microsoft.playwright.FrameLocator');
  }
  return { code: `page.${parts.join('.')}`, imports };
}

const TODO_TEXT = 'TODO: not verified unique, check before relying on it';

/**
 * Title safe to put in a doc comment or docstring in any language: no comment
 * terminators, triple quotes, newlines, or backslashes (javac processes \u
 * escapes even inside comments).
 */
const safeComment = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\*\//g, '* /')
    .replace(/"""/g, "'''")
    .replace(/\\/g, '/')
    .trim();

const describe = (ctx: RenderContext): string => {
  const title = safeComment(ctx.title);
  return title ? `"${title}"` : 'the analyzed page';
};

export function renderPageObject(language: PageObjectLanguage, ctx: RenderContext): string {
  switch (language) {
    case 'python': return renderPython(ctx);
    case 'java': return renderJava(ctx);
    default: return renderTypeScript(ctx);
  }
}

function renderTypeScript(ctx: RenderContext): string {
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  const lines: string[] = [];
  lines.push(`import type { Page, Locator } from ${q(ctx.importFrom)};`);
  lines.push('');
  lines.push('/**');
  lines.push(` * Page object for ${describe(ctx)}.`);
  if (ctx.goto) lines.push(` * Source: ${safeComment(ctx.source)}`);
  lines.push(' * Generated by LocatorAgent; locators were validated against the live page.');
  lines.push(' */');
  lines.push(`export class ${ctx.className} {`);
  lines.push('  readonly page: Page;');
  for (const e of ctx.elements) lines.push(`  readonly ${e.name}: Locator;`);
  lines.push('');
  lines.push('  constructor(page: Page) {');
  lines.push('    this.page = page;');
  for (const e of ctx.elements) {
    lines.push(`    this.${e.name} = ${e.expression};${e.verified ? '' : ` // ${TODO_TEXT}`}`);
  }
  lines.push('  }');
  if (ctx.goto) {
    lines.push('');
    lines.push('  async goto(): Promise<void> {');
    lines.push(`    await this.page.goto(${q(ctx.source)});`);
    lines.push('  }');
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function renderPython(ctx: RenderContext): string {
  const lines: string[] = [];
  lines.push('from playwright.sync_api import Locator, Page');
  lines.push('');
  lines.push('');
  lines.push(`class ${ctx.className}:`);
  lines.push(`    """Page object for ${describe(ctx)}.`);
  if (ctx.goto) lines.push(`    Source: ${safeComment(ctx.source)}`);
  lines.push('    Generated by LocatorAgent; locators were validated against the live page.');
  lines.push('    """');
  lines.push('');
  lines.push('    def __init__(self, page: Page) -> None:');
  lines.push('        self.page = page');
  for (const e of ctx.elements) {
    const t = translateExpression(e.expression, 'python')!;
    lines.push(`        self.${e.name}: Locator = ${t.code}${e.verified ? '' : `  # ${TODO_TEXT}`}`);
  }
  if (ctx.goto) {
    lines.push('');
    lines.push('    def goto(self) -> None:');
    lines.push(`        self.page.goto(${str(ctx.source)})`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderJava(ctx: RenderContext): string {
  const imports = new Set<string>(['com.microsoft.playwright.Locator', 'com.microsoft.playwright.Page']);
  const assignments = ctx.elements.map((e) => {
    const t = translateExpression(e.expression, 'java')!;
    t.imports.forEach((i) => imports.add(i));
    return `        this.${e.name} = ${t.code};${e.verified ? '' : ` // ${TODO_TEXT}`}`;
  });

  const lines: string[] = [];
  if (ctx.javaPackage) {
    lines.push(`package ${ctx.javaPackage};`);
    lines.push('');
  }
  for (const i of [...imports].sort()) lines.push(`import ${i};`);
  lines.push('');
  lines.push('/**');
  lines.push(` * Page object for ${describe(ctx)}.`);
  if (ctx.goto) lines.push(` * Source: ${safeComment(ctx.source)}`);
  lines.push(' * Generated by LocatorAgent; locators were validated against the live page.');
  lines.push(' */');
  lines.push(`public class ${ctx.className} {`);
  lines.push('    private final Page page;');
  for (const e of ctx.elements) lines.push(`    public final Locator ${e.name};`);
  lines.push('');
  lines.push(`    public ${ctx.className}(Page page) {`);
  lines.push('        this.page = page;');
  lines.push(...assignments);
  lines.push('    }');
  if (ctx.goto) {
    lines.push('');
    lines.push('    public void navigate() {');
    lines.push(`        page.navigate(${str(ctx.source)});`);
    lines.push('    }');
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}
