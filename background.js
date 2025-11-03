console.log("[Focals] background.js service worker started");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SCRAPE_PUBLIC_PROFILE" && msg.url) {
    (async () => {
      try {
        console.log("[Focals] Opening public profile:", msg.url);
        const tab = await chrome.tabs.create({ url: msg.url, active: false });

        // attendre que l’onglet soit complètement chargé
        await waitForComplete(tab.id);

        // demander les données au content script
        const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_CANDIDATE_DATA" });
        console.log("[Focals] Data received:", res);

        // fermer l’onglet une fois terminé
        await chrome.tabs.remove(tab.id);

        sendResponse(res || { error: "No response from content script" });
      } catch (e) {
        console.error("[Focals] Error during scrape:", e);
        sendResponse({ error: e?.message || "SCRAPE_PUBLIC_PROFILE failed" });
      }
    })();

    return true; // indique un traitement asynchrone
  }
});

// utilitaire pour attendre que l’onglet soit chargé
function waitForComplete(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
