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

  try {
    if (window !== window.top) {
      console.log("[Focals][MSG] Not in top window, exiting messaging script");
      return;
    }

    const EDITOR_SELECTOR = "div.msg-form__contenteditable";
    const BUTTON_CLASS = "focals-suggest-reply-button";
    const LOG_PREFIX = "[Focals][MSG]";
    const FOCALS_GENERATE_REPLY_URL =
      "https://ppawceknsedxaejpeylu.supabase.co/functions/v1/generate-reply";

    const normalizeText = (text = "") => text.replace(/\s+/g, " ").trim();

    const log = (message, ...args) => {
      console.log(`${LOG_PREFIX} ${message}`, ...args);
    };

    const warn = (message, ...args) => {
      console.warn(`${LOG_PREFIX} ${message}`, ...args);
    };

    const error = (message, ...args) => {
      console.error(`${LOG_PREFIX} ${message}`, ...args);
    };

    const extractLinkedInMessages = () => {
      const messageNodes = Array.from(
        document.querySelectorAll(
          'div.msg-s-event-listitem[data-view-name="message-list-item"]'
        )
      );

      log(`[SCRAPE] Found ${messageNodes.length} message items (msg-s-event-listitem)`);

      const allMessages = [];

      messageNodes.forEach((container) => {
        const body = container.querySelector("p.msg-s-event-listitem__body");
        const text = normalizeText(body?.innerText || "");

        if (!text) {
          log("[SCRAPE] No body text for this message, skipping");
          return;
        }

        const fromMe = !container.classList.contains("msg-s-event-listitem--other");
        log(`[SCRAPE] Message role resolved: fromMe = ${fromMe}`);

        let timestampRaw = "";
        const titleNode = container.querySelector(
          "span.msg-s-event-with-indicator__sending-indicator[title]"
        );
        if (titleNode?.getAttribute("title")) {
          timestampRaw = titleNode.getAttribute("title") || "";
          log(`[SCRAPE] Timestamp title found: "${timestampRaw}"`);
        }

        if (!timestampRaw) {
          const fallbackTime = container.querySelector("time.msg-s-message-group__timestamp");
          const fallbackText = normalizeText(fallbackTime?.innerText || "");
          if (fallbackText) {
            timestampRaw = fallbackText;
            log(`[SCRAPE] Using fallback timestamp from <time>: "${timestampRaw}"`);
          }
        }

        const message = {
          text,
          fromMe,
          timestampRaw,
        };

        log("[SCRAPE] Built message object:", {
          fromMe,
          length: text.length,
          timestampRaw,
        });

        allMessages.push(message);
      });

      if (!allMessages.length) {
        warn("[SCRAPE] No messages found after parsing");
      }

      const recentMessages = allMessages.slice(-3);
      if (allMessages.length > 3) {
        log(`[SCRAPE] Using last 3 messages out of ${allMessages.length}`);
      }

      return recentMessages;
    };

    const generateReplyFromAPI = async (messages) => {
      if (!messages?.length) {
        warn("PIPELINE extract_messages: no messages found, aborting");
        return null;
      }

      log(`PIPELINE api_call: about to call generate-reply`);
      log(`PIPELINE api_call: start (${messages.length} messages)`);

      const payload = {
        messages,
        context: {
          language: "fr",
          tone: "friendly",
          role: "candidate",
        },
      };

      let response;
      try {
        response = await fetch(FOCALS_GENERATE_REPLY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        error(`PIPELINE api_call: network failure`, err);
        throw err;
      }

      log(`PIPELINE api_call: response status = ${response.status}`);

      let data = null;
      if (!response.ok) {
        try {
          data = await response.json();
        } catch (parseErr) {
          data = null;
        }
        error(`PIPELINE api_call: error response`, {
          status: response.status,
          body: data,
        });
        return null;
      }

      try {
        data = await response.json();
      } catch (parseErr) {
        error(`PIPELINE api_call: failed to parse JSON`, parseErr);
        return null;
      }

      const replyPresent = !!data?.reply;
      log(`PIPELINE api_call: reply present = ${replyPresent}`);

      return data?.reply || null;
    };

    const insertReplyIntoMessageInput = (replyText) => {
      log(`PIPELINE insert_reply: start`);
      const inputSelectors = [
        ".msg-form__contenteditable",
        "[data-test-message-input]",
        '.msg-form__message-texteditor [contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
      ];

      let inputField = null;
      for (const selector of inputSelectors) {
        inputField = document.querySelector(selector);
        if (inputField) break;
      }

      if (!inputField) {
        error(`PIPELINE insert_reply: failed, reason = editor not found`);
        alert("❌ Impossible de trouver le champ de réponse LinkedIn.");
        return false;
      }

      inputField.focus();
      inputField.innerHTML = "";

      document.execCommand("insertText", false, replyText);

      if (!inputField.innerText || !inputField.innerText.trim()) {
        inputField.innerText = replyText;
        inputField.dispatchEvent(new Event("input", { bubbles: true }));
        inputField.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(inputField);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);

      log(`PIPELINE insert_reply: success = true`);
      return true;
    };

    const runSuggestReplyPipeline = async () => {
      try {
        log("Suggest reply button clicked");

        log(`PIPELINE extract_messages: start`);
        const messages = extractLinkedInMessages();
        log(`PIPELINE extract_messages: done, count = ${messages.length}`);

        if (!messages.length) {
          warn(`PIPELINE extract_messages: no messages found, aborting`);
          alert("❌ Aucun message détecté dans la conversation.");
          return;
        }

        const reply = await generateReplyFromAPI(messages);
        if (!reply) {
          warn(`PIPELINE api_call: reply missing, aborting`);
          alert("❌ Impossible de générer une réponse pour le moment.");
          return;
        }

        const inserted = insertReplyIntoMessageInput(reply);
        log(`PIPELINE insert_reply: success = ${inserted}`);
      } catch (err) {
        error(`PIPELINE_ERROR ${err?.message || err}`);
        alert(`❌ Une erreur est survenue : ${err?.message || err}`);
      }
    };

    const scanAndInject = () => {
      const editors = Array.from(document.querySelectorAll(EDITOR_SELECTOR));
      console.log(`[Focals][MSG] scanAndInject: editors.length = ${editors.length}`);

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
          runSuggestReplyPipeline();
        });

        rightActions.appendChild(button);
        console.log("[Focals][MSG] Suggest reply button injected", {
          href: window.location.href,
        });
      });
    };

    const initMessagingWatcher = () => {
      scanAndInject();

      const startObserver = () => {
        const observer = new MutationObserver(() => {
          scanAndInject();
        });

        observer.observe(document.body, { childList: true, subtree: true });
      };

      if (document.body) {
        startObserver();
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          scanAndInject();
          startObserver();
        });
      }

      setInterval(scanAndInject, 1000);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initMessagingWatcher);
    } else {
      initMessagingWatcher();
    }
  } catch (error) {
    console.error("[Focals][MSG] Fatal error in content-messaging.js", error);
  }
})();
