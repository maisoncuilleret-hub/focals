(() => {
  // Prevent double injection
  if (window.__FOCALS_MESSAGING_LOADED__) return;
  window.__FOCALS_MESSAGING_LOADED__ = true;

  console.log("[Focals][MSG] content-messaging.js loaded");

  try {
    const host = window.location.hostname || "";
    if (!host.includes("linkedin.com")) {
      console.log("[Focals][MSG] Not on LinkedIn, messaging script does nothing");
      return;
    }

    const EDITOR_SELECTOR = "div.msg-form__contenteditable";
    const CONTAINER_SELECTOR = ".msg-form__msg-content-container--scrollable";
    const BUTTON_CLASS = "focals-suggest-reply-button";

    const injectButtons = () => {
      console.log("[Focals][MSG] initMessagingFeatures start");

      let editors = [];
      try {
        editors = Array.from(document.querySelectorAll(EDITOR_SELECTOR));
      } catch (e) {
        console.warn("[Focals][MSG] Error while querying editors", e);
      }

      console.log(`[Focals][MSG] editors found: ${editors.length}`);

      editors.forEach((editor) => {
        const container = editor.closest(CONTAINER_SELECTOR) || editor.parentElement;
        if (!container) {
          console.log("[Focals][MSG] No container found for editor; skipping button injection");
          return;
        }

        if (container.querySelector(`.${BUTTON_CLASS}`)) {
          console.log("[Focals][MSG] Suggest reply button already present; skipping");
          return;
        }

        const button = document.createElement("button");
        button.className = BUTTON_CLASS;
        button.type = "button";
        button.textContent = "Suggest reply";
        button.style.display = "inline-block";
        button.style.marginTop = "4px";
        button.style.marginLeft = "4px";
        button.style.padding = "4px 8px";
        button.style.borderRadius = "6px";
        button.style.border = "1px solid #0a66c2";
        button.style.background = "#e8f3ff";
        button.style.color = "#0a66c2";
        button.style.cursor = "pointer";
        button.style.fontSize = "12px";

        button.addEventListener("click", () => {
          console.log("[Focals][MSG] Suggest reply button clicked");
        });

        container.appendChild(button);
        console.log("[Focals][MSG] Suggest reply button injected");
      });
    };

    const start = () => {
      injectButtons();
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
    console.error("[Focals][MSG] Fatal error in content-messaging.js", e);
  }
})();
