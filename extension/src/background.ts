// ============================================================
// Background service worker
// Clicking the toolbar button (or pressing Alt+L) injects the panel into
// the current tab. Nothing runs on a page until the user asks: the
// extension only holds the "activeTab" permission for that one tab.
// ============================================================

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  try {
    // Injecting again simply shows or hides the panel that is already there
    await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] });
  } catch {
    // Browser pages (chrome://, the Web Store) and PDF viewers can't be scripted
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: "LocatorAgent can't run on this page" });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
      chrome.action.setTitle({ tabId, title: 'LocatorAgent (Alt+L)' }).catch(() => undefined);
    }, 4000);
  }
});
