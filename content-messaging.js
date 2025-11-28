(() => {
  // Empêche les doubles injections
  if (window.__FOCALS_MESSAGING_LOADED__) return;
  window.__FOCALS_MESSAGING_LOADED__ = true;

  console.log("[Focals] content-messaging.js loaded (STEP 1: read-only logger)");

  try {
    // On est parano : si jamais on est injecté ailleurs
    const host = window.location.hostname || "";
    if (!host.includes("linkedin.com")) {
      console.log("[Focals] Not on LinkedIn, messaging script does nothing");
      return;
    }

    const EDITOR_SELECTOR = "div.msg-form__contenteditable";

    const logEditors = () => {
      try {
        const editors = document.querySelectorAll(EDITOR_SELECTOR);
        console.log(
          "[Focals] messaging STEP 1 - editors found:",
          editors.length
        );
      } catch (e) {
        console.warn("[Focals] messaging STEP 1 - error while querying editors", e);
      }
    };

    const start = () => {
      console.log("[Focals] messaging STEP 1 - init");
      logEditors();
      // IMPORTANT : pour l'instant, pas de MutationObserver,
      // pas de listeners, pas de manip DOM.
      // On se contente d'un log au chargement.
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }

    // Handler legacy, mais neutre
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "FORCE_SCAN_MESSAGES") {
        // On ne fait rien d’autre que répondre OK
        sendResponse({ ok: true, step: 1 });
      }
    });
  } catch (e) {
    console.error("[Focals] messaging STEP 1 - fatal error", e);
  }
})();
