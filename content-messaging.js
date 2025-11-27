(() => {
  if (window.__FOCALS_MESSAGING_LOADED__) return;
  window.__FOCALS_MESSAGING_LOADED__ = true;

  console.log("[Focals] content-messaging.js loaded");

  // Configuration
  const SCAN_INTERVAL_MS = 30000; // Scanner toutes les 30 secondes
  const seenMessageIds = new Set(); // Éviter les doublons

  /**
   * Extraire les conversations avec messages non lus
   * Sélecteurs LinkedIn à adapter selon la structure actuelle du DOM
   */
  function extractUnreadConversations() {
    const conversations = [];

    // Sélecteurs pour la liste des conversations LinkedIn Messaging
    const conversationSelectors = [
      ".msg-conversation-listitem",
      ".msg-conversations-container__convo-item",
      '[data-control-name="conversation_item"]',
      ".msg-conversation-card",
    ];

    for (const selector of conversationSelectors) {
      const items = document.querySelectorAll(selector);
      if (items.length === 0) continue;

      items.forEach((item) => {
        // Détecter si non lu (badge, point rouge, ou style différent)
        const isUnread =
          item.querySelector(".msg-conversation-card__unread-count") ||
          item.querySelector(".notification-badge") ||
          item.classList.contains("msg-conversation-card--unread") ||
          item.querySelector('[data-test-unread-indicator]');

        if (!isUnread) return;

        // Extraire les infos de la conversation
        const nameEl = item.querySelector(
          ".msg-conversation-listitem__participant-names, " +
            ".msg-conversation-card__participant-names, " +
            ".msg-conversation-card__title"
        );
        const name = nameEl?.innerText?.trim() || "";

        // Extraire l'URL du profil LinkedIn
        const profileLink = item.querySelector('a[href*="/in/"]');
        const linkedinUrl = profileLink?.href || "";

        // Extraire l'aperçu du dernier message
        const snippetEl = item.querySelector(
          ".msg-conversation-card__message-snippet, " +
            ".msg-conversation-listitem__message-snippet"
        );
        const messageSnippet = snippetEl?.innerText?.trim() || "";

        // Extraire la photo de profil
        const photoEl = item.querySelector(
          "img.presence-entity__image, img.msg-facepile-grid__img"
        );
        const photoUrl = photoEl?.src || "";

        // Créer un ID unique pour éviter les doublons
        const conversationId =
          item.getAttribute("data-conversation-id") ||
          item.id ||
          `${name}-${Date.now()}`;

        if (name && !seenMessageIds.has(conversationId)) {
          conversations.push({
            conversationId,
            name,
            linkedinUrl: linkedinUrl
              ? new URL(linkedinUrl, window.location.origin).href
              : "",
            messageSnippet,
            photoUrl,
            detectedAt: new Date().toISOString(),
          });
          seenMessageIds.add(conversationId);
        }
      });

      if (conversations.length > 0) break;
    }

    return conversations;
  }

  /**
   * Envoyer les nouvelles conversations au background script
   */
  async function reportNewMessages(conversations) {
    if (conversations.length === 0) return;

    console.log(`[Focals] ${conversations.length} nouvelle(s) conversation(s) détectée(s)`);

    try {
      await chrome.runtime.sendMessage({
        type: "LINKEDIN_NEW_MESSAGES_DETECTED",
        conversations,
      });
    } catch (err) {
      console.error("[Focals] Erreur envoi messages:", err);
    }
  }

  /**
   * Scanner périodiquement les nouvelles conversations
   */
  function startScanning() {
    // Scan initial
    const initial = extractUnreadConversations();
    reportNewMessages(initial);

    // Scan périodique
    setInterval(() => {
      const newConversations = extractUnreadConversations();
      reportNewMessages(newConversations);
    }, SCAN_INTERVAL_MS);

    // Observer les mutations du DOM pour détecter les nouveaux messages en temps réel
    const observer = new MutationObserver((mutations) => {
      // Debounce pour éviter trop d'appels
      clearTimeout(window.__focals_mutation_timeout);
      window.__focals_mutation_timeout = setTimeout(() => {
        const newConversations = extractUnreadConversations();
        reportNewMessages(newConversations);
      }, 1000);
    });

    const messagingContainer = document.querySelector(
      ".msg-conversations-container, " + ".msg-thread, " + "#messaging"
    );

    if (messagingContainer) {
      observer.observe(messagingContainer, {
        childList: true,
        subtree: true,
      });
    }
  }

  // Attendre que le DOM soit prêt
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startScanning);
  } else {
    setTimeout(startScanning, 2000); // Délai pour le chargement JS de LinkedIn
  }

  // Répondre aux pings du background
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "FOCALS_PING") {
      sendResponse({ pong: true, script: "content-messaging" });
      return true;
    }

    if (msg.type === "FORCE_SCAN_MESSAGES") {
      seenMessageIds.clear(); // Reset pour forcer un nouveau scan
      const conversations = extractUnreadConversations();
      reportNewMessages(conversations);
      sendResponse({ success: true, count: conversations.length });
      return true;
    }
  });
})();
