(() => {
  // Prevent double injection
  if (window.__FOCALS_MESSAGING_LOADED__) return;
  window.__FOCALS_MESSAGING_LOADED__ = true;

  console.log(
    "[Focals][MSG] content-messaging.js loaded on",
    window.location.href,
    "isTop:",
    window === window.top
  );

  if (window !== window.top) {
    console.log("[Focals][MSG] Not in top window, exiting messaging script");
    return;
  }

  try {
    const EDITOR_SELECTOR = "div.msg-form__contenteditable";
    const BUTTON_CLASS = "focals-suggest-reply-button";

    const injectButtons = () => {
      const editors = Array.from(document.querySelectorAll(EDITOR_SELECTOR));
      console.log("[Focals][MSG] Editors found in top frame:", editors.length);

      if (editors.length === 0) {
        console.log("[Focals][MSG] No messaging editors found on this page, exiting");
        return;
      }

      editors.forEach((editor) => {
        const composer = editor.closest(".msg-form");
        if (!composer) {
          console.warn("[Focals][MSG] Unable to resolve composer for editor, skipping");
          return;
        }

        const footer = composer.querySelector("footer.msg-form__footer");
        if (!footer) {
          console.warn("[Focals][MSG] Missing footer in composer, skipping");
          return;
        }

        const rightActions = footer.querySelector(".msg-form__right-actions");
        if (!rightActions) {
          console.warn("[Focals][MSG] Missing right actions container, skipping");
          return;
        }

        if (rightActions.querySelector(`.${BUTTON_CLASS}`)) {
          return;
        }

        const button = document.createElement("button");
        button.className = `${BUTTON_CLASS} artdeco-button artdeco-button--1`;
        button.textContent = "Suggest reply";
        button.style.marginLeft = "8px";
        button.style.padding = "6px 10px";
        button.style.cursor = "pointer";

        button.addEventListener("click", () => {
          try {
            console.log("[Focals][MSG] Suggest reply button clicked");
          } catch (error) {
            console.error("[Focals][MSG] Error handling suggest reply click", error);
          }
        });

        rightActions.appendChild(button);
        console.log("[Focals][MSG] Suggest reply button injected", {
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
