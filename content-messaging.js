(() => {
  if (window.__FOCALS_MESSAGING_LOADED__) return;
  window.__FOCALS_MESSAGING_LOADED__ = true;

  console.log("[Focals] content-messaging.js loaded");

  // LinkedIn-specific selectors (may need adjustment if the UI changes)
  const EDITOR_SELECTOR = "div.msg-form__contenteditable";
  const TOOLBAR_SELECTOR = ".msg-form__footer";
  const MESSAGE_SELECTOR = "div.msg-s-message-list__event";
  const SELF_CLASS = "msg-s-message-list__event--self";
  const SEND_BUTTON_SELECTORS = [
    "button.msg-form__send-button",
    'button[aria-label="Send"]',
    'button[data-control-name="send"]',
  ];

  const SUGGEST_BUTTON_ID = "focals-suggest-reply-button";

  const getEditor = () => document.querySelector(EDITOR_SELECTOR);

  const getComposer = () => {
    const editor = getEditor();
    if (!editor) return null;
    return editor.closest(".msg-form") || editor.closest("form") || editor.parentElement;
  };

  const findSendButton = () => {
    const composer = getComposer();
    if (!composer) return null;
    for (const selector of SEND_BUTTON_SELECTORS) {
      const candidate = composer.querySelector(selector);
      if (candidate) return candidate;
    }
    return null;
  };

  const collectMessages = () => {
    const nodes = document.querySelectorAll(MESSAGE_SELECTOR);
    return Array.from(nodes).map((node) => ({
      text: (node.innerText || "").trim(),
      fromMe: node.classList.contains(SELF_CLASS),
      timestamp: Date.now(),
    }));
  };

  const getLastReceivedMessage = () => {
    const nodes = Array.from(document.querySelectorAll(MESSAGE_SELECTOR));
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

  const handleSuggestClick = () => {
    const editor = getEditor();
    if (!editor) {
      console.warn("[Focals] Message editor not found");
      return;
    }

    const lastMessage = getLastReceivedMessage();
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

  const injectSuggestButton = () => {
    if (document.getElementById(SUGGEST_BUTTON_ID)) return;

    const composer = getComposer();
    if (!composer) {
      console.warn("[Focals] Unable to locate LinkedIn composer to inject the button");
      return;
    }

    const toolbar = composer.querySelector(TOOLBAR_SELECTOR) || composer;
    const button = document.createElement("button");
    button.id = SUGGEST_BUTTON_ID;
    button.type = "button";
    button.textContent = "Suggest reply";
    button.style.marginLeft = "8px";
    button.style.padding = "6px 10px";
    button.style.borderRadius = "6px";
    button.style.border = "1px solid #0a66c2";
    button.style.background = "#e8f3ff";
    button.style.color = "#0a66c2";
    button.style.cursor = "pointer";
    button.style.fontSize = "14px";
    button.addEventListener("click", handleSuggestClick);

    toolbar.appendChild(button);
  };

  const handleSendClick = () => {
    setTimeout(() => {
      const messages = collectMessages();
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
    const sendButton = findSendButton();
    if (!sendButton) return;
    if (sendButton.__focalsSendListenerAttached) return;
    sendButton.__focalsSendListenerAttached = true;
    sendButton.addEventListener("click", handleSendClick);
  };

  const initMessagingFeatures = () => {
    const editor = getEditor();
    if (!editor) return;
    injectSuggestButton();
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
      sendResponse({ success: false, disabled: true });
      return true;
    }
    return false;
  });
})();
