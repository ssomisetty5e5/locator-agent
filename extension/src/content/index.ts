// ============================================================
// Content script entry
// Injected on demand by the background worker. The first run builds the
// panel; running it again (toolbar click or Alt+L) shows or hides it.
// ============================================================

import { Panel } from './panel';

const w = window as Window & { __locatorAgentPanel?: Panel };

if (w.__locatorAgentPanel) {
  w.__locatorAgentPanel.toggle();
} else {
  w.__locatorAgentPanel = new Panel();
  w.__locatorAgentPanel.show();
}
