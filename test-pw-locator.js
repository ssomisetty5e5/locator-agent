const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setContent(`
    <nuxeo-app>
      <nuxeo-menu-icon name="browser" role="option"></nuxeo-menu-icon>
      <nuxeo-menu-icon name="recents" role="option"></nuxeo-menu-icon>
      <nuxeo-menu-icon name="tasks" role="option"></nuxeo-menu-icon>
    </nuxeo-app>
    <script>
      class NuxeoMenuIcon extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML =
            '<a><paper-icon-button id="button" role="button"></paper-icon-button></a>';
        }
      }
      customElements.define('nuxeo-menu-icon', NuxeoMenuIcon);

      class PaperIconButton extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML =
            '<iron-icon id="icon"></iron-icon>';
        }
      }
      customElements.define('paper-icon-button', PaperIconButton);
    </script>
  `);

  await page.waitForTimeout(500);

  console.log('=== Test 1: Playwright >> Locator ===\n');
  const pwSelector = 'nuxeo-menu-icon[name="browser"] >> paper-icon-button#button >> #icon';
  const el = page.locator(pwSelector);
  console.log('  Locator:', pwSelector);
  console.log('  .count()        =>', await el.count());
  console.log('  tag             =>', await el.evaluate(e => e.tagName.toLowerCase()));
  console.log('  id              =>', await el.evaluate(e => e.id));
  await el.waitFor({ state: 'attached', timeout: 2000 });
  console.log('  .waitFor()      => SUCCESS');
  console.log('  ✅ Works with page.locator()\n');

  console.log('=== Test 2: JavaScript querySelector Chain ===\n');
  const jsChain = "document.querySelector('nuxeo-menu-icon[name=\"browser\"]').shadowRoot.querySelector('paper-icon-button#button').shadowRoot.querySelector('#icon')";
  console.log('  Locator:', jsChain);
  const jsResult = await page.evaluate(() => {
    const el = document.querySelector('nuxeo-menu-icon[name="browser"]')
      .shadowRoot.querySelector('paper-icon-button#button')
      .shadowRoot.querySelector('#icon');
    return el ? { tag: el.tagName.toLowerCase(), id: el.id, found: true } : { found: false };
  });
  console.log('  found           =>', jsResult.found);
  console.log('  tag             =>', jsResult.tag);
  console.log('  id              =>', jsResult.id);
  console.log('  ✅ Works with page.evaluate()\n');

  console.log('=== Summary ===\n');
  console.log('  PW  (page.locator)   => ✅ Use for .click(), .fill(), .waitFor(), assertions');
  console.log('  JS  (page.evaluate)  => ✅ Use for custom logic, Selenium executeScript, DevTools');
  console.log('  CSS (>>> deprecated) => ❌ Not supported by browsers or Playwright\n');

  await browser.close();
})();
