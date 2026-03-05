const EXTENSION_ENABLED_KEY = "extensionEnabled";

const extensionEnabledEl = document.getElementById("extensionEnabled");

function reloadTimelineTabs() {
  chrome.tabs.query(
    {
      url: ["https://x.com/*", "https://twitter.com/*"]
    },
    (tabs) => {
      for (const tab of tabs || []) {
        if (typeof tab.id !== "number") continue;
        chrome.tabs.reload(tab.id);
      }
    }
  );
}

chrome.storage.sync.get({ [EXTENSION_ENABLED_KEY]: true }, (items) => {
  extensionEnabledEl.checked = Boolean(items[EXTENSION_ENABLED_KEY]);
});

extensionEnabledEl.addEventListener("change", () => {
  chrome.storage.sync.set({ [EXTENSION_ENABLED_KEY]: extensionEnabledEl.checked }, () => {
    reloadTimelineTabs();
  });
});
