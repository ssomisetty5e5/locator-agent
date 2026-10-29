# 🎯 LocatorAgent — Smart Web Locator Generator

An intelligent agent that analyzes web pages — including deep Shadow DOM trees — and generates robust, ranked locators for automation testing. Comes with three interactive web UIs: a simple analyzer, an embedded headless browser, and a **native browser mode** that connects to your own Chrome via CDP.

---

## ✨ Features

- **Shadow DOM Piercing** — Iterative traversal that walks through all Shadow DOM boundaries, no matter how deep
- **10 Locator Strategies** — TestID, Aria Role, Aria Label, Text, ID, Name, Placeholder, CSS, Shadow-Piercing CSS, and XPath (Shadow-Piercing CSS also emits JavaScript `querySelector` chains)
- **iframe Support** — Elements inside (nested, cross-origin) iframes are discovered and validated within their own frame; each locator carries its `framePath`
- **Authenticated Pages** — Reuse a Playwright `storageState` file (`--storage-state` / `storageState` API field) to analyze logged-in pages
- **Scoped Locators** — When an element repeats (a "Delete" button in every row), locators are scoped to a distinguishing ancestor, e.g. `locator('tr').filter({ hasText: 'Invoice 1042' }).getByRole('button', { name: 'Delete' })`, and only kept if they match exactly that element
- **Page Object Generator** — Turn a page into a ready-to-use Playwright class (TypeScript, Python or Java) with named `Locator` properties, validated locators and iframe chains
- **Multi-Framework Output** — Each locator tagged with its framework: Playwright (`PW`), Selenium (`Se`), CSS, XPath, JavaScript (`JS`)
- **Robustness Scoring** — Every locator scored 0–100 for stability, with chain depth and uniqueness factored in
- **Uniqueness Validation** — Live validation against the page: each locator shows its match count (✓1, ⚠2, ✗0)
- **Shortened Chain Variants** — Shadow-piercing locators get shortened versions when possible (⚡ badge)
- **Interactive Inspect Mode** — Hover over elements, click to generate locators in real time
- **3 Web UIs** — Simple URL analyzer, embedded headless browser, and native CDP browser mode
- **CLI & REST API** — Terminal tool and HTTP endpoint for CI/CD integration
- **198 Tests** — Unit and live-page tests covering discovery, generation, ranking, stability heuristics, shadow-DOM validation, and end-to-end analysis

---

## 🚀 Quick Start

```bash
# Install dependencies
npm install
npx playwright install chromium

# Build
npm run build

# Start the server
npm run start:api
```

Then open **http://localhost:3000** in your browser.

---

## 🖥️ Three Ways to Use

### 1. Web UI — Simple Analyzer (`/`)

Open `http://localhost:3000/` — paste a URL, click **Analyze**, and get locators for all interactive elements.

### 2. Embedded Browser (`/browser.html`)

Open `http://localhost:3000/browser.html` — a headless Chromium runs server-side and streams its viewport to you as a live canvas. You can:

- Navigate to any URL (including login-protected pages)
- Interact with the page (click, type, scroll) directly in the canvas
- **Inspect mode**: Hover to highlight elements, click to generate locators
- **Analyze**: Scan all interactive elements at once

### 3. Native Browser Mode (`/native.html`)

Connects to **your own Chrome/Edge** via the Chrome DevTools Protocol (CDP). The app renders inside the LocatorAgent page via live screenshot streaming — no tab switching needed.

#### Setup

1. **Close all Chrome windows** (important — Chrome ignores the debug flag if another instance is running)

2. **Launch Chrome with the debug port:**
   ```powershell
   # Windows
   Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
     -ArgumentList "--remote-debugging-port=9222","--user-data-dir=C:\temp\chrome-debug"
   ```
   ```bash
   # macOS
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
   ```

3. **Open** `http://localhost:3000/native.html`

4. Click **🔗 Connect** → enter a URL → click **Go**

5. The app loads right inside the LocatorAgent page. Click **🎯 Inspect** to pick elements, or **🔍 Analyze** to scan all.

> **Why native mode?** Use it when you need to test against login-protected apps using your real browser session with cookies, extensions, and saved credentials.

---

## ⌨️ CLI Usage

```bash
# Analyze a live URL
npm run cli -- analyze --url https://example.com

# Analyze an HTML snapshot file
npm run cli -- analyze --file ./snapshot.html

# Include non-interactive elements
npm run cli -- analyze --url https://example.com --all

# Output as JSON
npm run cli -- analyze --url https://example.com --json

# Analyze a logged-in page using a saved Playwright session
npm run cli -- analyze --url https://app.example.com --storage-state ./auth.json
```

