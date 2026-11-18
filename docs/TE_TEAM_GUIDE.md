# LocatorAgent: Guide for the Test Engineering Team

This guide shows how to use LocatorAgent on **your own application**: finding reliable locators, generating page objects, auditing how testable a screen is, and gating a CI build on locator quality.

It is a practical companion to the [User Manual](USER_MANUAL.md), which documents every feature. Read this first; go to the manual for detail.

## Contents

1. [What it gives you](#1-what-it-gives-you)
2. [Pick your route](#2-pick-your-route)
3. [Set up](#3-set-up)
4. [Recipe A: get a locator for one element](#4-recipe-a-get-a-locator-for-one-element)
5. [Recipe B: generate a page object for a screen](#5-recipe-b-generate-a-page-object-for-a-screen)
6. [Recipe C: audit how testable a screen is](#6-recipe-c-audit-how-testable-a-screen-is)
7. [Recipe D: gate CI on locator quality](#7-recipe-d-gate-ci-on-locator-quality)
8. [Applications behind a login](#8-applications-behind-a-login)
9. [Applications that need an action first](#9-applications-that-need-an-action-first)
10. [Reading the results](#10-reading-the-results)
11. [Getting better scores: what to ask developers for](#11-getting-better-scores-what-to-ask-developers-for)
12. [Worked example: a web-component application](#12-worked-example-a-web-component-application)
13. [Known limits](#13-known-limits)
14. [Troubleshooting](#14-troubleshooting)
15. [Data handling](#15-data-handling)
16. [Cheat sheet](#16-cheat-sheet)

## 1. What it gives you

For every interactive element on a page, LocatorAgent produces several candidate locators (Playwright, Selenium, WebdriverIO, CSS, XPath, JavaScript), **checks each one against the live page**, and recommends the best.

- **Verified, not guessed.** Each locator is run on the real page. You see how many elements it matches and whether the match is the element you meant (`✓ 1`, `⚠ 3`, `✗ 0`, `✗ wrong`).
- **Shadow DOM aware.** Elements inside web components (nested to any depth) get working locators.
- **Handles repeated items.** For "the Delete button in every row" it builds a locator scoped to the row: `locator('tr').filter({ hasText: 'INV-1042' }).getByRole('button', { name: 'Delete' })`.
- **Scored.** Each locator gets 0 to 100 for stability. Position-based paths, generated ids and ambiguous matches score low; test ids, roles and labels score high.
- **Page objects.** It writes a ready-to-use page object class in TypeScript, Python or Java, marking anything it could not confirm unique with `// TODO`.
- **Rule-based and local.** No AI model is called at run time, and nothing leaves your machine (see [Data handling](#15-data-handling)).

## 2. Pick your route

| Your situation | Use | Why |
|---|---|---|
| You want a locator for what you see in your own browser | **Browser extension** | Works in your real, logged-in session. No server, no install of Playwright |
| App uses SSO, VPN or MFA | **Extension**, or **native browser mode** | They use your own Chrome/Edge, so the login already works |
| The app loads fine in an automated browser and you want to script it | **Command line** | Batch runs, page objects, CI gates |
| The app shows a login page or almost no elements to the command line, or never finishes loading | **Extension** | See [Troubleshooting](#14-troubleshooting): some apps will not start in an automated browser |
| You want to call it from other tools | **REST API** | See manual section 11 |
| You cannot install Node | **Docker** | See manual section 12 |

If you are unsure, start with the **extension**. It is the lowest-friction route and works on the widest range of applications.

## 3. Set up

### Requirements

- **Node.js 18+** with npm (command line, web analyzer, building the extension).
- **Chrome or Edge** (extension, native mode).
- Docker is optional.

### Get the code and install

```bash
git clone https://github.com/ssomisetty5e5/locator-agent.git
cd locator-agent
npm install
npx playwright install chromium
```

The last command downloads the browser Playwright drives. The **extension does not need it**, so skip it if the extension is all you use.

LocatorAgent is internal tooling, not published to a package registry. Use it from a clone of the repository (or a copy of the folder).

### Install the browser extension

```bash
npm run build:extension
```

1. Open `chrome://extensions` (or `edge://extensions`).
2. Switch on **Developer mode**.
3. Click **Load unpacked** and select the **`extension`** folder inside the project.
4. Pin the LocatorAgent button to the toolbar.

To hand the extension to colleagues without them building it:

```bash
npm run package:extension
```

This writes `extension/locator-agent-extension-1.0.0.zip`. They unzip it and use **Load unpacked** on the unzipped folder.

### Start the web analyzer (optional)

```bash
npm run start:api
```

Open <http://localhost:3000>. Click **Use the built-in sample page** and **Analyze Page** to see what the output looks like before you point it at your own application.

## 4. Recipe A: get a locator for one element

Use the **extension**. This is the everyday task: "what locator do I use for this button?"

1. Open your application in Chrome or Edge and get to the screen you need (log in, open the dialog, expand the menu).
2. Click the LocatorAgent toolbar button or press **Alt+L**. A panel appears at the top right.
3. Click **Pick element**, hover (elements are outlined), and **click** the one you want. The page does not receive the click. Press **Esc** to cancel.
4. Read the **recommended locator** and its badge:
   - `✓ 1` means it matches exactly one element and it is the right one. Use it.
   - Anything else means look at **All locators** below it, or at the scoped option.
5. Use the framework chips (Playwright, Selenium, CSS, XPath, ...) to show only your framework, then **Copy**. Playwright locators are copied with the `page.` prefix.

Tips:

- Work through **Shadow DOM and same-origin iframes** normally; the panel shows the iframe path or shadow depth.
- For something that appears only on hover or click (a menu, a tooltip), get it on screen first, then open the panel and pick it. If it closes as soon as you move the mouse, try **Analyze page** while it is open and find it in the list instead.
- If the recommendation is a long `a >> b >> c` chain, the element has no good attribute of its own. Note it for [Section 11](#11-getting-better-scores-what-to-ask-developers-for).

## 5. Recipe B: generate a page object for a screen

**In the extension:** open the screen, click **Analyze page** (choose 100 or 200 elements), choose a language, then **Page object**. **Copy** or **Download** the file.

**From the command line** (screens that load in an automated browser):

```bash
# TypeScript (Playwright Test), saved to a file
npm run cli -- page-object --url https://your-app.example.com/login -n LoginPage -o pages/LoginPage.ts

# Python
npm run cli -- page-object --url https://your-app.example.com/login -l python -o pages/login_page.py

# Java
npm run cli -- page-object --url https://your-app.example.com/login -l java --package com.yourteam.pages -o LoginPage.java
```

Useful options: `--min-score 70` leaves out weak elements, `--max 200` analyzes more elements, `--no-goto` omits the `goto()` method, `--storage-state auth.json` reuses a login (see [Section 8](#8-applications-behind-a-login)).

**Always review the output before committing it:**

- A property marked `// TODO: not verified unique` could not be confirmed against the page. Either fix the locator by hand, or leave it out. Typical causes: the element is hidden (inside a closed dialog), or it repeats with nothing to tell the copies apart.
- Names come from labels and element kind (`signInButton`, `emailInput`). Rename anything that is unclear.
- Elements that repeat (table rows, cards) get names with the row text, for example `deleteButtonInv1042`. Often you want a method that takes the row text as a parameter instead. Treat the generated line as a working example to copy.

The class uses `page.locator(...)` and `getBy...` calls that Playwright resolves through shadow roots, so you do not need extra piercing syntax.

## 6. Recipe C: audit how testable a screen is

Use this to find out, before writing tests, whether a screen can be automated reliably.

```bash
npm run cli -- analyze --url https://your-app.example.com/dashboard --max 200 --json > audit.json
```

(or **Analyze page** in the extension).

What to look at:

| Question | Where to look |
|---|---|
| How many elements have a locator scoring 85+? | The score distribution; green in the UI |
| Which elements have no unique locator at all? | Badges `⚠` and `✗` on the recommended locator |
| Which need a long chain or position (`nth-of-type`, `[3]`)? | Low scores; ask for test ids ([Section 11](#11-getting-better-scores-what-to-ask-developers-for)) |
| How much of the page sits inside Shadow DOM? | The "Shadow roots" count and per-element shadow depth |

The result gives you a short, evidence-based list to send to the developers: "these 40 controls have no stable hook."

## 7. Recipe D: gate CI on locator quality

```bash
npm run cli -- analyze --url https://staging.your-app.example.com/login --fail-below 85
echo $?
```

The command exits with:

| Exit code | Meaning |
|---|---|
| 0 | Every analyzed element's best locator scored at least the threshold, matches exactly one element, and the right one |
| 2 | The gate failed. The failing elements are listed on the error stream |
| 1 | An error (bad input, unreachable page, missing browser) |

Guidance:

- **Start lenient and tighten.** A threshold of 85 is a good target, not a good starting point for an existing app. Begin around 60 or 70 on the screens you care about, then raise it.
- **Gate specific pages**, one command per page. Use `--max` to bound how many elements are considered.
- The gate judges the **best** locator for each element, so adding one `data-testid` to an element fixes it.
- Remember the limit from [Section 2](#2-pick-your-route): the command line needs an application that starts in an automated browser, and it needs the page to be reachable from the CI machine.

Example CI step (adapt to your CI system):

```yaml
- run: |
    git clone https://github.com/ssomisetty5e5/locator-agent.git
    cd locator-agent
    npm ci
    npx playwright install --with-deps chromium
    npm run cli -- analyze --url "$STAGING_URL/login" --storage-state "$AUTH_STATE" --fail-below 70
```

The same checks are available as a Docker image (manual section 12) if your agents already run containers.

## 8. Applications behind a login

**Extension or native mode:** nothing to do. Log in as you normally do in your own browser, then analyze.

**Command line:** save a session once, then reuse it.

```bash
npx playwright codegen --save-storage=auth.json https://your-app.example.com
# log in in the window that opens, then close it

npm run cli -- analyze --url https://your-app.example.com/home --storage-state ./auth.json
```

Rules:

- **`auth.json` contains live session cookies.** Treat it like a password: keep it out of git (add it to `.gitignore`), do not paste it into chats or tickets, and delete it when you are done.
- Do not put credentials on the command line or in scripts you commit. Use your CI system's secret store.
- Some applications expire sessions within minutes. If a run lands on the login page (page title starts with "Login"), log in again and re-save the session just before running.
- Use a **test account** with the minimum rights you need, not a personal or administrator account you rely on.

## 9. Applications that need an action first

Elements that appear only after an action (an opened dialog, an expanded row, a menu, a second tab of a form) are not in the page until you create them. The command line loads the page and analyzes what is there.

So for those states, use the **extension**: perform the action, then run **Pick element** or **Analyze page**. Do this once per state and generate a page object (or a component class) per state.

Elements that exist in the page but are **hidden** (closed dialogs, collapsed panels) usually cannot be verified by role or name, because Playwright ignores hidden elements for those. They show up as `// TODO` in a page object. Open the dialog first and re-run.

## 10. Reading the results

Badges (shown on every locator):

| Badge | Meaning | Action |
|---|---|---|
| `✓ 1` | Exactly one match and it is the right element | Safe to use |
| `⚠ n` | n matches | Use the scoped locator, or ask for an id/test id |
| `✗ 0` | No match on this page | The element may be hidden or generated later |
| `✗ wrong` | Matches something else | Do not use |
| `–` | Could not be checked here | Try it by hand |

Scores:

| Score | Colour in the UI | Read it as |
|---|---|---|
| 80 to 100 | Green | Stable: test id, role with a name, label, unique id. 85 is a sensible CI target |
| 55 to 79 | Amber | Reasonable but check what it depends on (visible text can change with wording or language) |
| Below 55 | Red | Fragile: position-based, long chains or not unique. Do not rely on it |

Locator kinds you will see:

- **`getByRole`, `getByLabel`, `getByTestId`, `getByText`**: Playwright's recommended user-facing locators.
- **Scoped** (`locator('tr').filter({ hasText: ... }).getByRole(...)`): the element is found inside a distinguishing container. It keeps working when rows are added or reordered, as long as the row text stays.
- **Shadow-piercing chains** (`my-card >> button`): the element sits inside web components. These work, but they depend on component names, so they are only as stable as those names.
- **Framework**: the `Framework` column tells you where to use a locator. Playwright ones go after `page.`; the CSS ones follow `querySelectorAll` rules, which do **not** look inside shadow roots, whereas Playwright's `page.locator()` does. A CSS locator can therefore be right for Playwright and not for Selenium. For Selenium or WebdriverIO against shadow DOM, prefer the JavaScript chain or the WebdriverIO deep selector provided.

## 11. Getting better scores: what to ask developers for

The tool can only choose among what the page offers. The largest single improvement is **stable test hooks** on interactive elements.

Ask for:

1. A **`data-testid`** (or your team's equivalent attribute) on buttons, inputs, links, dialog containers, menu items and the container of each repeated item (row, card).
2. **Accessible names**: a visible label, `aria-label`, or `<label for>` on every input and icon-only button. This helps tests and screen-reader users.
3. **Stable ids**, not generated ones (`mat-input-4`, hashes). Generated ids are penalized.
4. For **web components**, put the test id on the element inside the component that tests interact with, not only on the component host.
5. A **distinguishing attribute on repeated items** (a record id on each row) so scoped locators do not depend on display text.

Use the audit from [Recipe C](#6-recipe-c-audit-how-testable-a-screen-is) to back the request with numbers: "On this screen, 45% of the best locators score below 85."

## 12. Worked example: a web-component application

This is a real run on a large enterprise single-page application built from web components (about 6,300 elements and 1,300 shadow roots on one screen, no test ids). The numbers show what to expect on a similar application.

| Result (400 interactive elements analyzed) | Value |
|---|---|
| Recommended locators scoring 85 or more | 218 (55%) |
| Elements that would fail a CI gate at 85 | 182 (45%) |
| Page object properties generated | 287 |
| Properties verified to match exactly one element | 264 |
| Properties flagged `// TODO` | 23 |
| Analysis time in the extension | about 13 seconds |

What the 23 flagged properties were: roughly half were controls in dialogs that were closed at analysis time (Playwright cannot match hidden elements by role), and the rest were repeated elements, such as table rows and checkboxes, with nothing to tell the copies apart.

Lessons that apply to your application:

- **Open the dialog before analyzing**, or accept `// TODO` for what is hidden.
- **Repeated elements need a hook.** Without a record id or distinguishing text, there is no stable locator to find.
- **Use the extension** if the application will not finish loading in an automated browser (see the next sections).
- All 264 verified properties were independently re-checked with real Playwright and each resolved to exactly one element, so none of the verified ones was wrong. Every property that failed that check was one the tool had already marked `// TODO`.

## 13. Known limits

- **Closed shadow roots and cross-origin iframes cannot be inspected.**
- **Applications that will not start in an automated browser.** Some applications detect automation (`navigator.webdriver`) and stall. The command line and web analyzer then see only a login page or a few elements. The **extension and native mode use your real browser** and are not affected. Do not try to disable the detection in tests unless the application owner agrees; if the application itself fails under test automation, tell the application team, because your Playwright tests will hit the same thing.
- **Hidden elements** are generally not verifiable by role or name (see [Section 9](#9-applications-that-need-an-action-first)).
- **Large pages are slow.** Analysis time grows with the number of elements and shadow roots. In the extension, 400 elements on a page with 1,300 shadow roots took about 13 seconds. Start with 100 elements.
- **Extension scope.** **Analyze page** covers the main document; **Pick element** also works inside same-origin iframes. Chrome and Edge only.
- **The score is a fixed rule set**, not a trained model, and not a guarantee that a locator survives the next release. Treat it as a strong hint.
- **The extension's matching closely follows Playwright** and is checked by automated parity tests, but may differ from Playwright in unusual cases. When it matters, paste the locator into a real Playwright test.

## 14. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| The command line reports a **login page** or a tiny page (for example 14 elements, 0 interactive) for a logged-in app | The session in `auth.json` expired, or the application does not start in an automated browser. Re-save the session and retry; if it persists, use the **extension** |
| The page never finishes loading in the command line | Same cause. Use the extension |
| `Chromium is not installed for Playwright` | Run `npx playwright install chromium` |
| `Requests to private or local network addresses are blocked` | The server was started beyond local-only, or the target is a private address. Run the server locally, or allow the target with `LA_ALLOWED_TARGETS` (Docker: see manual section 12) |
| The extension button shows a red `!` | The browser does not allow extensions on that page (for example `chrome://` pages) |
| The extension panel does not appear | Reload the page, check the extension is enabled, click the button again |
| A locator shows `⚠ n` | It matches several elements. Use the scoped locator, or generate a page object, which prefers unique ones |
| An element is missing | It may be in a closed shadow root or cross-origin iframe, or it only appears after an action. Perform the action in the browser, then analyze |
| The page object has `// TODO` | The locator could not be confirmed unique. Fix by hand, or open the dialog first and re-run |
| `EADDRINUSE` when starting the server | Port 3000 is taken. Set `PORT`, for example `PORT=3100 npm run start:api` |
| Native mode will not connect | Close all Chrome windows, start Chrome with `--remote-debugging-port=9222` and a separate `--user-data-dir`, then click Connect |

Found a problem or want a feature? Open an issue at <https://github.com/ssomisetty5e5/locator-agent/issues> with the page type (framework, whether it uses Shadow DOM), what you ran, and what you expected. **Do not attach screenshots or HTML containing real customer data or credentials.**

## 15. Data handling

- The tool runs **entirely on your machine**. The extension makes no network requests and sends nothing anywhere; it only asks for `activeTab` and `scripting`, and does nothing on a page until you click its button.
- The web analyzer and command line load the page you name using a local browser, and write results only where you tell them to.
- Analysis output can contain **text from the page** (labels, row values, names). If the screen shows real customer or personal data, treat the output, screenshots and generated page objects as containing that data. Use a test environment with test data where you can, and do not commit generated files that include real values.
- Only analyze applications and environments you are authorized to test.
- Follow Hyland's [AI Use Requirements](https://hyland.atlassian.net/wiki/spaces/OGC/pages/3407151959/AI+Use+Requirements) for any AI-assisted work around this tool. LocatorAgent itself does not call an AI model.

## 16. Cheat sheet

| Task | Do this |
|---|---|
| Locator for one element | Extension: **Alt+L** → **Pick element** → click → **Copy** |
| Locators for a whole screen | Extension: **Analyze page**; or `npm run cli -- analyze --url <url> --max 200` |
| Page object (TypeScript) | `npm run cli -- page-object --url <url> -n MyPage -o MyPage.ts` |
| Page object (Python / Java) | add `-l python` or `-l java --package <pkg>` |
| Fail the build below a score | add `--fail-below 70` (exit code 2 on failure) |
| Logged-in page | `npx playwright codegen --save-storage=auth.json <url>`, then `--storage-state auth.json` |
| App needs a click first | Click in your browser, then use the extension |
| App won't load in automation | Use the extension or native mode |
| Share the extension | `npm run package:extension`, send the zip |
| Start the local web analyzer | `npm run start:api`, open <http://localhost:3000> |
