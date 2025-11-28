(() => {
  // Prevent double injection
  if (window.__FOCALS_MESSAGING_LOADED__) return;
  window.__FOCALS_MESSAGING_LOADED__ = true;

  console.log("[Focals] content-messaging.js loaded (STEP 1: read-only logger)");

  try {
    const host = window.location.hostname || "";
    if (!host.includes("linkedin.com")) {
      console.log("[Focals] Not on LinkedIn, messaging script does nothing");
      return;
    }

    const EDITOR_SELECTOR = "div.msg-form__contenteditable";

    const logEditors = () => {
      try {
        const editors = document.querySelectorAll(EDITOR_SELECTOR);
        console.log("[Focals] messaging STEP 1 - editors found:", editors.length);
      } catch (e) {
        console.warn("[Focals] messaging STEP 1 - error while querying editors", e);
      }
    };

    const start = () => {
      console.log("[Focals] messaging STEP 1 - init");
      logEditors();
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "FORCE_SCAN_MESSAGES") {
        sendResponse({ ok: true, step: 1 });
      }
    });
  } catch (e) {
    console.error("[Focals] messaging STEP 1 - fatal error", e);
  }
})();
