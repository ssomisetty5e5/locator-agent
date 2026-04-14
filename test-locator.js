const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Simulate the exact Nuxeo Shadow DOM structure from the screenshot
  await page.setContent(`
    <nuxeo-app>
      <nuxeo-menu-icon name="browser" icon="nuxeo:browse" label="app.browse" role="option" tabindex="-1" aria-disabled="false" aria-selected="false">
      </nuxeo-menu-icon>
      <nuxeo-menu-icon name="recents" icon="nuxeo:recent" label="app.recents" role="option" tabindex="-1">
      </nuxeo-menu-icon>
      <nuxeo-menu-icon name="tasks" icon="nuxeo:tasks" label="app.tasks" role="option" tabindex="-1">
      </nuxeo-menu-icon>
    </nuxeo-app>
    <script>
      class NuxeoMenuIcon extends HTMLElement {
        constructor() {
          super();
          const shadow = this.attachShadow({ mode: 'open' });
          shadow.innerHTML = '<style></style><a><paper-icon-button noink id="button" aria-labelledby="tooltip" tabindex="-1" role="button" aria-disabled="false"></paper-icon-button></a>';
        }
      }
      customElements.define('nuxeo-menu-icon', NuxeoMenuIcon);

      class PaperIconButton extends HTMLElement {
        constructor() {
          super();
          const shadow = this.attachShadow({ mode: 'open' });
          shadow.innerHTML = '<style></style><iron-icon id="icon"></iron-icon><paper-ripple id="ink" center class="circle"></paper-ripple>';
        }
      }
      customElements.define('paper-icon-button', PaperIconButton);
    </script>
  `, { waitUntil: 'networkidle' });

  await page.waitForTimeout(500);

  console.log('=== PLAYWRIGHT >> LOCATORS ===\\n');

  const pwLocators = [
    'nuxeo-menu-icon[name="browser"] >> paper-icon-button#button >> #icon',
    'nuxeo-menu-icon[name="recents"] >> paper-icon-button#button >> #icon',
    'nuxeo-menu-icon >> paper-icon-button#button >> #icon',
    '#icon',
  ];
  for (const loc of pwLocators) {
    const c = await page.locator(loc).count();
    const s = c === 1 ? '✓ UNIQUE' : c === 0 ? '✗ NONE' : '⚠ ' + c;
    console.log(s + '  =>  ' + loc);
  }

  console.log('\\n=== JAVASCRIPT querySelector CHAINS (DevTools compatible) ===\\n');

  const jsLocators = [
    "document.querySelector('nuxeo-menu-icon[name=\"browser\"]').shadowRoot.querySelector('paper-icon-button#button').shadowRoot.querySelector('#icon')",
    "document.querySelector('nuxeo-menu-icon[name=\"recents\"]').shadowRoot.querySelector('paper-icon-button#button').shadowRoot.querySelector('#icon')",
    "document.querySelector('nuxeo-menu-icon[name=\"browser\"]').shadowRoot.querySelector('paper-icon-button#button')",
    "document.querySelector('nuxeo-menu-icon[name=\"browser\"]')",
  ];
  for (const js of jsLocators) {
    const result = await page.evaluate('(() => { try { return ' + js + ' ? 1 : 0; } catch(e) { return 0; } })()');
    const s = result === 1 ? '✓ FOUND' : '✗ NOT FOUND';
    console.log(s + '  =>  ' + js);
  }

  await browser.close();
})();