### Use as an installed package / in CI

The package exposes a `locator-agent` binary and a library entry point (`dist/index.js`). Build the tarball with `npm pack`, then install it in another project (`npm install ./locator-agent-1.0.0.tgz`) or run it with `npx`:

```bash
npx playwright install chromium     # one-time: npm does not download browsers

# CI gate: exit code 2 if any element's best locator scores below 85,
# matches several elements, or matches the wrong one
npx locator-agent analyze --url https://staging.example.com/login --fail-below 85
```

```ts
import { LocatorAgent } from 'locator-agent';

const agent = new LocatorAgent();
const analysis = await agent.analyze({ url: 'https://example.com' });
await agent.shutdown();
```

Exit codes: `0` success, `1` error (bad input, unreachable page, missing browser), `2` quality gate failed. With `--json` the full analysis is still printed to stdout and the failing elements are listed on stderr.

### Generate a Page Object

```bash
# Print a Playwright page object class to stdout
npm run cli -- page-object --url https://example.com/login

# Write it to a file, with a chosen class name
npm run cli -- page-object --url https://example.com/login -n LoginPage -o pages/LoginPage.ts

# Same page as a Python or Java Playwright class
npm run cli -- page-object --url https://example.com/login -l python -o pages/login_page.py
npm run cli -- page-object --url https://example.com/login -l java --package com.acme.pages -o LoginPage.java
```

Output (abridged):

```ts
export class LoginPage {
  readonly emailAddressInput: Locator;
  readonly logInButton: Locator;
  readonly deleteButtonInvoice1002: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailAddressInput = page.getByPlaceholder('Email address');
    this.logInButton = page.getByRole('button', { name: 'Log In' });
    this.deleteButtonInvoice1002 = page.locator('tr').filter({ hasText: 'Invoice 1002' }).getByRole('button', { name: 'Delete' });
  }
}
```

Each property uses the best locator that matched exactly its element during analysis. Locators that couldn't be verified are marked `// TODO`. Options: `--language typescript|python|java`, `--package` (Java), `--min-score`, `--import-from` (TypeScript), `--no-goto`, `--json`, `--storage-state`.

---

## 🔌 REST API

```bash
npm run start:api
```

**POST** `http://localhost:3000/analyze`

```json
{
  "url": "https://example.com",
  "includeNonInteractive": false,
  "maxElements": 100
}
```

Or analyze raw HTML:

```json
{
  "html": "<html><body><button data-testid='submit'>Go</button></body></html>"
}
```

**POST** `http://localhost:3000/generate/page-object` — same inputs as `/analyze` plus `className`, `language`, `javaPackage`, `minScore`, `importFrom`, `noGoto`; returns `{ className, language, code, elements, skipped }`.

**Response** (`/analyze`) includes for each element:
- Element info (tag, attributes, text, shadow depth, host chain)
- All generated locators with strategy, framework, score, and match count
- Recommended locator (highest scored)

### Running the server safely

The server drives a real browser and can read files, so it is locked down by default. With no configuration it:

- listens on `127.0.0.1` only, and rejects requests whose `Host` is not a loopback name (blocks DNS rebinding);
- rejects cross-site browser requests and WebSocket handshakes (`Origin` must be the server itself);
- **disables `filePath` and `storageState`** until you set `LA_ROOT` (they must then stay inside that directory; `..` and symlinks that escape are refused);
- accepts only `http(s)` URLs, and clamps `timeout` (≤ 120 s) and `maxElements` (≤ 1000);
- allows 4 analyses at once, then answers `429`.

When the server is bound beyond loopback, or `LA_ALLOW_PRIVATE_NETWORK=0`, every connection the browser makes (the page, each redirect hop, images, scripts, WebSockets) goes through a built-in filtering proxy that refuses loopback, private, link-local (cloud metadata) and other non-public addresses, and connects to the address it checked, so redirects and DNS rebinding cannot reach internal hosts.

