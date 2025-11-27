(() => {
  if (window.__FOCALS_MESSAGING_LOADED__) return;
  window.__FOCALS_MESSAGING_LOADED__ = true;

  console.log("[Focals] content-messaging.js loaded");

  // LinkedIn-specific selectors (may need adjustment if the UI changes)
  const EDITOR_SELECTOR = "div.msg-form__contenteditable";
  // The footer toolbar is not reliable for our button placement,
  // we will now anchor the button to the editor container instead.
  const TOOLBAR_SELECTOR = ".msg-form__footer";
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

  const handleSuggestClick = (composer) => {
    if (!composer) return;

    const editor = composer.querySelector(EDITOR_SELECTOR);
    if (!editor) {
      console.warn("[Focals] Message editor not found");
      return;
    }

    const lastMessage = getLastReceivedMessage(getConversationRoot(composer));
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

  /**
   * Inject the "Suggest reply" button for a given composer.
   * We anchor the button directly in the editor container, which matches
   * the structure you gave:
   *
   * <div class="msg-form__msg-content-container--scrollable scrollable relative">
   *   <div class="flex-grow-1 relative">
   *     <div class="msg-form__contenteditable ..."></div>
   *     <div class="msg-form__placeholder ..."></div>
   *   </div>
   * </div>
   */
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

    // Prefer the direct parent of the editor (flex-grow-1 relative) as container
    const container = editor.parentElement || composer;

    // Avoid adding multiple buttons to the same composer
    if (container.querySelector(`.${SUGGEST_BUTTON_CLASS}`)) return;

    // Make sure the container can host an absolutely positioned child
    const computed = window.getComputedStyle(container);
    if (computed.position === "static") {
      container.style.position = "relative";
    }

    const button = document.createElement("button");
    button.className = SUGGEST_BUTTON_CLASS;
    button.type = "button";
    button.textContent = "Suggest reply";

    // Styles: bottom right inside the editor container
    button.style.position = "absolute";
    button.style.right = "8px";
    button.style.bottom = "8px";
    button.style.zIndex = "10";
    button.style.padding = "4px 8px";
    button.style.borderRadius = "6px";
    button.style.border = "1px solid #0a66c2";
    button.style.background = "#e8f3ff";
    button.style.color = "#0a66c2";
    button.style.cursor = "pointer";
    button.style.fontSize = "12px";
    button.style.lineHeight = "1.2";

    button.addEventListener("click", () => handleSuggestClick(composer));

    container.appendChild(button);
  };

  const handleSendClick = (composer) => {
    setTimeout(() => {
      const messages = collectMessages(getConversationRoot(composer));
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
      if (!composer) return;
      const sendButton = findSendButton(composer);
      if (!sendButton || sendButton.__focalsSendListenerAttached) return;
      sendButton.__focalsSendListenerAttached = true;
      sendButton.addEventListener("click", () => handleSendClick(composer));
    });
  };

  const initMessagingFeatures = () => {
    const editors = getEditors();
    if (!editors.length) return;

    editors.forEach((editor) => {
      const composer = getComposer(editor);
      if (!composer) return;
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

  // Respond to legacy scan requests without triggering automatic sync
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "FORCE_SCAN_MESSAGES") {
      // Removed: previous automatic sync on incoming messages (no longer needed)
      sendResponse({ ok: true });
    }
  });
})();
