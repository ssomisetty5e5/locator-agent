// The few chrome.* APIs the extension uses (keeps the project free of @types/chrome).
declare const chrome: {
  action: {
    onClicked: { addListener(callback: (tab: { id?: number }) => void): void };
    setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
    setTitle(details: { tabId?: number; title: string }): Promise<void>;
  };
  scripting: {
    executeScript(injection: { target: { tabId: number; allFrames?: boolean }; files: string[] }): Promise<unknown>;
  };
};