| Variable | Default | Meaning |
|---|---|---|
| `LA_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only together with `LA_API_TOKEN` |
| `PORT` | `3000` | Port |
| `LA_ROOT` | unset | Directory that `filePath` / `storageState` must stay inside; unset disables both |
| `LA_API_TOKEN` | unset | Require `Authorization: Bearer <token>` (or `x-api-key`); WebSockets also accept `?token=` |
| `LA_ALLOW_PRIVATE_NETWORK` | on for loopback binds, off otherwise | Allow analyzing `localhost` / private addresses |
| `LA_ALLOWED_TARGETS` | unset | `host` or `host:port` exempt from the private-network block (e.g. `staging.corp:8443`) |
| `LA_ALLOWED_HOSTS` | unset | Extra `Host` header values to accept (reverse proxy, container name) |
| `LA_ALLOWED_ORIGINS` | unset | Extra browser origins to accept |
| `LA_MAX_CONCURRENT` | `4` | Concurrent analyses |

Notes: the bundled web UIs do not send an API token, so with `LA_API_TOKEN` set use the API from scripts or CI. The native-browser mode attaches to Chrome on `localhost:9222` by design and is not covered by the network filter.

---

## 🧠 Locator Strategies

| # | Strategy | Example | Framework | Robustness |
|---|----------|---------|-----------|------------|
| 1 | Test ID | `getByTestId('submit-btn')` | PW, CSS, Se | ★★★★★ |
| 2 | Aria Role | `getByRole('button', { name: 'Submit' })` | PW, CSS | ★★★★★ |
| 3 | Aria Label | `getByLabel('Close dialog')` | PW, CSS, Se | ★★★★ |
| 4 | Text | `getByText('Sign In')` | PW, XPath, Se | ★★★★ |
| 5 | ID | `#login-form` | CSS, PW, Se | ★★★★ |
| 6 | Name | `input[name="email"]` | CSS, Se | ★★★ |
| 7 | Placeholder | `getByPlaceholder('Enter email')` | PW, CSS | ★★★ |
| 8 | CSS | `div.card > button.primary` | CSS | ★★★ |
| 9 | Shadow CSS | `my-host >> inner-host >> button` | PW, JS, CSS | ★★★ |
| 10 | XPath | `//button[text()='Submit']` | XPath | ★★ |
| 9b | JS Chain (variant of Shadow CSS) | `document.querySelector('host').shadowRoot.querySelector('btn')` | JS | ★★ |

---

## 📁 Project Structure

```
locator-agent/
├── public/                    # Web UIs
│   ├── index.html             # Simple URL analyzer
│   ├── browser.html           # Embedded headless browser
│   └── native.html            # Native CDP browser mode
├── src/
│   ├── agent.ts               # Orchestrator (load → traverse → discover → generate → rank)
│   ├── types/                 # Shared TypeScript interfaces
│   ├── loader/                # Page loading (URL, HTML snapshot, file)
│   ├── traverser/             # Iterative Shadow DOM piercing traversal
│   ├── discoverer/            # Interactive element discovery + UID assignment
│   ├── generator/             # Locator generation engine
│   │   └── strategies/        # 10 individual strategy implementations
│   ├── ranker/                # Robustness scoring + ranking
│   ├── validator/             # Live uniqueness validation (match counting)
│   ├── browser/               # Live browser sessions
│   │   ├── browserSession.ts  # Embedded headless browser (Playwright)
│   │   └── nativeBrowserSession.ts  # Native CDP browser (connects to user's Chrome)
│   ├── api/                   # Express REST API + WebSocket server
│   └── cli/                   # Commander.js CLI tool
├── tests/
│   └── agent.test.ts          # agent, stability and live-validation tests (Vitest)
├── package.json
└── tsconfig.json
```

---

## 🏗️ Architecture

```
┌──────────────┐    ┌───────────────┐    ┌──────────────────┐
│  PageLoader   │───▸│  ShadowDOM    │───▸│  ElementDiscover │
│  (URL/HTML)   │    │  Traverser    │    │  (interactive)   │
└──────────────┘    └───────────────┘    └────────┬─────────┘
                                                   │
                    ┌───────────────┐    ┌─────────▼─────────┐
                    │  Locator      │◂───│  LocatorGenerator  │
                    │  Validator    │    │  (10 strategies)   │
                    └───────┬───────┘    └───────────────────┘
                            │
                    ┌───────▼───────┐
                    │  LocatorRanker │
                    │  (score 0–100) │
                    └───────────────┘
```

**Native Browser Flow:**
```
User's Chrome (port 9222)
    ↕ CDP connection
LocatorAgent Server (Node.js)
    ↕ WebSocket (binary frames + JSON messages)
native.html (canvas + results panel)
```

Chrome's built-in `Page.screencastFrame` streams frames natively, and `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` send trusted input events.

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

---

## 📋 Requirements

- **Node.js** ≥ 18
- **Playwright** (auto-installs Chromium via `npx playwright install chromium`)
- **Chrome/Edge** with `--remote-debugging-port=9222` (for native mode only)

---

## License

MIT
