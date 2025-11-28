(() => {
  // Prevent double injection
  if (window.__FOCALS_MESSAGING_LOADED__) return;
  window.__FOCALS_MESSAGING_LOADED__ = true;

  console.log("[Focals][MSG] content-messaging.js loaded on", window.location.href);

  try {
    const EDITOR_SELECTOR = "div.msg-form__contenteditable";
    const BUTTON_CLASS = "focals-suggest-reply-button";

    const injectButtons = () => {
      const editors = document.querySelectorAll(EDITOR_SELECTOR);

      if (!editors || editors.length === 0) {
        console.log("[Focals][MSG] No messaging editors found on this page, exiting");
        return;
      }

      console.log(`[Focals][MSG] Editors found: ${editors.length}`);

      editors.forEach((editor) => {
        const container =
          editor.closest(".msg-form__msg-content-container--scrollable") ||
          editor.parentElement ||
          editor;

        if (!container) {
          console.warn("[Focals][MSG] Unable to resolve container for editor, skipping");
          return;
        }

        if (container.querySelector(`.${BUTTON_CLASS}`)) {
          return;
        }

        const button = document.createElement("button");
        button.className = BUTTON_CLASS;
        button.textContent = "Suggest reply";
        button.style.marginLeft = "8px";
        button.style.padding = "6px 10px";
        button.style.borderRadius = "4px";
        button.style.border = "1px solid #0a66c2";
        button.style.background = "#0a66c2";
        button.style.color = "#fff";
        button.style.cursor = "pointer";

        button.addEventListener("click", () => {
          try {
            console.log("[Focals][MSG] Suggest reply button clicked");
          } catch (error) {
            console.error("[Focals][MSG] Error handling suggest reply click", error);
          }
        });

        container.appendChild(button);
        console.log("[Focals][MSG] Suggest reply button injected for one editor", {
          href: window.location.href,
        });
      });
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", injectButtons);
    } else {
      injectButtons();
    }
  } catch (error) {
    console.error("[Focals][MSG] Fatal error in content-messaging.js", error);
  }
})();
