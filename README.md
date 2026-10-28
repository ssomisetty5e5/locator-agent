# 🎯 LocatorAgent — Smart Web Locator Generator

An intelligent agent that analyzes web pages — including deep Shadow DOM trees — and generates robust, ranked locators for automation testing. Comes with three interactive web UIs: a simple analyzer, an embedded headless browser, and a **native browser mode** that connects to your own Chrome via CDP.

---

## ✨ Features

- **Shadow DOM Piercing** — Iterative traversal that walks through all Shadow DOM boundaries, no matter how deep
- **10 Locator Strategies** — TestID, Aria Role, Aria Label, Text, ID, Name, Placeholder, CSS, Shadow-Piercing CSS, and XPath (Shadow-Piercing CSS also emits JavaScript `querySelector` chains)
- **Multi-Framework Output** — Each locator tagged with its framework: Playwright (`PW`), Selenium (`Se`), CSS, XPath, JavaScript (`JS`)
- **Robustness Scoring** — Every locator scored 0–100 for stability, with chain depth and uniqueness factored in
- **Uniqueness Validation** — Live validation against the page: each locator shows its match count (✓1, ⚠2, ✗0)
- **Shortened Chain Variants** — Shadow-piercing locators get shortened versions when possible (⚡ badge)
- **Interactive Inspect Mode** — Hover over elements, click to generate locators in real time
- **3 Web UIs** — Simple URL analyzer, embedded headless browser, and native CDP browser mode
- **CLI & REST API** — Terminal tool and HTTP endpoint for CI/CD integration
- **57 Tests** — Unit and live-page tests covering discovery, generation, ranking, stability heuristics, shadow-DOM validation, and end-to-end analysis

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
```

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

**Response** includes for each element:
- Element info (tag, attributes, text, shadow depth, host chain)
- All generated locators with strategy, framework, score, and match count
- Recommended locator (highest scored)

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
