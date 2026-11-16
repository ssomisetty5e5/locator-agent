// ============================================================
// Tests: the browser extension as a whole — manifest, packaging, and a
// real run in Chromium with the extension loaded (inject the panel,
// analyse a page, pick elements in Shadow DOM / rows / iframes).
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { chromium, BrowserContext, Page, Worker } from 'playwright';
import { createServer } from '../src/api/server';
import { loadConfig } from '../src/api/config';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildExtension } = require(path.join(root, 'scripts', 'build-extension.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { packageExtension } = require(path.join(root, 'scripts', 'package-extension.js'));

describe('extension manifest', () => {
  it('is Manifest V3 and asks only for activeTab and scripting', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.sort()).toEqual(['activeTab', 'scripting']);
    // No standing access to any website: the user's click grants one tab
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
  });

  it('points at files that exist after a build', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'la-manifest-'));
    try {
      await buildExtension({ outdir: path.join(out, 'dist') });
      expect(fs.existsSync(path.join(out, 'dist', manifest.background.service_worker.replace('dist/', '')))).toBe(true);
      expect(fs.existsSync(path.join(out, 'dist', 'content.js'))).toBe(true);
      for (const icon of Object.values<string>(manifest.icons)) expect(fs.existsSync(path.join(root, 'extension', icon))).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('extension package', () => {
  it('zips manifest.json at the top level with the built scripts', async () => {
    const { out, files } = await packageExtension();
    try {
      expect(files).toEqual(expect.arrayContaining(['manifest.json', 'dist/content.js', 'dist/background.js', 'icons/icon128.png']));
      expect(files.some((f: string) => f.startsWith('src/'))).toBe(false);

      // Read the archive back and compare with the files on disk
      const zip = fs.readFileSync(out);
      const entries = readZip(zip);
      expect(Object.keys(entries).sort()).toEqual([...files].sort());
      expect(entries['manifest.json'].toString()).toBe(fs.readFileSync(manifestPath, 'utf8'));
      expect(entries['dist/content.js'].equals(fs.readFileSync(path.join(root, 'extension', 'dist', 'content.js')))).toBe(true);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 60_000);
});

/** Minimal zip reader (central directory + raw deflate) for checking our own archives. */
function readZip(buf: Buffer): Record<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    out[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('extension in Chromium', () => {
  let ctx: BrowserContext | undefined;
  let server: Server;
  let base = '';
  let sw: Worker;
  let tmp = '';
  let unsupported = '';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ext-'));
    // A copy that may script localhost pages. The shipped extension gets that access from the
    // user's toolbar click (activeTab), which automation can't perform.
    const ext = path.join(tmp, 'ext');
    await buildExtension({ outdir: path.join(ext, 'dist') });
    fs.cpSync(path.join(root, 'extension', 'icons'), path.join(ext, 'icons'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }));

    ({ server } = createServer({ ...loadConfig({}) }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
        channel: 'chromium', // the full browser: the headless shell can't load extensions
        headless: true,
        viewport: { width: 1280, height: 800 },
        args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
      });
      sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20_000 }));
    } catch (err) {
      unsupported = `this Chromium can't load extensions: ${(err as Error).message.split('\n')[0]}`;
    }
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    server?.closeAllConnections?.();
    await new Promise((r) => server?.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Inject the content script the way the background worker does on a toolbar click. */
  const inject = (page: Page) =>
    sw.evaluate(async (url: string) => {
      const [tab] = await (globalThis as any).chrome.tabs.query({ url });
      await (globalThis as any).chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['dist/content.js'] });
    }, page.url());

  const panel = (page: Page) => page.locator('#locator-agent-root');

  it('runs end to end on the sample page', async (t) => {
    if (unsupported) return t.skip();
    const page = await ctx!.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/demo.html`);

    // Show the panel
    await inject(page);
    await panel(page).waitFor({ state: 'attached' });
    await panel(page).locator('.panel').waitFor({ state: 'visible' });

    // Analyse the whole page
    await panel(page).getByRole('button', { name: 'Analyze page' }).click();
    await panel(page).locator('.item').first().waitFor({ timeout: 30_000 });
    expect(await panel(page).locator('.chip').allInnerTexts()).toEqual(['17 interactive', '4 shadow roots', '52 DOM elements']);

    // …and export a page object
    await panel(page).getByRole('button', { name: 'Page object' }).click();
    const code = await panel(page).locator('pre.po').innerText();
    expect(code).toMatch(/export class \w+/);
    expect(code).toContain('emailInput');
    expect(code).toContain("filter({ hasText: 'INV-1042' })");

    // Pick a button inside two nested shadow roots (the click must not reach the page)
    await panel(page).getByRole('button', { name: 'Pick element' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await panel(page).locator('.rec .code').waitFor({ timeout: 15_000 });
    expect(await panel(page).locator('.rec .code').innerText()).toBe("getByRole('button', { name: 'Settings' })");
    await panel(page).locator('.chip', { hasText: 'Shadow DOM depth 2' }).waitFor({ state: 'visible', timeout: 5_000 });

    // Pick one of three identical row buttons: the locator is scoped to its row
    await panel(page).getByRole('button', { name: 'Pick element' }).click();
    await page.locator('table tr').nth(2).getByRole('button', { name: 'Delete' }).click();
    await panel(page).locator('.rec .code', { hasText: 'INV-1042' }).waitFor({ timeout: 15_000 });

    // Pick inside a same-origin iframe
    await panel(page).getByRole('button', { name: 'Pick element' }).click();
    await page.frameLocator('iframe').getByRole('button', { name: 'Subscribe' }).click();
    await panel(page).locator('.chip', { hasText: 'Inside iframe' }).waitFor({ timeout: 15_000 });
    expect(await panel(page).locator('.rec .code').innerText()).toBe("getByRole('button', { name: 'Subscribe' })");

    // Injecting again hides the panel; once more shows it
    await inject(page);
    await panel(page).waitFor({ state: 'detached', timeout: 5_000 });
    await inject(page);
    await panel(page).waitFor({ state: 'attached', timeout: 5_000 });

    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it('leaves the page untouched until picking is cancelled with Escape', async (t) => {
    if (unsupported) return t.skip();
    const page = await ctx!.newPage();
    await page.goto(`${base}/demo.html`);
    await page.evaluate(() => {
      (window as any).__clicks = 0;
      document.addEventListener('click', () => { (window as any).__clicks++; });
    });
    await inject(page);
    await panel(page).waitFor({ state: 'attached' });

    // Picking swallows the click, so the page's own handler never runs
    await panel(page).getByRole('button', { name: 'Pick element' }).click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await panel(page).locator('.rec').waitFor({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).__clicks)).toBe(0);

    // After picking, clicks behave normally again
    await page.getByRole('button', { name: 'Sign in' }).click();
    expect(await page.evaluate(() => (window as any).__clicks)).toBe(1);

    // Escape cancels pick mode without choosing anything
    await panel(page).getByRole('button', { name: 'Pick element' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Sign in' }).click();
    expect(await page.evaluate(() => (window as any).__clicks)).toBe(2);
    await page.close();
  }, 120_000);
});
