(() => {
  // Empêche les doubles injections
  if (window.__FOCALS_MESSAGING_LOADED__) return;
  window.__FOCALS_MESSAGING_LOADED__ = true;

  console.log("[Focals] content-messaging.js loaded");
  console.log("[Focals] location:", window.location.href);

  try {
    const host = window.location.hostname || "";
    if (!host.includes("linkedin.com")) {
      console.log("[Focals] Not on LinkedIn, messaging script does nothing");
      return;
    }

    const EDITOR_SELECTOR = "div.msg-form__contenteditable";
    const EDITOR_CONTAINER_SELECTOR = ".msg-form__msg-content-container--scrollable";
    const MESSAGE_SELECTOR = "div.msg-s-message-list__event";
    const SELF_CLASS = "msg-s-message-list__event--self";
    const SEND_BUTTON_SELECTORS = [
      "button.msg-form__send-button",
      'button[aria-label="Send"]',
      'button[data-control-name="send"]',
    ];
    const SUGGEST_BUTTON_CLASS = "focals-suggest-reply-button";

    const getEditors = () => Array.from(document.querySelectorAll(EDITOR_SELECTOR));

    const getComposer = (editor) => {
      if (!editor) return null;
      return editor.closest(".msg-form") || editor.closest("form") || editor.parentElement;
    };

    const getConversationRoot = (composer) => {
      if (!composer) return null;
      return (
        composer.closest(".msg-overlay-conversation-bubble") ||
        composer.closest(".msg-conversation-container") ||
        composer.closest(".msg-s-message-list-container") ||
        composer
      );
    };

    const findSendButton = (composer) => {
      if (!composer) return null;
      for (const selector of SEND_BUTTON_SELECTORS) {
        const candidate = composer.querySelector(selector);
        if (candidate) return candidate;
      }
      return null;
    };

    const collectMessages = (conversationRoot) => {
      const scope = conversationRoot || document;
      const nodes = scope.querySelectorAll(MESSAGE_SELECTOR);
      return Array.from(nodes).map((node) => ({
        text: (node.innerText || "").trim(),
        fromMe: node.classList.contains(SELF_CLASS),
        timestamp: Date.now(),
      }));
    };

    const getLastReceivedMessage = (conversationRoot) => {
      const scope = conversationRoot || document;
      const nodes = Array.from(scope.querySelectorAll(MESSAGE_SELECTOR));
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i];
        if (!node.classList.contains(SELF_CLASS)) {
          const text = (node.innerText || "").trim();
          if (text) return text;
        }
      }
      return "";
    };

    const focusEditor = (editor) => {
      if (!editor) return;
      editor.focus();
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    const getToolbarContainer = (composer) => {
      if (!composer) return null;
      const toolbarCandidate =
        composer.querySelector('[role="toolbar"]') || composer.querySelector('.msg-form__footer');
      if (toolbarCandidate) return toolbarCandidate;

      const emojiButton = composer.querySelector('button[aria-label*="émo"]');
      if (emojiButton && emojiButton.parentElement) {
        const listItem = emojiButton.closest('li, div');
        if (listItem && listItem.parentElement) return listItem.parentElement;
        return emojiButton.parentElement;
      }

      const attachButton = composer.querySelector('button[aria-label*="Joindre"]');
      if (attachButton && attachButton.parentElement) {
        const listItem = attachButton.closest('li, div');
        if (listItem && listItem.parentElement) return listItem.parentElement;
        return attachButton.parentElement;
      }

      return null;
    };

    const handleSuggestClick = (composer) => {
      if (!composer) return;

      const editor = composer.querySelector(EDITOR_SELECTOR);
      if (!editor) {
        console.warn("[Focals] Message editor not found");
        return;
      }

      const conversationRoot = getConversationRoot(composer);
      const lastMessage = getLastReceivedMessage(conversationRoot);
      if (!lastMessage) {
        console.warn("[Focals] No received message found to base the suggestion on");
        return;
      }

      chrome.runtime.sendMessage(
        { type: "GENERATE_REPLY", lastMessage },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn("[Focals] Suggest reply request failed", chrome.runtime.lastError);
            return;
          }

          const reply = response?.reply || "";
          if (!reply) {
            console.warn("[Focals] No reply returned by the API");
            return;
          }

          editor.innerText = reply;
          focusEditor(editor);
        }
      );
    };

    const injectSuggestButton = (composer) => {
      if (!composer) {
        console.warn("[Focals] Unable to locate LinkedIn composer to inject the button");
        return;
      }

      const editor = composer.querySelector(EDITOR_SELECTOR);
      if (!editor) {
        console.warn("[Focals] No editor found under composer, skip button injection");
        return;
      }

      const container =
        getToolbarContainer(composer) ||
        editor.closest(EDITOR_CONTAINER_SELECTOR) ||
        editor.parentElement ||
        composer;

      if (!container) {
        console.warn("[Focals] No valid container found for suggest button");
        return;
      }

      if (container.querySelector(`.${SUGGEST_BUTTON_CLASS}`)) {
        console.log("[Focals] Suggest button already present in container");
        return;
      }

      const button = document.createElement("button");
      button.className = SUGGEST_BUTTON_CLASS;
      button.type = "button";
      button.textContent = "Suggest reply";
      button.style.display = "inline-flex";
      button.style.alignItems = "center";
      button.style.gap = "4px";
      button.style.marginTop = "4px";
      button.style.marginLeft = "4px";
      button.style.padding = "6px 10px";
      button.style.borderRadius = "6px";
      button.style.border = "1px solid #0a66c2";
      button.style.background = "#e8f3ff";
      button.style.color = "#0a66c2";
      button.style.cursor = "pointer";
      button.style.fontSize = "12px";
      button.style.fontWeight = "600";

      button.addEventListener("click", () => handleSuggestClick(composer));

      container.appendChild(button);
      console.log("[Focals] Injected suggest button into composer container");
    };

    const handleSendClick = (composer) => {
      setTimeout(() => {
        const conversationRoot = getConversationRoot(composer);
        const messages = collectMessages(conversationRoot);
        if (!messages.length) {
          console.warn("[Focals] No messages to sync after send");
          return;
        }

        chrome.runtime.sendMessage(
          {
            type: "SYNC_CONVERSATION",
            url: window.location.href,
            messages,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn("[Focals] Conversation sync failed", chrome.runtime.lastError);
              return;
            }
            if (response?.ok) {
              console.log("[Focals] Conversation synced successfully");
            } else {
              console.warn("[Focals] Conversation sync unsuccessful", response);
            }
          }
        );
      }, 500);
    };

    const setupSendListener = () => {
      const editors = getEditors();
      editors.forEach((editor) => {
        const composer = getComposer(editor);
        if (!composer) {
          console.warn("[Focals] Composer not found for editor while setting send listener");
          return;
        }
        const sendButton = findSendButton(composer);
        if (!sendButton) {
          console.warn("[Focals] Send button not found for composer");
          return;
        }
        if (sendButton.__focalsSendListenerAttached) return;
        sendButton.__focalsSendListenerAttached = true;
        sendButton.addEventListener("click", () => handleSendClick(composer));
      });
    };

    const initMessagingFeatures = () => {
      const editors = getEditors();
      console.log(`[Focals] initMessagingFeatures found ${editors.length} editors`);
      if (!editors.length) return;

      editors.forEach((editor) => {
        const composer = getComposer(editor);
        if (!composer) {
          console.warn("[Focals] Composer not found for editor during initialization");
          return;
        }
        injectSuggestButton(composer);
      });

      setupSendListener();
    };

    const startComposerWatcher = () => {
      initMessagingFeatures();

      const observer = new MutationObserver(() => {
        initMessagingFeatures();
      });

      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startComposerWatcher);
    } else {
      startComposerWatcher();
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "FORCE_SCAN_MESSAGES") {
        sendResponse({ ok: true });
      }
    });
  } catch (e) {
    console.error("[Focals] messaging STEP 1 - fatal error", e);
  }
})();
